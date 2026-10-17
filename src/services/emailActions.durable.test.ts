import { vi, beforeEach, afterEach, describe, it, expect } from "vitest";
import { createSqliteTestDb, type SqliteTestDb } from "@/test/sqliteTestDb";
let db: SqliteTestDb;
vi.mock("@tauri-apps/plugin-sql", () => ({
  default: { load: async () => ({
    select: (sql: string, params?: unknown[]) => db.select(sql, params),
    execute: (sql: string, params?: unknown[]) => db.execute(sql, params),
  }) },
}));
vi.mock("@/router/navigate", () => ({ getSelectedThreadId: () => null, navigateToThread: vi.fn() }));
const provider = vi.hoisted(() => ({ archive: vi.fn(), trash: vi.fn(), spam: vi.fn(), moveToFolder: vi.fn(), permanentDelete: vi.fn() }));
vi.mock("@/services/email/providerFactory", () => ({ getEmailProvider: vi.fn(async () => provider) }));
import { executeEmailAction, MAIL_UNDO_MS, permanentDeleteThread } from "./emailActions";
import { triggerQueueFlush, startQueueProcessor, stopQueueProcessor } from "./queue/queueProcessor";
import { peekUndo, clearUndo } from "./undoStack";
import { useUIStore } from "@/stores/uiStore";
import { useAccountStore } from "@/stores/accountStore";
import { useThreadStore } from "@/stores/threadStore";

async function labels(account = "a") {
  return (await db.select<{ label_id: string }[]>("SELECT label_id FROM thread_labels WHERE account_id=$1 ORDER BY label_id", [account])).map((r) => r.label_id);
}
beforeEach(async () => {
  vi.useFakeTimers(); vi.clearAllMocks(); clearUndo();
  db = createSqliteTestDb();
  await db.execute(`CREATE TABLE accounts (id TEXT, provider TEXT);
    INSERT INTO accounts VALUES ('a','gmail_api');
    CREATE TABLE labels (id TEXT, account_id TEXT, imap_folder_path TEXT);
    CREATE TABLE thread_labels (account_id TEXT, thread_id TEXT, label_id TEXT, UNIQUE(account_id,thread_id,label_id));
    CREATE TABLE threads (id TEXT, account_id TEXT);
    CREATE TABLE messages (id TEXT, account_id TEXT, thread_id TEXT, imap_folder TEXT);
    CREATE TABLE pending_operations (id TEXT PRIMARY KEY, account_id TEXT, operation_type TEXT, resource_id TEXT, params TEXT, status TEXT DEFAULT 'pending', retry_count INTEGER DEFAULT 0, max_retries INTEGER DEFAULT 5, next_retry_at INTEGER, created_at INTEGER DEFAULT 0, error_message TEXT);
    INSERT INTO thread_labels VALUES ('a','t','INBOX'),('a','t','important'),('b','t','INBOX');
    INSERT INTO messages VALUES ('imap-a-INBOX-1','a','t','INBOX');`);
  useAccountStore.setState({ activeAccountId: "a" });
  useThreadStore.setState({ threads: [] });
  useUIStore.setState({ isOnline: true });
});
afterEach(() => { vi.useRealTimers(); db.close(); });

describe("durable removal", () => {
  it.each(["archive", "trash", "spam", "moveToFolder"] as const)("cancels %s in SQLite and queue before reconnect", async (type) => {
    useUIStore.setState({ isOnline: false });
    expect((await executeEmailAction("a", { type, threadId: "t", messageIds: [], isSpam: true, folderPath: "work" })).success).toBe(true);
    expect(await labels()).not.toContain("INBOX");
    const undo = peekUndo()!;
    useAccountStore.setState({ activeAccountId: "b" });
    await undo.undo();
    expect(await labels()).toEqual(["INBOX", "important"]);
    expect(await labels("b")).toEqual(["INBOX"]);
    vi.advanceTimersByTime(MAIL_UNDO_MS + 1000);
    useUIStore.setState({ isOnline: true });
    await triggerQueueFlush();
    expect(provider.archive).not.toHaveBeenCalled();
    expect(provider.trash).not.toHaveBeenCalled();
    expect(provider.spam).not.toHaveBeenCalled();
    expect(provider.moveToFolder).not.toHaveBeenCalled();
  });

  it("resolves IMAP label IDs to real folder paths and restores folder labels on Undo", async () => {
    await db.execute("UPDATE accounts SET provider='imap'");
    await db.execute("INSERT INTO labels VALUES ('INBOX','a','INBOX'),('folder-Work','a','Work'),('STARRED','a',NULL)");
    await db.execute("INSERT INTO thread_labels VALUES ('a','t','STARRED')");
    await executeEmailAction("a", { type: "moveToFolder", threadId: "t", messageIds: [], folderPath: "folder-Work" });
    expect(await labels()).toEqual(["STARRED", "folder-Work", "important"]);
    const params = JSON.parse((await db.select<{ params: string }[]>("SELECT params FROM pending_operations"))[0]!.params);
    expect(params.folderPath).toBe("Work");
    expect(params.messageIds).toEqual(["imap-a-INBOX-1"]);
    await peekUndo()!.undo();
    expect(await labels()).toEqual(["INBOX", "STARRED", "important"]);
  });

  it("holds online dispatch throughout Undo, then sends real IMAP IDs exactly once", async () => {
    await executeEmailAction("a", { type: "archive", threadId: "t", messageIds: [] });
    await triggerQueueFlush();
    expect(provider.archive).not.toHaveBeenCalled();
    vi.advanceTimersByTime(MAIL_UNDO_MS + 1000);
    expect(peekUndo()).toBeNull();
    await triggerQueueFlush(); await triggerQueueFlush();
    expect(provider.archive).toHaveBeenCalledExactlyOnceWith("t", ["imap-a-INBOX-1"]);
  });

  it("restores durable labels after permanent failure and cannot retry the cancelled mutation", async () => {
    provider.trash.mockRejectedValueOnce(new Error("403 Forbidden"));
    await executeEmailAction("a", { type: "trash", threadId: "t", messageIds: ["m"] });
    vi.advanceTimersByTime(MAIL_UNDO_MS + 1000);
    await triggerQueueFlush();
    expect(await labels()).toEqual(["INBOX", "important"]);
    expect((await db.select<{status: string}[]>("SELECT status FROM pending_operations"))[0]?.status).toBe("cancelled");
  });

  it("retains unrelated label changes when Undo restores the source and destination", async () => {
    await executeEmailAction("a", { type: "moveToFolder", threadId: "t", messageIds: ["m"], folderPath: "Work", sourceLabelId: "important" });
    await db.execute("INSERT INTO thread_labels VALUES ('a','t','new-label')");
    await peekUndo()!.undo();
    expect(await labels()).toEqual(["INBOX", "important", "new-label"]);
  });

  it("restores labels and retires the intent when retry attempts are exhausted", async () => {
    provider.archive.mockRejectedValueOnce(new Error("network unavailable"));
    await executeEmailAction("a", { type: "archive", threadId: "t", messageIds: ["m"] });
    await db.execute("UPDATE pending_operations SET retry_count=4");
    vi.advanceTimersByTime(MAIL_UNDO_MS + 1000);
    await triggerQueueFlush();
    expect(await labels()).toEqual(["INBOX", "important"]);
    expect((await db.select<{ status: string }[]>("SELECT status FROM pending_operations"))[0]?.status).toBe("cancelled");
  });

  it("keeps a retry durable through reconnect and prevents a conflicting action", async () => {
    provider.archive.mockRejectedValueOnce(new Error("network unavailable"));
    await executeEmailAction("a", { type: "archive", threadId: "t", messageIds: ["m"] });
    vi.advanceTimersByTime(MAIL_UNDO_MS + 1000);
    await triggerQueueFlush();
    expect((await executeEmailAction("a", { type: "trash", threadId: "t", messageIds: ["m"] })).success).toBe(false);
    expect((await db.select<{ status: string }[]>("SELECT status FROM pending_operations"))[0]?.status).toBe("pending");
    vi.advanceTimersByTime(61_000);
    await triggerQueueFlush();
    expect(provider.archive).toHaveBeenCalledTimes(2);
    expect(await db.select("SELECT * FROM pending_operations")).toEqual([]);
  });

  it("serializes reconnect dispatch and an Undo that wins the claim race", async () => {
    await executeEmailAction("a", { type: "archive", threadId: "t", messageIds: ["m"] });
    const undo = peekUndo()!;
    vi.advanceTimersByTime(MAIL_UNDO_MS + 1000);
    await Promise.all([undo.undo(), triggerQueueFlush()]);
    expect(provider.archive).not.toHaveBeenCalled();
    expect(await labels()).toEqual(["INBOX", "important"]);
    expect(await db.select("SELECT * FROM pending_operations")).toEqual([]);
  });

  it("does not claim Undo succeeded once provider execution has started", async () => {
    let release!: () => void;
    provider.archive.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    await executeEmailAction("a", { type: "archive", threadId: "t", messageIds: ["m"] });
    const undo = peekUndo()!;
    vi.advanceTimersByTime(MAIL_UNDO_MS + 1000);
    const flush = triggerQueueFlush();
    for (let i=0; i<30 && !release; i++) await Promise.resolve();
    expect(release).toBeTypeOf("function");
    await expect(undo.undo()).rejects.toThrow("already started");
    release(); await flush;
    expect(await labels()).toEqual(["important"]);
  });

  async function imapAccountWithSentAndAllMail() {
    await db.execute("UPDATE accounts SET provider='imap'");
    await db.execute("INSERT INTO labels VALUES ('INBOX','a','INBOX'),('SENT','a','Sent'),('DRAFT','a','Drafts'),('all-mail','a','All Mail')");
    await db.execute("INSERT INTO thread_labels VALUES ('a','t','SENT'),('a','t','all-mail')");
  }

  it("never moves or relabels Sent, Drafts or All Mail copies of an IMAP thread", async () => {
    await imapAccountWithSentAndAllMail();
    await db.execute("INSERT INTO messages VALUES ('imap-a-Sent-2','a','t','Sent'),('imap-a-Drafts-3','a','t','Drafts'),('imap-a-All Mail-4','a','t','All Mail')");
    expect((await executeEmailAction("a", { type: "trash", threadId: "t", messageIds: [] })).success).toBe(true);
    const params = JSON.parse((await db.select<{ params: string }[]>("SELECT params FROM pending_operations"))[0]!.params);
    expect(params.messageIds).toEqual(["imap-a-INBOX-1"]);
    expect(await labels()).toEqual(["SENT", "TRASH", "all-mail", "important"]);
    await peekUndo()!.undo();
    expect(await labels()).toEqual(["INBOX", "SENT", "all-mail", "important"]);
  });

  it("refuses, with a visible reason, when an IMAP thread has nothing movable", async () => {
    await imapAccountWithSentAndAllMail();
    await db.execute("DELETE FROM messages");
    await db.execute("INSERT INTO messages VALUES ('imap-a-Sent-2','a','t','Sent')");
    const reasons: string[] = [];
    window.addEventListener("velo-mail-action-error", (event) => reasons.push((event as CustomEvent<string>).detail), { once: true });
    expect((await executeEmailAction("a", { type: "spam", threadId: "t", messageIds: [], isSpam: true })).success).toBe(false);
    expect(reasons[0]).toMatch(/Nothing to move/);
    expect(await db.select("SELECT * FROM pending_operations")).toEqual([]);
    expect(await labels()).toEqual(["INBOX", "SENT", "all-mail", "important"]);
  });

  it("is not blocked by an unrelated queued mark-read on the same thread", async () => {
    await db.execute(`INSERT INTO pending_operations (id, account_id, operation_type, resource_id, params) VALUES ('r','a','markRead','t','{"threadId":"t","read":true}')`);
    expect((await executeEmailAction("a", { type: "archive", threadId: "t", messageIds: ["m"] })).success).toBe(true);
  });

  it("recovers an operation a crashed run left executing, then dispatches it once", async () => {
    await executeEmailAction("a", { type: "archive", threadId: "t", messageIds: ["m"] });
    await db.execute("UPDATE pending_operations SET status='executing'");
    vi.advanceTimersByTime(MAIL_UNDO_MS + 1000);
    startQueueProcessor();
    await vi.advanceTimersByTimeAsync(0);
    stopQueueProcessor();
    await triggerQueueFlush();
    expect(provider.archive).toHaveBeenCalledExactlyOnceWith("t", ["m"]);
  });

  it("offers one Undo that reverts every thread of a multi-select removal", async () => {
    await db.execute("INSERT INTO thread_labels VALUES ('a','u','INBOX')");
    await executeEmailAction("a", { type: "archive", threadId: "t", messageIds: ["m"] });
    await executeEmailAction("a", { type: "archive", threadId: "u", messageIds: ["n"] });
    expect(peekUndo()!.label).toMatch(/^2 conversations/);
    await peekUndo()!.undo();
    expect((await db.select("SELECT * FROM thread_labels WHERE label_id='INBOX' AND account_id='a'")).length).toBe(2);
    expect(await db.select("SELECT * FROM pending_operations")).toEqual([]);
  });

  it("drops a queued removal when the thread is deleted for good, so Undo cannot resurrect it", async () => {
    await executeEmailAction("a", { type: "trash", threadId: "t", messageIds: ["m"] });
    const undo = peekUndo()!;
    await permanentDeleteThread("a", "t", ["m"]);
    expect(await db.select("SELECT * FROM pending_operations WHERE operation_type='trash'")).toEqual([]);
    await expect(undo.undo()).rejects.toThrow("already started");
    expect(await labels()).not.toContain("INBOX");
  });
});
