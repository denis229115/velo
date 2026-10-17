import { useUIStore } from "@/stores/uiStore";
import { useThreadStore, type Thread } from "@/stores/threadStore";
import { getEmailProvider } from "@/services/email/providerFactory";
import { enqueuePendingOperation } from "@/services/db/pendingOperations";
import { classifyError } from "@/utils/networkErrors";
import { useAccountStore } from "@/stores/accountStore";
import { getDb, withTransaction } from "@/services/db/connection";
import { navigateToThread, getSelectedThreadId } from "@/router/navigate";
import { clearUndo, offerUndo, peekUndo, type UndoAction } from "@/services/undoStack";
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
/** IMAP label ids whose messages stay put when a thread is archived, trashed, spammed or moved. */
const IMAP_KEEP_LABELS = new Set(["SENT", "DRAFT", "all-mail"]);
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
      // Only another removal conflicts; queued mark-read, star or send ops on the thread are independent.
      const pending = await db.select<{ params: string }[]>("SELECT params FROM pending_operations WHERE account_id = $1 AND resource_id = $2 AND status IN ('pending', 'executing')", [accountId, threadId]);
      if (pending.some((row) => (JSON.parse(row.params) as { before?: unknown }).before)) {
        throw new Error("This thread already has a pending move. Wait for it to finish or Undo it first.");
      }
      const labels = await db.select<{ label_id: string }[]>("SELECT label_id FROM thread_labels WHERE account_id = $1 AND thread_id = $2", [accountId, threadId]);
      const touched = action.type === "archive" ? ["INBOX"] : action.type === "trash" ? ["INBOX", "TRASH"] : action.type === "spam" ? ["INBOX", "SPAM"] : action.type === "moveToFolder" ? [action.sourceLabelId ?? "INBOX", action.folderPath] : [];
      before = { labels: labels.map((row) => row.label_id), touched, thread: captureRemoval(action, accountId) };
      const accounts = await db.select<{ provider: string }[]>("SELECT provider FROM accounts WHERE id = $1", [accountId]);
      let imapDestination: string | undefined;
      // Copies the user keeps on purpose (Sent, Drafts, All Mail) never move with the thread.
      let protectedPaths = new Set<string>();
      if (accounts[0]?.provider === "imap") {
        const folders = await db.select<{ id: string; imap_folder_path: string | null }[]>("SELECT id, imap_folder_path FROM labels WHERE account_id = $1", [accountId]);
        protectedPaths = new Set(folders.filter((folder) => folder.imap_folder_path && IMAP_KEEP_LABELS.has(folder.id)).map((folder) => folder.imap_folder_path as string));
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
        before.touched = [...new Set([...folders.filter((folder) => folder.imap_folder_path && before.labels.includes(folder.id) && !IMAP_KEEP_LABELS.has(folder.id)).map((folder) => folder.id), imapDestination])];
      }
      // Callers often pass [] for a whole thread. IMAP needs real message IDs.
      if ("messageIds" in action && action.messageIds.length === 0) {
        const messages = await db.select<{ id: string; imap_folder: string | null }[]>("SELECT id, imap_folder FROM messages WHERE account_id = $1 AND thread_id = $2", [accountId, threadId]);
        const movable = messages.filter((row) => !row.imap_folder || !protectedPaths.has(row.imap_folder));
        if (accounts[0]?.provider === "imap" && movable.length === 0) {
          throw new Error("Nothing to move: this conversation only has Sent, Draft or All Mail copies, which stay where they are.");
        }
        action = { ...action, messageIds: movable.map((row) => row.id) } as EmailAction;
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
    // Callers rarely look at the result, so say why nothing happened.
    const reason = error instanceof Error ? error.message : String(error);
    window.dispatchEvent(new CustomEvent("velo-mail-action-error", { detail: reason }));
    return { success: false, error: reason };
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
  offerGroupedUndo({ undo, opId: id, accountId }, deadline * 1000);
  return { success: true, queued: true };
}

/** Removals started together (multi-select, quick steps) share one Undo that reverts all of them.
 * The window slides: each removal that joins keeps the group open for another moment, so a long
 * multi-select stays one group while two separate, unhurried keypresses stay separate. */
const UNDO_GROUP_GAP_MS = 750;
interface UndoMember { undo: UndoAction; opId: string; accountId: string }
interface UndoGroup {
  members: UndoMember[];
  offered: UndoAction;
  lastJoinAt: number;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}
let undoGroup: UndoGroup | null = null;

/** One timer per group; it re-arms until the real deadline has passed, whatever the clock did. */
function armUndoExpiry(group: UndoGroup): void {
  if (group.timer) clearTimeout(group.timer);
  group.timer = setTimeout(() => {
    group.timer = null;
    if (Date.now() < group.expiresAt) armUndoExpiry(group);
    else clearUndo(group.offered);
  }, Math.max(0, group.expiresAt - Date.now()) + 25);
}

function groupLabel(members: UndoMember[]): string {
  const labels = new Set(members.map((member) => member.undo.label));
  return labels.size === 1
    ? `${members.length} conversations: ${[...labels][0]!.toLowerCase()}`
    : `${members.length} conversations updated`;
}

function offerGroupedUndo(member: UndoMember, expiresAt: number): void {
  const now = Date.now();
  const group = undoGroup;
  const joinable = group !== null && peekUndo() === group.offered && now - group.lastJoinAt < UNDO_GROUP_GAP_MS;
  if (!group || !joinable) {
    const fresh: UndoGroup = { members: [member], offered: member.undo, lastJoinAt: now, expiresAt, timer: null };
    undoGroup = fresh;
    offerUndo(member.undo);
    armUndoExpiry(fresh);
    return;
  }
  group.members.push(member);
  group.lastJoinAt = now;
  group.expiresAt = Math.max(group.expiresAt, expiresAt);
  const members = [...group.members];
  group.offered = {
    label: groupLabel(members),
    undo: async () => {
      // Newest first, so each restore sees the list the way that removal left it.
      let firstError: unknown;
      for (const entry of [...members].reverse()) {
        try { await entry.undo.undo(); } catch (error) { firstError ??= error; }
      }
      if (firstError) throw firstError;
    },
  };
  offerUndo(group.offered);
  armUndoExpiry(group);
  // No member may reach the server before the group's Undo has expired.
  const deadline = Math.ceil(group.expiresAt / 1000);
  void withTransaction(async (db) => {
    for (const entry of members) {
      await db.execute("UPDATE pending_operations SET next_retry_at = $1 WHERE id = $2 AND account_id = $3 AND status = 'pending' AND (next_retry_at IS NULL OR next_retry_at < $1)", [deadline, entry.opId, entry.accountId]);
    }
  }).catch((error) => console.warn("Could not extend the Undo window for grouped removals:", error));
}

/** A thread about to be deleted for good must not keep a queued move or a restorable Undo.
 * Deleting the row also makes a later Undo fail safely instead of resurrecting the thread.
 * Returns the message IDs the discarded move would have acted on: they are still in their
 * source folder on the server, so the delete has to reach them there. */
async function discardPendingRemovals(accountId: string, threadId: string): Promise<string[]> {
  const discarded: string[] = [];
  await withTransaction(async (db) => {
    const rows = await db.select<{ id: string; params: string }[]>("SELECT id, params FROM pending_operations WHERE account_id = $1 AND resource_id = $2 AND status = 'pending'", [accountId, threadId]);
    for (const row of rows) {
      const params = JSON.parse(row.params) as { before?: unknown; messageIds?: string[] };
      if (!params.before) continue;
      await db.execute("DELETE FROM pending_operations WHERE id = $1 AND status = 'pending'", [row.id]);
      discarded.push(...(params.messageIds ?? []));
    }
  });
  if (discarded.length) clearUndo();
  return discarded;
}

/** Callers pass [] for a whole thread, which the IMAP provider treats as nothing to do, so the
 * message would only vanish locally and return on the next sync. Delete the copies in Trash
 * (and any that a just-discarded move had not yet carried there). */
async function resolveImapPermanentDelete(accountId: string, action: Extract<EmailAction, { type: "permanentDelete" }>, discarded: string[]): Promise<EmailAction> {
  if (action.messageIds.length > 0) return action;
  try {
    const db = await getDb();
    const accounts = await db.select<{ provider: string }[]>("SELECT provider FROM accounts WHERE id = $1", [accountId]);
    if (accounts[0]?.provider !== "imap") return action;
    const trashed = await db.select<{ id: string }[]>(
      `SELECT m.id FROM messages m
       JOIN labels l ON l.account_id = m.account_id AND l.id = 'TRASH' AND l.imap_folder_path = m.imap_folder
       WHERE m.account_id = $1 AND m.thread_id = $2`,
      [accountId, action.threadId],
    );
    return { ...action, messageIds: [...new Set([...trashed.map((row) => row.id), ...discarded])] };
  } catch (err) {
    console.warn("Could not resolve IMAP messages for permanent delete:", err);
    return action;
  }
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
  if (action.type === "permanentDelete") {
    const discarded = await discardPendingRemovals(accountId, action.threadId);
    action = await resolveImapPermanentDelete(accountId, action, discarded);
  }
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
