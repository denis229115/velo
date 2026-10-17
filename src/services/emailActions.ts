import { useUIStore } from "@/stores/uiStore";
import { useThreadStore, type Thread } from "@/stores/threadStore";
import { getEmailProvider } from "@/services/email/providerFactory";
import { enqueuePendingOperation } from "@/services/db/pendingOperations";
import { classifyError } from "@/utils/networkErrors";
import { useAccountStore } from "@/stores/accountStore";
import { getDb, withTransaction } from "@/services/db/connection";
import { navigateToThread, getSelectedThreadId } from "@/router/navigate";
import { clearUndo, offerUndo } from "@/services/undoStack";
import { reportAuthExpired } from "@/services/authNotice";

// ---------------------------------------------------------------------------
// Action types
// ---------------------------------------------------------------------------

export type EmailAction =
  | { type: "archive"; threadId: string; messageIds: string[] }
  | { type: "trash"; threadId: string; messageIds: string[] }
  | { type: "permanentDelete"; threadId: string; messageIds: string[] }
  | {
      type: "markRead";
      threadId: string;
      messageIds: string[];
      read: boolean;
    }
  | {
      type: "star";
      threadId: string;
      messageIds: string[];
      starred: boolean;
    }
  | {
      type: "spam";
      threadId: string;
      messageIds: string[];
      isSpam: boolean;
    }
  | {
      type: "moveToFolder";
      threadId: string;
      messageIds: string[];
      folderPath: string;
      sourceLabelId?: string;
    }
  | { type: "addLabel"; threadId: string; labelId: string }
  | { type: "removeLabel"; threadId: string; labelId: string }
  | {
      type: "sendMessage";
      rawBase64Url: string;
      threadId?: string;
    }
  | {
      type: "createDraft";
      rawBase64Url: string;
      threadId?: string;
    }
  | {
      type: "updateDraft";
      draftId: string;
      rawBase64Url: string;
      threadId?: string;
    }
  | { type: "deleteDraft"; draftId: string };

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface ActionResult {
  success: boolean;
  queued?: boolean;
  error?: string;
  data?: unknown;
}

// ---------------------------------------------------------------------------
// Optimistic UI helpers
// ---------------------------------------------------------------------------

function getNextThreadId(currentId: string): string | null {
  // Only auto-advance if the removed thread is the one being viewed
  const selectedId = getSelectedThreadId();
  if (selectedId !== currentId) return null;
  const { threads } = useThreadStore.getState();
  const idx = threads.findIndex((t) => t.id === currentId);
  if (idx === -1) return null;
  // Prefer next thread, fall back to previous
  const next = threads[idx + 1];
  if (next) return next.id;
  const prev = threads[idx - 1];
  if (prev) return prev.id;
  return null;
}

function applyOptimisticUpdate(action: EmailAction): void {
  const store = useThreadStore.getState();
  switch (action.type) {
    case "archive":
    case "trash":
    case "permanentDelete":
    case "spam":
    case "moveToFolder": {
      const nextId = getNextThreadId(action.threadId);
      store.removeThread(action.threadId);
      if (nextId) {
        navigateToThread(nextId);
      }
      break;
    }
    case "markRead":
      store.updateThread(action.threadId, { isRead: action.read });
      break;
    case "star":
      store.updateThread(action.threadId, { isStarred: action.starred });
      break;
    case "addLabel":
    case "removeLabel":
    case "sendMessage":
    case "createDraft":
    case "updateDraft":
    case "deleteDraft":
      // No universal optimistic update for these
      break;
  }
}

interface RemovalSnapshot {
  thread: Thread;
  index: number;
}

const REMOVALS = new Set<EmailAction["type"]>(["archive", "trash", "spam", "moveToFolder"]);

function captureRemoval(action: EmailAction, accountId?: string): RemovalSnapshot | null {
  if (!("threadId" in action) || !REMOVALS.has(action.type)) return null;
  const threads = useThreadStore.getState().threads ?? [];
  const index = threads.findIndex((thread) => thread.id === action.threadId);
  const thread = threads[index];
  if (!thread || index < 0 || (accountId && thread.accountId !== accountId)) return null;
  return { thread: { ...thread, labelIds: [...(thread.labelIds ?? [])] }, index };
}

function restoreRemoval(snapshot: RemovalSnapshot | null): void {
  if (!snapshot) return;
  useThreadStore.getState().restoreThread?.(snapshot.thread, snapshot.index);
}

function undoLabel(action: EmailAction): string {
  switch (action.type) {
    case "archive": return "Archived";
    case "trash": return "Moved to trash";
    case "spam": return action.isSpam ? "Reported spam" : "Not spam";
    case "moveToFolder": return "Moved";
    case "addLabel": return "Labelled";
    case "removeLabel": return "Label removed";
    case "star": return action.starred ? "Starred" : "Unstarred";
    case "markRead": return action.read ? "Marked read" : "Marked unread";
    default: return "Updated";
  }
}

export const MAIL_UNDO_MS = 10_000;
interface DurableRemoval {
  labels: string[];
  touched: string[];
  thread: RemovalSnapshot | null;
}

async function restoreDurableRemoval(accountId: string, threadId: string, before: DurableRemoval): Promise<void> {
  const db = await getDb();
  for (const label of before.touched) {
    await db.execute("DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2 AND label_id = $3", [accountId, threadId, label]);
  }
  for (const label of before.labels.filter((label) => before.touched.includes(label))) {
    await db.execute("INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id) VALUES ($1, $2, $3)", [accountId, threadId, label]);
  }
}

function restoreVisibleRemoval(accountId: string, before: DurableRemoval): void {
  if (useAccountStore.getState().activeAccountId === accountId) restoreRemoval(before.thread);
  window.dispatchEvent(new Event("velo-sync-done"));
}

/** Hold provider dispatch until Undo expires. IMAP MOVE changes UIDs and cannot
 * safely be inverted using the old IDs. Cancelling the durable intent before
 * dispatch gives Gmail and IMAP the same honest, bounded Undo contract. */
async function executeReversibleRemoval(accountId: string, action: EmailAction): Promise<ActionResult> {
  if (!("threadId" in action) || !action.threadId) return { success: false, error: "Missing thread" };
  const threadId = action.threadId;
  const id = crypto.randomUUID();
  const deadline = Math.ceil((Date.now() + MAIL_UNDO_MS) / 1000);
  let before: DurableRemoval;
  try {
    await withTransaction(async (db) => {
      const pending = await db.select<{ id: string }[]>("SELECT id FROM pending_operations WHERE account_id = $1 AND resource_id = $2 AND status IN ('pending', 'executing')", [accountId, threadId]);
      if (pending.length) throw new Error("This thread already has a pending action. Wait for it to finish or Undo it first.");
      const labels = await db.select<{ label_id: string }[]>("SELECT label_id FROM thread_labels WHERE account_id = $1 AND thread_id = $2", [accountId, threadId]);
      const touched = action.type === "archive" ? ["INBOX"] : action.type === "trash" ? ["INBOX", "TRASH"] : action.type === "spam" ? ["INBOX", "SPAM"] : action.type === "moveToFolder" ? [action.sourceLabelId ?? "INBOX", action.folderPath] : [];
      before = { labels: labels.map((row) => row.label_id), touched, thread: captureRemoval(action, accountId) };
      const accounts = await db.select<{ provider: string }[]>("SELECT provider FROM accounts WHERE id = $1", [accountId]);
      let imapDestination: string | undefined;
      if (accounts[0]?.provider === "imap") {
        const folders = await db.select<{ id: string; imap_folder_path: string | null }[]>("SELECT id, imap_folder_path FROM labels WHERE account_id = $1", [accountId]);
        if (action.type === "moveToFolder") {
          const requested = action.folderPath;
          const destination = folders.find((folder) => folder.id === requested || folder.imap_folder_path === requested);
          if (!destination?.imap_folder_path) throw new Error("The destination IMAP folder is not synced. Refresh the mailbox first.");
          action = { ...action, folderPath: destination.imap_folder_path };
          imapDestination = destination.id;
        } else {
          imapDestination = action.type === "archive" ? "archive" : action.type === "trash" ? "TRASH" : action.type === "spam" && action.isSpam ? "SPAM" : "INBOX";
        }
        // IMAP folders are locations; flag labels remain independent.
        before.touched = [...new Set([...folders.filter((folder) => folder.imap_folder_path && before.labels.includes(folder.id)).map((folder) => folder.id), imapDestination])];
      }
      // Callers often pass [] for a whole thread. IMAP needs real message IDs.
      if ("messageIds" in action && action.messageIds.length === 0) {
        const messages = await db.select<{ id: string }[]>("SELECT id FROM messages WHERE account_id = $1 AND thread_id = $2", [accountId, threadId]);
        action = { ...action, messageIds: messages.map((row) => row.id) } as EmailAction;
      }
      await db.execute(`INSERT INTO pending_operations (id, account_id, operation_type, resource_id, params, next_retry_at)
        VALUES ($1, $2, $3, $4, $5, $6)`, [id, accountId, action.type, threadId, JSON.stringify({ ...actionToParams(action), before: before! }), deadline]);
      if (imapDestination) {
        for (const label of before.touched) {
          await db.execute("DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2 AND label_id = $3", [accountId, threadId, label]);
        }
        await db.execute("INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id) VALUES ($1, $2, $3)", [accountId, threadId, imapDestination]);
      } else await applyLocalDbUpdate(accountId, action);
    });
  } catch (error) {
    return { success: false, error: String(error) };
  }
  if (useAccountStore.getState().activeAccountId === accountId) applyOptimisticUpdate(action);
  const undo = {
    label: undoLabel(action),
    undo: async () => {
      await withTransaction(async (db) => {
        const claimed = await db.execute("DELETE FROM pending_operations WHERE id = $1 AND account_id = $2 AND status = 'pending'", [id, accountId]);
        if (claimed.rowsAffected !== 1) throw new Error("This action has already started. Refresh the mailbox to check its result.");
        await restoreDurableRemoval(accountId, threadId, before!);
      });
      restoreVisibleRemoval(accountId, before!);
    },
  };
  offerUndo(undo);
  // Only expire this action; a later action owns its own timer.
  setTimeout(() => { clearUndo(undo); }, Math.max(0, deadline * 1000 - Date.now()));
  return { success: true, queued: true };
}

/** Called before retiring a permanently rejected intent, including after restart. */
export async function rollbackQueuedRemoval(accountId: string, params: Record<string, unknown>, operationId?: string, error?: string): Promise<void> {
  const before = params.before as DurableRemoval | undefined;
  if (!before || typeof params.threadId !== "string") return;
  await withTransaction(async (db) => {
    await restoreDurableRemoval(accountId, params.threadId as string, before);
    if (operationId) await db.execute("UPDATE pending_operations SET status = 'cancelled', error_message = $1 WHERE id = $2", [error ?? null, operationId]);
  });
  restoreVisibleRemoval(accountId, before);
}

function revertOptimisticUpdate(action: EmailAction): void {
  const store = useThreadStore.getState();
  switch (action.type) {
    case "markRead":
      store.updateThread(action.threadId, { isRead: !action.read });
      break;
    case "star":
      store.updateThread(action.threadId, { isStarred: !action.starred });
      break;
    // For removes (archive/trash/spam/move), we can't easily restore the thread
    // to the list from here. The next sync will fix it.
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Local DB updates (so offline reads reflect changes)
// ---------------------------------------------------------------------------

async function applyLocalDbUpdate(
  accountId: string,
  action: EmailAction,
): Promise<void> {
  const db = await getDb();
  switch (action.type) {
    case "markRead":
      await db.execute(
        "UPDATE threads SET is_read = $1 WHERE account_id = $2 AND id = $3",
        [action.read ? 1 : 0, accountId, action.threadId],
      );
      break;
    case "star":
      await db.execute(
        "UPDATE threads SET is_starred = $1 WHERE account_id = $2 AND id = $3",
        [action.starred ? 1 : 0, accountId, action.threadId],
      );
      if (action.starred) {
        await db.execute(
          "INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id) VALUES ($1, $2, 'STARRED')",
          [accountId, action.threadId],
        );
      } else {
        await db.execute(
          "DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2 AND label_id = 'STARRED'",
          [accountId, action.threadId],
        );
      }
      break;
    case "moveToFolder":
      await db.execute("DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2 AND label_id = $3", [accountId, action.threadId, action.sourceLabelId ?? "INBOX"]);
      await db.execute("INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id) VALUES ($1, $2, $3)", [accountId, action.threadId, action.folderPath]);
      break;
    case "archive":
      await db.execute(
        "DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2 AND label_id = 'INBOX'",
        [accountId, action.threadId],
      );
      break;
    case "trash":
      await db.execute(
        "DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2 AND label_id = 'INBOX'",
        [accountId, action.threadId],
      );
      await db.execute(
        "INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id) VALUES ($1, $2, 'TRASH')",
        [accountId, action.threadId],
      );
      break;
    case "permanentDelete":
      await db.execute(
        "DELETE FROM threads WHERE account_id = $1 AND id = $2",
        [accountId, action.threadId],
      );
      break;
    case "spam":
      if (action.isSpam) {
        await db.execute(
          "DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2 AND label_id = 'INBOX'",
          [accountId, action.threadId],
        );
        await db.execute(
          "INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id) VALUES ($1, $2, 'SPAM')",
          [accountId, action.threadId],
        );
      } else {
        await db.execute(
          "DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2 AND label_id = 'SPAM'",
          [accountId, action.threadId],
        );
        await db.execute(
          "INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id) VALUES ($1, $2, 'INBOX')",
          [accountId, action.threadId],
        );
      }
      break;
    case "addLabel":
      await db.execute(
        "INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id) VALUES ($1, $2, $3)",
        [accountId, action.threadId, action.labelId],
      );
      break;
    case "removeLabel":
      await db.execute(
        "DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2 AND label_id = $3",
        [accountId, action.threadId, action.labelId],
      );
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Core execution
// ---------------------------------------------------------------------------

function getResourceId(action: EmailAction): string {
  if ("threadId" in action && action.threadId) return action.threadId;
  if ("draftId" in action) return action.draftId;
  return crypto.randomUUID();
}

function actionToParams(action: EmailAction): Record<string, unknown> {
  // Strip the type field — it's stored separately as operation_type
  const { type: _, ...rest } = action;
  return rest;
}

async function executeViaProvider(
  accountId: string,
  action: EmailAction,
): Promise<unknown> {
  const provider = await getEmailProvider(accountId);
  if (provider.type === "imap" && REMOVALS.has(action.type) && "messageIds" in action && action.messageIds.length === 0) {
    throw new Error("No synced messages were found for this IMAP thread. Refresh the mailbox before trying again.");
  }
  switch (action.type) {
    case "archive":
      return provider.archive(action.threadId, action.messageIds);
    case "trash":
      return provider.trash(action.threadId, action.messageIds);
    case "permanentDelete":
      return provider.permanentDelete(action.threadId, action.messageIds);
    case "markRead":
      return provider.markRead(
        action.threadId,
        action.messageIds,
        action.read,
      );
    case "star":
      return provider.star(
        action.threadId,
        action.messageIds,
        action.starred,
      );
    case "spam":
      return provider.spam(
        action.threadId,
        action.messageIds,
        action.isSpam,
      );
    case "moveToFolder":
      return provider.moveToFolder(
        action.threadId,
        action.messageIds,
        action.folderPath,
        action.sourceLabelId,
      );
    case "addLabel":
      return provider.addLabel(action.threadId, action.labelId);
    case "removeLabel":
      return provider.removeLabel(action.threadId, action.labelId);
    case "sendMessage":
      return provider.sendMessage(action.rawBase64Url, action.threadId);
    case "createDraft":
      return provider.createDraft(action.rawBase64Url, action.threadId);
    case "updateDraft":
      return provider.updateDraft(
        action.draftId,
        action.rawBase64Url,
        action.threadId,
      );
    case "deleteDraft":
      return provider.deleteDraft(action.draftId);
  }
}

export async function executeEmailAction(
  accountId: string,
  action: EmailAction,
): Promise<ActionResult> {
  if (REMOVALS.has(action.type)) return executeReversibleRemoval(accountId, action);
  const snapshot = captureRemoval(action);
  // 1. Optimistic UI update
  applyOptimisticUpdate(action);

  // 2. Local DB update
  try {
    await applyLocalDbUpdate(accountId, action);
  } catch (err) {
    console.warn("Local DB update failed:", err);
  }

  // 3. If offline, queue
  if (!useUIStore.getState().isOnline) {
    await enqueuePendingOperation(
      accountId,
      action.type,
      getResourceId(action),
      actionToParams(action),
    );
    return { success: true, queued: true };
  }

  // 4. Try online execution
  try {
    const data = await executeViaProvider(accountId, action);
    return { success: true, data };
  } catch (err) {
    const classified = classifyError(err);

    if (classified.isRetryable) {
      // Queue for retry
      await enqueuePendingOperation(
        accountId,
        action.type,
        getResourceId(action),
        actionToParams(action),
      );
      return { success: true, queued: true };
    }

    // Permanent error — revert optimistic update and put a removed thread back.
    revertOptimisticUpdate(action);
    restoreRemoval(snapshot);
    clearUndo();
    if (classified.type === "auth") reportAuthExpired(accountId);
    console.error(`Email action ${action.type} failed permanently:`, err);
    return { success: false, error: classified.message };
  }
}

// ---------------------------------------------------------------------------
// Execute a queued operation (used by queue processor)
// ---------------------------------------------------------------------------

export async function executeQueuedAction(
  accountId: string,
  operationType: string,
  params: Record<string, unknown>,
): Promise<void> {
  const action = { type: operationType, ...params } as EmailAction;
  await executeViaProvider(accountId, action);
}

// ---------------------------------------------------------------------------
// Convenience wrappers
// ---------------------------------------------------------------------------

export function archiveThread(
  accountId: string,
  threadId: string,
  messageIds: string[],
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "archive",
    threadId,
    messageIds,
  });
}

export function trashThread(
  accountId: string,
  threadId: string,
  messageIds: string[],
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "trash",
    threadId,
    messageIds,
  });
}

export function permanentDeleteThread(
  accountId: string,
  threadId: string,
  messageIds: string[],
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "permanentDelete",
    threadId,
    messageIds,
  });
}

export function markThreadRead(
  accountId: string,
  threadId: string,
  messageIds: string[],
  read: boolean,
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "markRead",
    threadId,
    messageIds,
    read,
  });
}

export function starThread(
  accountId: string,
  threadId: string,
  messageIds: string[],
  starred: boolean,
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "star",
    threadId,
    messageIds,
    starred,
  });
}

export function spamThread(
  accountId: string,
  threadId: string,
  messageIds: string[],
  isSpam: boolean,
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "spam",
    threadId,
    messageIds,
    isSpam,
  });
}

export function moveThread(
  accountId: string,
  threadId: string,
  messageIds: string[],
  folderPath: string,
  sourceLabelId?: string,
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "moveToFolder",
    threadId,
    messageIds,
    folderPath,
    sourceLabelId,
  });
}

export function addThreadLabel(
  accountId: string,
  threadId: string,
  labelId: string,
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "addLabel",
    threadId,
    labelId,
  });
}

export function removeThreadLabel(
  accountId: string,
  threadId: string,
  labelId: string,
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "removeLabel",
    threadId,
    labelId,
  });
}

export async function sendEmail(
  accountId: string,
  rawBase64Url: string,
  threadId?: string,
): Promise<ActionResult> {
  const result = await executeEmailAction(accountId, {
    type: "sendMessage",
    rawBase64Url,
    threadId,
  });

  // Notify the UI to refresh (so sent message appears in Sent folder)
  if (result.success) {
    window.dispatchEvent(new Event("velo-sync-done"));
  }

  return result;
}

export function createDraft(
  accountId: string,
  rawBase64Url: string,
  threadId?: string,
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "createDraft",
    rawBase64Url,
    threadId,
  });
}

export function updateDraft(
  accountId: string,
  draftId: string,
  rawBase64Url: string,
  threadId?: string,
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "updateDraft",
    draftId,
    rawBase64Url,
    threadId,
  });
}

export function deleteDraft(
  accountId: string,
  draftId: string,
): Promise<ActionResult> {
  return executeEmailAction(accountId, { type: "deleteDraft", draftId });
}
