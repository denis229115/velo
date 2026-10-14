import { createSqliteTestDb, type SqliteTestDb } from "@/test/sqliteTestDb";

let db: SqliteTestDb;
// Tauri SQL plugin boundary: every getDb() call lands on the current in-memory DB.
vi.mock("@tauri-apps/plugin-sql", () => ({
  default: {
    load: async () => ({
      select: (sql: string, params?: unknown[]) => db.select(sql, params),
      execute: (sql: string, params?: unknown[]) => db.execute(sql, params),
    }),
  },
}));

// Gmail API boundary: the client the Gmail provider sends through.
const gmailSend = vi.fn();
vi.mock("@/services/gmail/tokenManager", () => ({
  getGmailClient: vi.fn(async () => ({ sendMessage: gmailSend })),
}));

// Tauri IPC boundary: the SMTP/IMAP commands the IMAP provider calls.
const tauriInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: unknown) => tauriInvoke(cmd, args),
}));

// OS notification boundary.
const notifyFailed = vi.fn();
vi.mock("@/services/notifications/notificationManager", () => ({
  notifyScheduledSendFailed: (...args: unknown[]) => notifyFailed(...args),
}));

import { useUIStore } from "@/stores/uiStore";
import { runMigrations } from "@/services/db/migrations";
import { clearAllProviders } from "@/services/email/providerFactory";
import { insertScheduledEmail } from "@/services/db/scheduledEmails";
import { processDueScheduledEmails, recoverInterruptedScheduledSends } from "./scheduledSendManager";

const NOW = () => Math.floor(Date.now() / 1000);

function decodeRaw(rawBase64Url: string): string {
  const b64 = rawBase64Url.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64").toString("utf8");
}

async function seedAccounts() {
  await db.execute(
    "INSERT INTO accounts (id, email, provider) VALUES ('gmail-1', 'me@gmail.com', 'gmail_api')",
  );
  await db.execute(
    `INSERT INTO accounts (id, email, provider, auth_method, imap_host, imap_port, imap_security,
       smtp_host, smtp_port, smtp_security, imap_password)
     VALUES ('imap-1', 'me@fastmail.com', 'imap', 'password', 'imap.fastmail.com', 993, 'ssl',
       'smtp.fastmail.com', 465, 'ssl', 'app-password')`,
  );
}

async function scheduleDue(accountId: string, overrides: Partial<Parameters<typeof insertScheduledEmail>[0]> = {}) {
  return insertScheduledEmail({
    accountId,
    toAddresses: "customer@example.com",
    ccAddresses: null,
    bccAddresses: null,
    subject: "Quarterly report",
    bodyHtml: "<p>See attached</p>",
    replyToMessageId: null,
    threadId: null,
    scheduledAt: NOW() - 5,
    signatureId: null,
    ...overrides,
  });
}

async function rowOf(id: string) {
  const rows = await db.select<{ status: string; attempts: number; last_error: string | null }[]>(
    "SELECT status, attempts, last_error FROM scheduled_emails WHERE id = $1",
    [id],
  );
  return rows[0]!;
}

async function statusOf(id: string) {
  return (await rowOf(id)).status;
}

beforeEach(async () => {
  db = createSqliteTestDb();
  await runMigrations();
  await seedAccounts();
  clearAllProviders();
  gmailSend.mockReset().mockResolvedValue({ id: "gmail-sent-1" });
  tauriInvoke.mockReset().mockImplementation(async (cmd: string) => {
    if (cmd === "smtp_send_email") return { success: true, message: "ok" };
    return undefined;
  });
  notifyFailed.mockReset();
  useUIStore.setState({ isOnline: true });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
});

describe("send later through the email provider abstraction", () => {
  it("sends a due scheduled email from a Gmail account via the Gmail API", async () => {
    const id = await scheduleDue("gmail-1", { threadId: "thread-9" });

    await processDueScheduledEmails();

    expect(gmailSend).toHaveBeenCalledTimes(1);
    const [raw, threadId] = gmailSend.mock.calls[0]!;
    expect(threadId).toBe("thread-9");
    const message = decodeRaw(raw);
    expect(message).toContain("From: me@gmail.com");
    expect(message).toContain("To: customer@example.com");
    expect(message).toContain("Subject: Quarterly report");
    expect(tauriInvoke).not.toHaveBeenCalledWith("smtp_send_email", expect.anything());
    expect(await statusOf(id)).toBe("sent");
  });

  it("sends a due scheduled email from an IMAP account via SMTP", async () => {
    const id = await scheduleDue("imap-1");

    await processDueScheduledEmails();

    const smtpCalls = tauriInvoke.mock.calls.filter(([cmd]) => cmd === "smtp_send_email");
    expect(smtpCalls).toHaveLength(1);
    const { config, rawEmail } = smtpCalls[0]![1] as { config: { host: string }; rawEmail: string };
    expect(config.host).toBe("smtp.fastmail.com");
    const message = decodeRaw(rawEmail);
    expect(message).toContain("From: me@fastmail.com");
    expect(message).toContain("Subject: Quarterly report");
    expect(gmailSend).not.toHaveBeenCalled();
    expect(await statusOf(id)).toBe("sent");
  });
});

describe("send-as alias chosen in the composer", () => {
  it("sends a Gmail scheduled email from the chosen alias, not the account address", async () => {
    const id = await scheduleDue("gmail-1", { fromEmail: "support@acme.com" });

    await processDueScheduledEmails();

    const message = decodeRaw(gmailSend.mock.calls[0]![0] as string);
    expect(headerOf(message, "From")).toBe("support@acme.com");
    expect(headerOf(message, "Message-ID")).toMatch(/@acme\.com>$/);
    expect(await statusOf(id)).toBe("sent");
  });

  it("sends an IMAP scheduled email from the chosen alias over SMTP", async () => {
    const id = await scheduleDue("imap-1", { fromEmail: "sales@fastmail.com" });

    await processDueScheduledEmails();

    const smtpCall = tauriInvoke.mock.calls.find(([cmd]) => cmd === "smtp_send_email")!;
    const message = decodeRaw((smtpCall[1] as { rawEmail: string }).rawEmail);
    expect(headerOf(message, "From")).toBe("sales@fastmail.com");
    expect(await statusOf(id)).toBe("sent");
  });

  it("sends from the account address when no alias was chosen", async () => {
    await scheduleDue("gmail-1", { fromEmail: null });

    await processDueScheduledEmails();

    expect(headerOf(decodeRaw(gmailSend.mock.calls[0]![0] as string), "From")).toBe("me@gmail.com");
  });
});

describe("scheduled email attachments", () => {
  it("keeps each scheduled email's attachments when two are scheduled at once", async () => {
    const attachment = (filename: string) => ({
      filename,
      mimeType: "text/plain",
      content: Buffer.from(`contents of ${filename}`).toString("base64"),
    });

    await Promise.all([
      scheduleDue("gmail-1", { subject: "Invoice", attachments: [attachment("invoice.txt")] }),
      scheduleDue("gmail-1", { subject: "Contract", attachments: [attachment("contract.txt")] }),
    ]);

    await processDueScheduledEmails();

    const sent = gmailSend.mock.calls.map(([raw]) => decodeRaw(raw as string));
    const invoice = sent.find((m) => m.includes("Subject: Invoice"))!;
    const contract = sent.find((m) => m.includes("Subject: Contract"))!;
    expect(invoice).toContain('filename="invoice.txt"');
    expect(invoice).not.toContain("contract.txt");
    expect(contract).toContain('filename="contract.txt"');
    expect(contract).not.toContain("invoice.txt");
  });
});

describe("scheduled email retries", () => {
  it("retries a failing send with growing backoff, then stops in a visible failed state", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = new Date("2026-10-14T09:00:00Z").getTime();
    vi.setSystemTime(start);
    gmailSend.mockRejectedValue(new Error("Gmail API error 503: backend unavailable"));
    const id = await scheduleDue("gmail-1");

    const runAt = async (secondsAfterStart: number) => {
      vi.setSystemTime(start + secondsAfterStart * 1000);
      await processDueScheduledEmails();
      return gmailSend.mock.calls.length;
    };

    expect(await runAt(0)).toBe(1);
    expect(await statusOf(id)).toBe("pending");
    // Backoff: 1 min, 5 min, 15 min, 1 h between attempts
    expect(await runAt(30)).toBe(1);
    expect(await runAt(61)).toBe(2);
    expect(await runAt(61 + 200)).toBe(2);
    expect(await runAt(61 + 301)).toBe(3);
    expect(await runAt(61 + 301 + 901)).toBe(4);
    expect(await runAt(61 + 301 + 901 + 3601)).toBe(5);

    const row = await rowOf(id);
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(5);
    expect(row.last_error).toContain("backend unavailable");
    expect(notifyFailed).toHaveBeenCalledTimes(1);
    expect(notifyFailed).toHaveBeenCalledWith("Quarterly report", expect.stringContaining("backend unavailable"));

    // Terminal: never retried again
    expect(await runAt(7 * 24 * 3600)).toBe(5);
  });

  it("fails at once, without retrying, when the email account no longer exists", async () => {
    const id = await scheduleDue("gmail-1");
    await db.execute("PRAGMA foreign_keys = OFF");
    await db.execute("DELETE FROM accounts WHERE id = 'gmail-1'");

    await processDueScheduledEmails();

    const row = await rowOf(id);
    expect(row.status).toBe("failed");
    expect(row.last_error).toMatch(/account/i);
    expect(notifyFailed).toHaveBeenCalledTimes(1);
  });
});

function headerOf(rawMessage: string, name: string): string {
  const match = rawMessage.match(new RegExp(`^${name}: (.*)$`, "mi"));
  return match![1]!.trim();
}

/** What a later sync stores when the sent message shows up in the mailbox. */
async function syncSentCopy(accountId: string, messageIdHeader: string) {
  await db.execute(
    "INSERT OR IGNORE INTO threads (id, account_id) VALUES ('thread-synced', $1)",
    [accountId],
  );
  await db.execute(
    "INSERT INTO messages (id, account_id, thread_id, date, message_id_header) VALUES ($1, $2, $3, $4, $5)",
    [`synced-${messageIdHeader}`, accountId, "thread-synced", Date.now(), messageIdHeader],
  );
}

describe("recovering scheduled emails interrupted by a crash", () => {
  it("does not resend an email left in sending when there is no sign it went out", async () => {
    const id = await scheduleDue("imap-1");
    // Velo dies while the SMTP server is still handling the message
    tauriInvoke.mockImplementation((cmd: string) =>
      cmd === "smtp_send_email" ? new Promise(() => {}) : Promise.resolve(undefined),
    );
    void processDueScheduledEmails();
    await vi.waitFor(() => expect(tauriInvoke).toHaveBeenCalledWith("smtp_send_email", expect.anything()));

    // Next start
    clearAllProviders();
    tauriInvoke.mockReset().mockResolvedValue({ success: true, message: "ok" });
    await recoverInterruptedScheduledSends();
    await processDueScheduledEmails();

    expect(tauriInvoke).not.toHaveBeenCalledWith("smtp_send_email", expect.anything());
    const row = await rowOf(id);
    expect(row.status).toBe("failed");
    expect(row.last_error).toMatch(/check your sent folder/i);
    expect(notifyFailed).toHaveBeenCalledTimes(1);
  });

  it("marks an email left in sending as sent when its sent copy has synced", async () => {
    const id = await scheduleDue("gmail-1");
    gmailSend.mockImplementation(() => new Promise(() => {}));
    void processDueScheduledEmails();
    await vi.waitFor(() => expect(gmailSend).toHaveBeenCalledTimes(1));
    const sentMessageId = headerOf(decodeRaw(gmailSend.mock.calls[0]![0] as string), "Message-ID");

    // Next start: Gmail had accepted it and the sync has since stored the sent copy
    clearAllProviders();
    await syncSentCopy("gmail-1", sentMessageId);
    gmailSend.mockReset().mockResolvedValue({ id: "again" });
    await recoverInterruptedScheduledSends();
    await processDueScheduledEmails();

    expect(gmailSend).not.toHaveBeenCalled();
    expect(await statusOf(id)).toBe("sent");
    expect(notifyFailed).not.toHaveBeenCalled();
  });

  it("does not send a retry when the earlier attempt actually went out", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = new Date("2026-10-14T09:00:00Z").getTime();
    vi.setSystemTime(start);
    const id = await scheduleDue("gmail-1");
    gmailSend.mockRejectedValueOnce(new Error("Request timeout"));
    await processDueScheduledEmails();
    const sentMessageId = headerOf(decodeRaw(gmailSend.mock.calls[0]![0] as string), "Message-ID");

    // The timed-out request had reached Gmail; the sync picked up the sent copy
    await syncSentCopy("gmail-1", sentMessageId);
    vi.setSystemTime(start + 61_000);
    await processDueScheduledEmails();

    expect(gmailSend).toHaveBeenCalledTimes(1);
    expect(await statusOf(id)).toBe("sent");
  });
});

describe("when Velo is offline", () => {
  it("keeps due emails waiting without using up retry attempts, then sends once back online", async () => {
    const id = await scheduleDue("gmail-1");
    useUIStore.setState({ isOnline: false });

    await processDueScheduledEmails();

    expect(gmailSend).not.toHaveBeenCalled();
    expect(await rowOf(id)).toMatchObject({ status: "pending", attempts: 0 });

    useUIStore.setState({ isOnline: true });
    await processDueScheduledEmails();
    expect(gmailSend).toHaveBeenCalledTimes(1);
    expect(await statusOf(id)).toBe("sent");
  });
});

describe("upgrading an existing database", () => {
  it("keeps scheduled emails created before the retry columns existed and still sends them", async () => {
    // Roll the schema back to v24, as an existing install has it
    for (const column of ["attempts", "next_attempt_at", "last_error", "from_email"]) {
      await db.execute(`ALTER TABLE scheduled_emails DROP COLUMN ${column}`);
    }
    await db.execute("DELETE FROM _migrations WHERE version >= 25");
    await db.execute(
      `INSERT INTO scheduled_emails (id, account_id, to_addresses, subject, body_html, scheduled_at, status)
       VALUES ('legacy-1', 'gmail-1', 'old@example.com', 'Written last week', '<p>hi</p>', $1, 'pending')`,
      [NOW() - 60],
    );

    await runMigrations();
    await processDueScheduledEmails();

    expect(gmailSend).toHaveBeenCalledTimes(1);
    expect(decodeRaw(gmailSend.mock.calls[0]![0] as string)).toContain("Subject: Written last week");
    expect(await statusOf("legacy-1")).toBe("sent");
  });
});

