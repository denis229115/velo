import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock() calls are hoisted — must use inline factories, not external references
vi.mock("./tauriCommands", () => ({
  imapListFolders: vi.fn(),
  imapGetFolderStatus: vi.fn(),
  imapFetchMessages: vi.fn(),
  imapFetchNewUids: vi.fn(),
  imapSearchAllUids: vi.fn(),
  imapSearchFolder: vi.fn(),
  imapDeltaCheck: vi.fn(),
}));
vi.mock("./imapConfigBuilder", () => ({
  buildImapConfig: vi.fn(() => ({
    host: "imap.example.com",
    port: 993,
    security: "ssl",
    username: "user@example.com",
    password: "secret",
    auth_method: "password",
  })),
}));
vi.mock("./folderMapper", () => ({
  mapFolderToLabel: vi.fn((folder: { path: string }) => ({
    labelId: folder.path,
    labelName: folder.path,
    type: "user",
  })),
  getLabelsForMessage: vi.fn(
    (mapping: { labelId: string }, isRead: boolean, isStarred: boolean) => {
      const labels = [mapping.labelId];
      if (!isRead) labels.push("UNREAD");
      if (isStarred) labels.push("STARRED");
      return labels;
    },
  ),
  syncFoldersToLabels: vi.fn(),
  getSyncableFolders: vi.fn((folders: unknown[]) => folders),
}));
vi.mock("../db/messages", () => ({
  upsertMessage: vi.fn(),
  updateMessageThreadIds: vi.fn(),
}));
vi.mock("../db/threads", () => ({
  upsertThread: vi.fn(),
  setThreadLabels: vi.fn(),
  deleteThread: vi.fn(),
}));
vi.mock("../db/attachments", () => ({
  upsertAttachment: vi.fn(),
}));
vi.mock("../db/accounts", () => ({
  getAccount: vi.fn(),
  updateAccountSyncState: vi.fn(),
}));
vi.mock("../db/connection", () => ({
  withTransaction: vi.fn(async (fn: () => Promise<void>) => fn()),
}));
vi.mock("../db/folderSyncState", () => ({
  upsertFolderSyncState: vi.fn(),
  getAllFolderSyncStates: vi.fn(),
}));
vi.mock("../db/pendingOperations", () => ({
  getPendingOpsForResource: vi.fn(() => []),
}));

import { imapMessageToParsedMessage, imapInitialSync, imapDeltaSync, formatImapDate, computeSinceDate, isConnectionError } from "./imapSync";
import {
  createMockImapMessage,
  createMockImapAccount,
  createMockImapFolder,
  createMockImapFolderStatus,
  createMockImapFetchResult,
} from "@/test/mocks";
import { imapListFolders, imapSearchFolder, imapFetchMessages } from "./tauriCommands";
import { getAccount, updateAccountSyncState } from "../db/accounts";
import { withTransaction } from "../db/connection";
import { upsertMessage, updateMessageThreadIds } from "../db/messages";
import { upsertThread, setThreadLabels, deleteThread } from "../db/threads";
import { upsertAttachment } from "../db/attachments";
import { getPendingOpsForResource } from "../db/pendingOperations";
import { getAllFolderSyncStates, upsertFolderSyncState } from "../db/folderSyncState";

describe("imapMessageToParsedMessage", () => {
  it("converts basic IMAP message to ParsedMessage format", () => {
    const msg = createMockImapMessage();
    const { parsed, threadable } = imapMessageToParsedMessage(msg, "acc-1", "INBOX");

    expect(parsed.id).toBe("imap-acc-1-INBOX-42");
    expect(parsed.fromAddress).toBe("sender@example.com");
    expect(parsed.fromName).toBe("Sender Name");
    expect(parsed.toAddresses).toBe("recipient@example.com");
    expect(parsed.subject).toBe("Test Subject");
    expect(parsed.date).toBe(1700000000000);
    expect(parsed.isRead).toBe(false);
    expect(parsed.isStarred).toBe(false);
    expect(parsed.bodyHtml).toBe("<p>Hello</p>");
    expect(parsed.bodyText).toBe("Hello");
    expect(parsed.snippet).toBe("Hello");
    expect(parsed.rawSize).toBe(1024);
    expect(parsed.hasAttachments).toBe(false);
    expect(parsed.attachments).toEqual([]);
  });

  it("generates stable message ID from account, folder, and uid", () => {
    const msg = createMockImapMessage({ uid: 99, folder: "Sent" });
    const { parsed } = imapMessageToParsedMessage(msg, "acc-2", "SENT");
    expect(parsed.id).toBe("imap-acc-2-Sent-99");
  });

  it("includes UNREAD label for unread messages", () => {
    const msg = createMockImapMessage({ is_read: false });
    const { parsed } = imapMessageToParsedMessage(msg, "acc-1", "INBOX");
    expect(parsed.labelIds).toContain("UNREAD");
    expect(parsed.labelIds).toContain("INBOX");
  });

  it("does not include UNREAD label for read messages", () => {
    const msg = createMockImapMessage({ is_read: true });
    const { parsed } = imapMessageToParsedMessage(msg, "acc-1", "INBOX");
    expect(parsed.labelIds).not.toContain("UNREAD");
    expect(parsed.labelIds).toContain("INBOX");
  });

  it("includes STARRED label for flagged messages", () => {
    const msg = createMockImapMessage({ is_starred: true, is_read: true });
    const { parsed } = imapMessageToParsedMessage(msg, "acc-1", "INBOX");
    expect(parsed.labelIds).toContain("STARRED");
  });

  it("creates threadable message with correct fields", () => {
    const msg = createMockImapMessage({
      message_id: "<msg-abc@host.com>",
      in_reply_to: "<msg-parent@host.com>",
      references: "<msg-root@host.com> <msg-parent@host.com>",
    });
    const { threadable } = imapMessageToParsedMessage(msg, "acc-1", "INBOX");

    expect(threadable.id).toBe("imap-acc-1-INBOX-42");
    expect(threadable.messageId).toBe("<msg-abc@host.com>");
    expect(threadable.inReplyTo).toBe("<msg-parent@host.com>");
    expect(threadable.references).toBe("<msg-root@host.com> <msg-parent@host.com>");
    expect(threadable.subject).toBe("Test Subject");
    expect(threadable.date).toBe(1700000000000);
  });

  it("generates synthetic message ID when none present", () => {
    const msg = createMockImapMessage({ message_id: null });
    const { threadable } = imapMessageToParsedMessage(msg, "acc-1", "INBOX");

    expect(threadable.messageId).toBe("synthetic-acc-1-INBOX-42@velo.local");
  });

  it("converts attachments correctly", () => {
    const msg = createMockImapMessage({
      attachments: [
        {
          part_id: "2",
          filename: "report.pdf",
          mime_type: "application/pdf",
          size: 50000,
          content_id: null,
          is_inline: false,
        },
        {
          part_id: "3",
          filename: "logo.png",
          mime_type: "image/png",
          size: 1024,
          content_id: "logo-cid",
          is_inline: true,
        },
      ],
    });
    const { parsed } = imapMessageToParsedMessage(msg, "acc-1", "INBOX");

    expect(parsed.hasAttachments).toBe(true);
    expect(parsed.attachments).toHaveLength(2);
    expect(parsed.attachments[0]).toEqual({
      filename: "report.pdf",
      mimeType: "application/pdf",
      size: 50000,
      gmailAttachmentId: "2",
      contentId: null,
      isInline: false,
    });
    expect(parsed.attachments[1]).toEqual({
      filename: "logo.png",
      mimeType: "image/png",
      size: 1024,
      gmailAttachmentId: "3",
      contentId: "logo-cid",
      isInline: true,
    });
  });

  it("generates snippet from body_text when snippet is null", () => {
    const msg = createMockImapMessage({
      snippet: null,
      body_text: "This is a long email body that should be truncated to create a snippet for display purposes.",
    });
    const { parsed } = imapMessageToParsedMessage(msg, "acc-1", "INBOX");
    expect(parsed.snippet).toBe("This is a long email body that should be truncated to create a snippet for display purposes.");
  });

  it("handles null body fields gracefully", () => {
    const msg = createMockImapMessage({
      body_html: null,
      body_text: null,
      snippet: null,
    });
    const { parsed } = imapMessageToParsedMessage(msg, "acc-1", "INBOX");
    expect(parsed.bodyHtml).toBeNull();
    expect(parsed.bodyText).toBeNull();
    expect(parsed.snippet).toBe("");
  });

  it("preserves list-unsubscribe headers", () => {
    const msg = createMockImapMessage({
      list_unsubscribe: "<mailto:unsub@list.com>",
      list_unsubscribe_post: "List-Unsubscribe=One-Click",
    });
    const { parsed } = imapMessageToParsedMessage(msg, "acc-1", "INBOX");
    expect(parsed.listUnsubscribe).toBe("<mailto:unsub@list.com>");
    expect(parsed.listUnsubscribePost).toBe("List-Unsubscribe=One-Click");
  });

  it("preserves auth results", () => {
    const msg = createMockImapMessage({
      auth_results: '{"spf":"pass","dkim":"pass"}',
    });
    const { parsed } = imapMessageToParsedMessage(msg, "acc-1", "INBOX");
    expect(parsed.authResults).toBe('{"spf":"pass","dkim":"pass"}');
  });

  it("handles date=0 (unparseable Date header) without crashing", () => {
    const msg = createMockImapMessage({ date: 0 });
    const { parsed, threadable } = imapMessageToParsedMessage(msg, "acc-1", "INBOX");

    // date=0 * 1000 = 0, passed through — the caller (imapInitialSync) applies the fallback
    expect(parsed.date).toBe(0);
    expect(threadable.date).toBe(0);
    // Message should still be valid
    expect(parsed.id).toBe("imap-acc-1-INBOX-42");
    expect(parsed.fromAddress).toBe("sender@example.com");
  });
});

describe("imapInitialSync", () => {
  const mockGetAccount = vi.mocked(getAccount);
  const mockImapListFolders = vi.mocked(imapListFolders);
  const mockImapSearchFolder = vi.mocked(imapSearchFolder);
  const mockImapFetchMessages = vi.mocked(imapFetchMessages);
  const mockWithTransaction = vi.mocked(withTransaction);
  const mockUpsertMessage = vi.mocked(upsertMessage);
  const mockUpdateMessageThreadIds = vi.mocked(updateMessageThreadIds);
  const mockUpsertThread = vi.mocked(upsertThread);
  const mockSetThreadLabels = vi.mocked(setThreadLabels);
  const mockUpsertAttachment = vi.mocked(upsertAttachment);
  const mockUpdateAccountSyncState = vi.mocked(updateAccountSyncState);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockGetAccount.mockResolvedValue(createMockImapAccount({ id: "acc-1" }));
  });

  afterEach(() => {
    // Reset persistent mock implementations to prevent leaking between describe blocks
    mockImapSearchFolder.mockReset();
    mockImapFetchMessages.mockReset();
    mockImapListFolders.mockReset();
    vi.useRealTimers();
  });

  /** Configure mocks to return a single folder with the given messages. */
  function setupFolderWithMessages(folder: string, messages: ReturnType<typeof createMockImapMessage>[]) {
    const mockFolder = createMockImapFolder({
      path: folder,
      raw_path: folder,
      exists: messages.length,
    });
    mockImapListFolders.mockResolvedValue([mockFolder]);
    // imapSearchFolder returns UIDs + folder status (no message bodies)
    mockImapSearchFolder.mockResolvedValue({
      uids: messages.map((m) => m.uid),
      folder_status: createMockImapFolderStatus({ exists: messages.length }),
    });
    // imapFetchMessages returns full messages for the requested UIDs
    mockImapFetchMessages.mockResolvedValue(
      createMockImapFetchResult(messages),
    );
    return mockFolder;
  }

  it("stores messages to DB immediately per-chunk (streaming)", async () => {
    const msg1 = createMockImapMessage({ uid: 1, message_id: "<m1@test>", subject: "First", date: Math.floor(Date.now() / 1000) });
    const msg2 = createMockImapMessage({ uid: 2, message_id: "<m2@test>", subject: "Second", date: Math.floor(Date.now() / 1000) });
    setupFolderWithMessages("INBOX", [msg1, msg2]);

    await imapInitialSync("acc-1");

    // Messages should be stored individually via upsertMessage during fetch phase
    expect(mockUpsertMessage).toHaveBeenCalledTimes(2);

    // Each message should be stored with placeholder threadId = messageId
    const firstCallArgs = mockUpsertMessage.mock.calls[0]![0];
    expect(firstCallArgs.threadId).toBe(firstCallArgs.id);

    const secondCallArgs = mockUpsertMessage.mock.calls[1]![0];
    expect(secondCallArgs.threadId).toBe(secondCallArgs.id);
  });

  it("holds last_uid below a chunk that failed instead of recording the later chunks' UIDs", async () => {
    const uids = Array.from({ length: 250 }, (_, i) => i + 1);
    mockImapListFolders.mockResolvedValue([
      createMockImapFolder({ path: "INBOX", raw_path: "INBOX", exists: uids.length }),
    ]);
    mockImapSearchFolder.mockResolvedValue({
      uids,
      folder_status: createMockImapFolderStatus({ exists: uids.length }),
    });
    const late = createMockImapMessage({ uid: 250, message_id: "<m250@test>", date: Math.floor(Date.now() / 1000) });
    mockImapFetchMessages
      .mockRejectedValueOnce(new Error("fetch of UIDs 1..200 was rejected"))
      .mockResolvedValueOnce(createMockImapFetchResult([late]));

    await imapInitialSync("acc-1");

    expect(upsertFolderSyncState).toHaveBeenCalledWith(
      expect.objectContaining({ folder_path: "INBOX", last_uid: 0 }),
    );
  });

  it("creates placeholder thread before each message to satisfy FK constraint", async () => {
    const msg1 = createMockImapMessage({ uid: 1, message_id: "<m1@test>", subject: "Hello", date: Math.floor(Date.now() / 1000) });
    const msg2 = createMockImapMessage({ uid: 2, message_id: "<m2@test>", subject: "World", date: Math.floor(Date.now() / 1000) });
    setupFolderWithMessages("INBOX", [msg1, msg2]);

    await imapInitialSync("acc-1");

    // For each message, upsertThread should be called BEFORE upsertMessage
    // to satisfy the FK constraint (messages.thread_id → threads.id).
    // Phase 2: 2 placeholder threads + Phase 4: 1 or 2 final threads
    expect(mockUpsertThread.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(mockUpsertMessage).toHaveBeenCalledTimes(2);

    // Each placeholder thread must be created before its corresponding message.
    // Verify by checking that the nth thread call preceded the nth message call.
    for (let i = 0; i < 2; i++) {
      const threadOrder = mockUpsertThread.mock.invocationCallOrder[i]!;
      const messageOrder = mockUpsertMessage.mock.invocationCallOrder[i]!;
      expect(threadOrder).toBeLessThan(messageOrder);
    }

    // Verify placeholder threads use the message ID as thread ID
    const firstThreadCall = mockUpsertThread.mock.calls[0]![0];
    const firstMsgCall = mockUpsertMessage.mock.calls[0]![0];
    expect(firstThreadCall.id).toBe(firstMsgCall.id);
    expect(firstThreadCall.id).toBe(firstMsgCall.threadId);
  });

  it("labels the placeholder thread in phase 2 so inbox can show the message", async () => {
    const msg = createMockImapMessage({
      uid: 42,
      folder: "INBOX",
      message_id: "<m1@test>",
      subject: "Hello",
      date: Math.floor(Date.now() / 1000),
    });
    setupFolderWithMessages("INBOX", [msg]);

    await imapInitialSync("acc-1");

    const placeholderId = "imap-acc-1-INBOX-42";
    const phase2Call = mockSetThreadLabels.mock.calls.find((call) => call[1] === placeholderId);
    expect(phase2Call).toEqual(["acc-1", placeholderId, expect.arrayContaining(["INBOX"])]);

    const phase2Order = mockSetThreadLabels.mock.invocationCallOrder[
      mockSetThreadLabels.mock.calls.findIndex((call) => call[1] === placeholderId)
    ];
    expect(phase2Order).toBeLessThan(mockUpdateMessageThreadIds.mock.invocationCallOrder[0]!);
  });

  it("updates thread IDs after threading phase", async () => {
    const msg1 = createMockImapMessage({ uid: 1, message_id: "<m1@test>", subject: "Hello", date: Math.floor(Date.now() / 1000) });
    setupFolderWithMessages("INBOX", [msg1]);

    await imapInitialSync("acc-1");

    // Thread record should be created: once as placeholder in Phase 2, once final in Phase 4
    expect(mockUpsertThread).toHaveBeenCalledTimes(2);

    // Thread IDs should be batch-updated via updateMessageThreadIds
    expect(mockUpdateMessageThreadIds).toHaveBeenCalledTimes(1);
    const [accountId, messageIds, threadId] = mockUpdateMessageThreadIds.mock.calls[0]!;
    expect(accountId).toBe("acc-1");
    expect(messageIds).toHaveLength(1);
    expect(threadId).toBeTruthy();
  });

  it("returns empty messages array (bodies not accumulated)", async () => {
    const msg = createMockImapMessage({ uid: 1, message_id: "<m1@test>", date: Math.floor(Date.now() / 1000) });
    setupFolderWithMessages("INBOX", [msg]);

    const result = await imapInitialSync("acc-1");

    // The streaming approach returns empty array — bodies are already in DB
    expect(result.messages).toEqual([]);
  });

  it("stores attachments immediately with the message", async () => {
    const msg = createMockImapMessage({
      uid: 1,
      message_id: "<m1@test>",
      date: Math.floor(Date.now() / 1000),
      attachments: [
        {
          part_id: "2",
          filename: "doc.pdf",
          mime_type: "application/pdf",
          size: 5000,
          content_id: null,
          is_inline: false,
        },
      ],
    });
    setupFolderWithMessages("INBOX", [msg]);

    await imapInitialSync("acc-1");

    expect(mockUpsertAttachment).toHaveBeenCalledTimes(1);
    expect(mockUpsertAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: "doc.pdf",
        mimeType: "application/pdf",
        accountId: "acc-1",
      }),
    );
  });

  it("stores messages older than the sync window", async () => {
    const recentDate = Math.floor(Date.now() / 1000) - 10; // 10 seconds ago
    const oldDate = Math.floor(Date.now() / 1000) - 400 * 86400; // 400 days ago

    const recentMsg = createMockImapMessage({ uid: 1, message_id: "<recent@test>", date: recentDate });
    const oldMsg = createMockImapMessage({ uid: 2, message_id: "<old@test>", date: oldDate });

    setupFolderWithMessages("INBOX", [recentMsg, oldMsg]);

    await imapInitialSync("acc-1", 365);

    const storedIds = mockUpsertMessage.mock.calls.map((call) => call[0].id);
    expect(storedIds).toEqual(["imap-acc-1-INBOX-1", "imap-acc-1-INBOX-2"]);
  });

  it("handles empty folders gracefully", async () => {
    const mockFolder = createMockImapFolder({ path: "INBOX", raw_path: "INBOX", exists: 0 });
    mockImapListFolders.mockResolvedValue([mockFolder]);

    const result = await imapInitialSync("acc-1");

    expect(mockImapSearchFolder).not.toHaveBeenCalled();
    expect(mockUpsertMessage).not.toHaveBeenCalled();
    expect(result.messages).toEqual([]);
  });

  it("reports progress through all phases", async () => {
    const msg = createMockImapMessage({ uid: 1, message_id: "<m1@test>", date: Math.floor(Date.now() / 1000) });
    setupFolderWithMessages("INBOX", [msg]);

    const progressCalls: Array<{ phase: string }> = [];
    await imapInitialSync("acc-1", 365, (progress) => {
      progressCalls.push({ phase: progress.phase });
    });

    const phases = progressCalls.map((p) => p.phase);
    expect(phases).toContain("folders");
    expect(phases).toContain("messages");
    expect(phases).toContain("threading");
    expect(phases).toContain("storing_threads");
    expect(phases).toContain("done");
  });

  it("uses imapSearchFolder + imapFetchMessages for chunked sync per folder", async () => {
    const msg = createMockImapMessage({ uid: 1, message_id: "<m1@test>", date: Math.floor(Date.now() / 1000) });
    setupFolderWithMessages("INBOX", [msg]);

    await imapInitialSync("acc-1");

    // SEARCH ALL — sinceDate null — so old mail is not dropped before fetch
    expect(mockImapSearchFolder).toHaveBeenCalledTimes(1);
    expect(mockImapSearchFolder).toHaveBeenCalledWith(
      expect.objectContaining({ host: "imap.example.com" }),
      "INBOX",
      null,
    );

    // Then fetch the messages by UID
    expect(mockImapFetchMessages).toHaveBeenCalledTimes(1);
    expect(mockImapFetchMessages).toHaveBeenCalledWith(
      expect.objectContaining({ host: "imap.example.com" }),
      "INBOX",
      [1], // UIDs from search
    );
  });

  it("syncs INBOX before other folders and marks the account synced after INBOX", async () => {
    const now = Math.floor(Date.now() / 1000);
    const inboxMsg = createMockImapMessage({
      uid: 7,
      folder: "INBOX",
      message_id: "<in@test>",
      date: now,
    });
    const archiveMsg = createMockImapMessage({
      uid: 8,
      folder: "Archive",
      message_id: "<ar@test>",
      date: now,
    });

    mockImapListFolders.mockResolvedValue([
      createMockImapFolder({ path: "Archive", raw_path: "Archive", name: "Archive", exists: 1 }),
      createMockImapFolder({ path: "INBOX", raw_path: "INBOX", name: "INBOX", exists: 1 }),
    ]);
    mockImapSearchFolder.mockImplementation(async (_config, folder: string) => ({
      uids: [folder === "INBOX" ? inboxMsg.uid : archiveMsg.uid],
      folder_status: createMockImapFolderStatus({ exists: 1 }),
    }));
    mockImapFetchMessages.mockImplementation(async (_config, folder: string) =>
      createMockImapFetchResult([folder === "INBOX" ? inboxMsg : archiveMsg]),
    );

    const syncPromise = imapInitialSync("acc-1");
    await vi.runAllTimersAsync();
    await syncPromise;

    expect(mockImapSearchFolder.mock.calls.map((call) => call[1])).toEqual(["INBOX", "Archive"]);

    const archiveFetchIndex = mockImapFetchMessages.mock.calls.findIndex((call) => call[1] === "Archive");
    expect(archiveFetchIndex).toBeGreaterThanOrEqual(0);
    const historyOrder = mockUpdateAccountSyncState.mock.invocationCallOrder[0];
    const archiveFetchOrder = mockImapFetchMessages.mock.invocationCallOrder[archiveFetchIndex]!;
    expect(historyOrder).toBeLessThan(archiveFetchOrder);
  });

  it("wraps chunk DB writes in a transaction", async () => {
    const msg = createMockImapMessage({ uid: 1, message_id: "<m1@test>", date: Math.floor(Date.now() / 1000) });
    setupFolderWithMessages("INBOX", [msg]);

    await imapInitialSync("acc-1");

    // withTransaction should be called: once for Phase 2 chunk + once for Phase 4 batch
    expect(mockWithTransaction).toHaveBeenCalledTimes(2);
  });

  it("raises an error and keeps last_uid at 0 when the only chunk fails", async () => {
    const msg1 = createMockImapMessage({ uid: 1, message_id: "<m1@test>", date: Math.floor(Date.now() / 1000) });
    const msg2 = createMockImapMessage({ uid: 201, message_id: "<m2@test>", date: Math.floor(Date.now() / 1000) });

    const mockFolder = createMockImapFolder({ path: "INBOX", raw_path: "INBOX", exists: 2 });
    mockImapListFolders.mockResolvedValue([mockFolder]);

    // Return UIDs in two "chunks" (we'll set CHUNK_SIZE to 200 but have UIDs 1 and 201)
    mockImapSearchFolder.mockResolvedValue({
      uids: [1, 201],
      folder_status: createMockImapFolderStatus({ exists: 2 }),
    });

    // First chunk fetch succeeds, but because both UIDs are in the same chunk (< 200),
    // we test error handling by making imapFetchMessages fail on first call and succeed on retry
    mockImapFetchMessages
      .mockRejectedValueOnce(new Error("fetch timeout"))
      .mockResolvedValueOnce(createMockImapFetchResult([msg2]));

    // This won't exercise the multi-chunk path since 2 UIDs < 200 chunk size.
    // Instead test that a search failure at folder level is handled.
    // Reset and use a simpler approach: single chunk that fails
    vi.clearAllMocks();
    mockGetAccount.mockResolvedValue(createMockImapAccount({ id: "acc-1" }));

    const msgs = Array.from({ length: 2 }, (_, i) =>
      createMockImapMessage({ uid: i + 1, message_id: `<m${i}@test>`, date: Math.floor(Date.now() / 1000) }),
    );
    setupFolderWithMessages("INBOX", msgs);

    // Even if imapFetchMessages fails for one chunk, the folder-level error is caught
    mockImapFetchMessages.mockRejectedValueOnce(new Error("chunk fetch failed"));

    const syncPromise = imapInitialSync("acc-1");
    const outcome = expect(syncPromise).rejects.toThrow(/chunk\(s\) failed to fetch/);
    await vi.runAllTimersAsync();
    await outcome;

    // The error is raised, and last_uid stays at 0 so the next delta cycle refetches the chunk
    expect(upsertFolderSyncState).toHaveBeenCalledWith(
      expect.objectContaining({ folder_path: "INBOX", last_uid: 0 }),
    );
  });

  it("circuit breaker skips remaining folders after 5 consecutive connection failures", async () => {
    const folders = Array.from({ length: 8 }, (_, i) =>
      createMockImapFolder({ path: `folder-${i}`, raw_path: `folder-${i}`, exists: 10 }),
    );
    mockImapListFolders.mockResolvedValue(folders);
    mockImapSearchFolder.mockRejectedValue(new Error("TCP connect timed out (os error 60)"));

    // Advance timers and catch the expected error in one go to avoid
    // Vitest's unhandled-rejection tracker from flagging it.
    let caughtError: Error | null = null;
    const syncPromise = imapInitialSync("acc-1").catch((err: Error) => {
      caughtError = err;
    });
    await vi.runAllTimersAsync();
    await syncPromise;

    // All folders fail → error is propagated
    expect(caughtError).not.toBeNull();
    expect(caughtError!.message).toContain("All folders failed to sync");

    // Circuit breaker should stop after 5 failures (CIRCUIT_BREAKER_MAX_FAILURES)
    expect(mockImapSearchFolder).toHaveBeenCalledTimes(5);
  });

  it("circuit breaker resets on successful folder sync", async () => {
    const folders = [
      createMockImapFolder({ path: "f1", raw_path: "f1", exists: 10 }),
      createMockImapFolder({ path: "f2", raw_path: "f2", exists: 10 }),
      createMockImapFolder({ path: "f3", raw_path: "f3", exists: 10 }),
      createMockImapFolder({ path: "f4", raw_path: "f4", exists: 10 }),
    ];
    mockImapListFolders.mockResolvedValue(folders);

    const msg = createMockImapMessage({ uid: 1, message_id: "<m1@test>", date: Math.floor(Date.now() / 1000) });

    // First 2 fail with connection error, 3rd succeeds, 4th fails
    mockImapSearchFolder
      .mockRejectedValueOnce(new Error("TCP connect timed out"))
      .mockRejectedValueOnce(new Error("TCP connect timed out"))
      .mockResolvedValueOnce({
        uids: [msg.uid],
        folder_status: createMockImapFolderStatus({ exists: 1 }),
      })
      .mockRejectedValueOnce(new Error("TCP connect timed out"));

    mockImapFetchMessages.mockResolvedValue(createMockImapFetchResult([msg]));

    const syncPromise = imapInitialSync("acc-1");
    await vi.runAllTimersAsync();
    await syncPromise;

    // All 4 folders should be attempted (circuit breaker resets after success on f3)
    expect(mockImapSearchFolder).toHaveBeenCalledTimes(4);
  });

  it("continues on non-connection errors without triggering circuit breaker", async () => {
    const folders = Array.from({ length: 6 }, (_, i) =>
      createMockImapFolder({ path: `folder-${i}`, raw_path: `folder-${i}`, exists: 10 }),
    );
    mockImapListFolders.mockResolvedValue(folders);

    // Non-connection errors should NOT trigger circuit breaker
    mockImapSearchFolder.mockRejectedValue(new Error("PARSE failed: invalid response"));

    let caughtError: Error | null = null;
    const syncPromise = imapInitialSync("acc-1").catch((err: Error) => {
      caughtError = err;
    });
    await vi.runAllTimersAsync();
    await syncPromise;

    // All folders fail → error is propagated, but all were attempted first
    expect(caughtError).not.toBeNull();
    expect(caughtError!.message).toContain("All folders failed to sync");

    // All folders should be attempted since these aren't connection errors
    expect(mockImapSearchFolder).toHaveBeenCalledTimes(6);
  });
});

describe("formatImapDate", () => {
  it("formats a date as DD-Mon-YYYY for IMAP SINCE criterion", () => {
    // 2024-03-15 UTC
    const date = new Date(Date.UTC(2024, 2, 15));
    expect(formatImapDate(date)).toBe("15-Mar-2024");
  });

  it("handles single-digit days without zero-padding", () => {
    const date = new Date(Date.UTC(2024, 0, 5));
    expect(formatImapDate(date)).toBe("5-Jan-2024");
  });

  it("handles December correctly", () => {
    const date = new Date(Date.UTC(2024, 11, 31));
    expect(formatImapDate(date)).toBe("31-Dec-2024");
  });
});

describe("computeSinceDate", () => {
  it("returns a date daysBack+1 days ago in DD-Mon-YYYY format", () => {
    const result = computeSinceDate(365);
    // Should match DD-Mon-YYYY format
    expect(result).toMatch(/^\d{1,2}-[A-Z][a-z]{2}-\d{4}$/);
  });

  it("adds 1-day safety margin", () => {
    // For daysBack=0, should still go back 1 day
    const result = computeSinceDate(0);
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    expect(result).toBe(formatImapDate(yesterday));
  });
});

describe("isConnectionError", () => {
  it("detects 'timed out' errors", () => {
    expect(isConnectionError("TCP connect timed out (os error 60)")).toBe(true);
  });

  it("detects 'connection' errors", () => {
    expect(isConnectionError("connection reset by peer")).toBe(true);
  });

  it("detects TLS errors", () => {
    expect(isConnectionError("tls handshake failed")).toBe(true);
  });

  it("detects DNS errors", () => {
    expect(isConnectionError("dns resolution failed")).toBe(true);
  });

  it("detects ECONNREFUSED errors", () => {
    expect(isConnectionError("connect ECONNREFUSED 127.0.0.1:993")).toBe(true);
  });

  it("detects socket errors", () => {
    expect(isConnectionError("socket hang up")).toBe(true);
  });

  it("detects network errors", () => {
    expect(isConnectionError("network is unreachable")).toBe(true);
  });

  it("returns false for non-connection errors", () => {
    expect(isConnectionError("PARSE failed: invalid response")).toBe(false);
    expect(isConnectionError("authentication failed")).toBe(false);
  });
});

describe("imapInitialSync — all-folders-fail propagation", () => {
  const mockGetAccount = vi.mocked(getAccount);
  const mockImapListFolders = vi.mocked(imapListFolders);
  const mockImapSearchFolder = vi.mocked(imapSearchFolder);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockGetAccount.mockResolvedValue(createMockImapAccount({ id: "acc-1" }));
  });

  afterEach(() => {
    // Reset search mock implementation to prevent leaking into subsequent tests
    mockImapSearchFolder.mockReset();
    vi.useRealTimers();
  });

  it("throws when all folders fail and no messages were stored", async () => {
    const folders = [
      createMockImapFolder({ path: "INBOX", raw_path: "INBOX", exists: 10 }),
      createMockImapFolder({ path: "Sent", raw_path: "Sent", exists: 5 }),
    ];
    mockImapListFolders.mockResolvedValue(folders);
    mockImapSearchFolder.mockRejectedValue("authentication failed");

    let caughtError: Error | null = null;
    const syncPromise = imapInitialSync("acc-1").catch((err: Error) => {
      caughtError = err;
    });
    await vi.runAllTimersAsync();
    await syncPromise;

    expect(caughtError).not.toBeNull();
    expect(caughtError!.message).toContain("All folders failed to sync");
  });
});

describe("imapInitialSync — placeholder cleanup", () => {
  const mockGetAccount = vi.mocked(getAccount);
  const mockImapListFolders = vi.mocked(imapListFolders);
  const mockImapSearchFolder = vi.mocked(imapSearchFolder);
  const mockImapFetchMessages = vi.mocked(imapFetchMessages);
  const mockDeleteThread = vi.mocked(deleteThread);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockGetAccount.mockResolvedValue(createMockImapAccount({ id: "acc-1" }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("deletes orphaned placeholder threads after threading", async () => {
    // Two messages that share the same thread via References
    const msg1 = createMockImapMessage({
      uid: 1,
      message_id: "<m1@test>",
      subject: "Thread Subject",
      date: Math.floor(Date.now() / 1000),
    });
    const msg2 = createMockImapMessage({
      uid: 2,
      message_id: "<m2@test>",
      in_reply_to: "<m1@test>",
      references: "<m1@test>",
      subject: "Re: Thread Subject",
      date: Math.floor(Date.now() / 1000) + 60,
    });

    const mockFolder = createMockImapFolder({ path: "INBOX", raw_path: "INBOX", exists: 2 });
    mockImapListFolders.mockResolvedValue([mockFolder]);
    mockImapSearchFolder.mockResolvedValue({
      uids: [1, 2],
      folder_status: createMockImapFolderStatus({ exists: 2 }),
    });
    mockImapFetchMessages.mockResolvedValue(createMockImapFetchResult([msg1, msg2]));

    await imapInitialSync("acc-1");

    // Threading should merge the two messages into one thread,
    // so at least one placeholder thread (the one not chosen as thread ID) should be deleted
    expect(mockDeleteThread).toHaveBeenCalled();
  });
});

describe("imapDeltaSync", () => {
  const mockGetAccount = vi.mocked(getAccount);
  const mockImapListFolders = vi.mocked(imapListFolders);
  const mockImapSearchFolder = vi.mocked(imapSearchFolder);
  const mockGetAllFolderSyncStates = vi.mocked(getAllFolderSyncStates);

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAccount.mockResolvedValue(createMockImapAccount({ id: "acc-1" }));
    mockGetAllFolderSyncStates.mockResolvedValue([]);
  });

  it("searches the whole folder when it has no saved sync state", async () => {
    mockImapListFolders.mockResolvedValue([
      createMockImapFolder({
        path: "Archive",
        raw_path: "Archive",
        name: "Archive",
        exists: 1,
      }),
    ]);
    mockImapSearchFolder.mockResolvedValue({
      uids: [],
      folder_status: createMockImapFolderStatus({ exists: 1 }),
    });

    await imapDeltaSync("acc-1", 365);

    expect(mockImapSearchFolder).toHaveBeenCalledWith(
      expect.objectContaining({ host: "imap.example.com" }),
      "Archive",
      null,
    );
  });

  it("does not record last_uid when the fetch is rejected", async () => {
    mockImapListFolders.mockResolvedValue([
      createMockImapFolder({ path: "Archive", raw_path: "Archive", name: "Archive", exists: 2 }),
    ]);
    mockImapSearchFolder.mockResolvedValue({
      uids: [11, 12],
      folder_status: createMockImapFolderStatus({ exists: 2 }),
    });
    vi.mocked(imapFetchMessages).mockRejectedValue(
      new Error("IMAP sync: fetch of UIDs 11,12 was rejected"),
    );

    await expect(imapDeltaSync("acc-1", 365)).rejects.toThrow(/rejected/);

    expect(upsertFolderSyncState).not.toHaveBeenCalled();
  });

  it("reports what the cycle did: folders checked, messages fetched, per-folder errors", async () => {
    mockImapListFolders.mockResolvedValue([
      createMockImapFolder({ path: "Archive", raw_path: "Archive", name: "Archive", exists: 1 }),
    ]);
    mockImapSearchFolder.mockResolvedValue({
      uids: [11],
      folder_status: createMockImapFolderStatus({ exists: 1 }),
    });
    vi.mocked(imapFetchMessages).mockResolvedValue(
      createMockImapFetchResult([createMockImapMessage({ uid: 11, folder: "Archive" })]),
    );

    const result = await imapDeltaSync("acc-1", 365);

    expect(result.stats).toEqual({ foldersChecked: 1, messagesFetched: 1, errors: [] });
  });
});
