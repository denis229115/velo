import { createBackgroundChecker, type BackgroundChecker } from "../backgroundCheckers";
import { useUIStore } from "@/stores/uiStore";
import {
  getPendingOperations,
  updateOperationStatus,
  deleteOperation,
  incrementRetry,
  getPendingOpsCount,
  compactQueue,
} from "../db/pendingOperations";
import { withTransaction } from "../db/connection";
import { reportAuthExpired } from "../authNotice";
import { executeQueuedAction, rollbackQueuedRemoval } from "../emailActions";
import { classifyError } from "@/utils/networkErrors";

const BATCH_SIZE = 50;

let checker: BackgroundChecker | null = null;

async function processQueue(): Promise<void> {
  // Skip if offline
  if (!useUIStore.getState().isOnline) return;

  // Compact first to eliminate redundant ops
  await withTransaction(async () => { await compactQueue(); });

  // Get pending operations
  const ops = await getPendingOperations(undefined, BATCH_SIZE);
  if (ops.length === 0) {
    await updatePendingCount();
    return;
  }

  for (const op of ops) {
    try {
      // Mark as executing
      let claimed = false;
      await withTransaction(async (db) => {
        const result = await db.execute("UPDATE pending_operations SET status = 'executing' WHERE id = $1 AND status = 'pending'", [op.id]);
        claimed = result.rowsAffected === 1;
      });
      if (!claimed) continue;

      // Parse params and execute
      const params = JSON.parse(op.params) as Record<string, unknown>;
      await executeQueuedAction(op.account_id, op.operation_type, params);

      // Success — delete from queue
      await withTransaction(async () => { await deleteOperation(op.id); });
    } catch (err) {
      const classified = classifyError(err);

      if (classified.isRetryable) {
        // Increment retry with exponential backoff
        if (op.retry_count + 1 >= op.max_retries && JSON.parse(op.params).before) {
          await rollbackQueuedRemoval(op.account_id, JSON.parse(op.params), op.id, classified.message);
          window.dispatchEvent(new CustomEvent("velo-mail-action-error", { detail: "Email action retries exhausted. Local labels were restored; refresh the mailbox to check the server result." }));
        } else {
          await withTransaction(async () => {
            await incrementRetry(op.id);
            if (op.retry_count + 1 < op.max_retries) await updateOperationStatus(op.id, "pending", classified.message);
          });
        }
      } else {
        // Permanent failure
        const params = JSON.parse(op.params) as Record<string, unknown>;
        if (params.before) await rollbackQueuedRemoval(op.account_id, params, op.id, classified.message);
        else await withTransaction(async () => { await updateOperationStatus(op.id, "failed", classified.message); });
        window.dispatchEvent(new CustomEvent("velo-mail-action-error", { detail: `Email action failed: ${classified.message}.${params.before ? " The local change was restored." : ""}` }));
        if (classified.type === "auth") reportAuthExpired(op.account_id);
      }
    }
  }

  await updatePendingCount();
}

async function updatePendingCount(): Promise<void> {
  const count = await getPendingOpsCount();
  useUIStore.getState().setPendingOpsCount(count);
}

export function startQueueProcessor(): void {
  if (checker) return;
  checker = createBackgroundChecker("QueueProcessor", processQueue, 30_000);
  checker.start();
}

export function stopQueueProcessor(): void {
  checker?.stop();
  checker = null;
}

/**
 * Trigger an immediate queue flush (e.g., when coming back online).
 * Returns a promise that resolves when processing completes.
 */
export async function triggerQueueFlush(): Promise<void> {
  try {
    await processQueue();
  } catch (err) {
    console.error("[QueueProcessor] flush failed:", err);
  }
}
