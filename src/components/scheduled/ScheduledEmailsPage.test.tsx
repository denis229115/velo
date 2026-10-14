import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
vi.mock("@/services/notifications/notificationManager", () => ({
  notifyScheduledSendFailed: vi.fn(),
}));

import { ScheduledEmailsPage } from "./ScheduledEmailsPage";
import { runMigrations } from "@/services/db/migrations";
import { insertScheduledEmail } from "@/services/db/scheduledEmails";
import { clearAllProviders } from "@/services/email/providerFactory";
import { useUIStore } from "@/stores/uiStore";
import { processDueScheduledEmails, recoverInterruptedScheduledSends } from "@/services/snooze/scheduledSendManager";

const IN_ONE_DAY = () => Math.floor(Date.now() / 1000) + 24 * 3600;

async function schedule(
  accountId: string,
  subject: string,
  overrides: Partial<Parameters<typeof insertScheduledEmail>[0]> = {},
) {
  return insertScheduledEmail({
    accountId,
    toAddresses: "customer@example.com",
    ccAddresses: null,
    bccAddresses: null,
    subject,
    bodyHtml: "<p>Hello</p>",
    replyToMessageId: null,
    threadId: null,
    scheduledAt: IN_ONE_DAY(),
    signatureId: null,
    ...overrides,
  });
}

async function setRow(id: string, fields: { status: string; last_error?: string | null; attempts?: number }) {
  await db.execute(
    "UPDATE scheduled_emails SET status = $1, last_error = $2, attempts = $3 WHERE id = $4",
    [fields.status, fields.last_error ?? null, fields.attempts ?? 0, id],
  );
}

/** The on-screen entry for one scheduled email, found by its subject. */
async function entryFor(subject: string): Promise<HTMLElement> {
  const title = await screen.findByText(subject);
  const entry = title.closest("li");
  if (!entry) throw new Error(`no entry for ${subject}`);
  return entry;
}

function decodeRaw(rawBase64Url: string): string {
  return Buffer.from(rawBase64Url.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function headerOf(rawMessage: string, name: string): string {
  return rawMessage.match(new RegExp(`^${name}: (.*)$`, "mi"))![1]!.trim();
}

beforeEach(async () => {
  db = createSqliteTestDb();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  await runMigrations();
  await db.execute(
    "INSERT INTO accounts (id, email, provider) VALUES ('gmail-1', 'me@gmail.com', 'gmail_api')",
  );
  await db.execute(
    `INSERT INTO accounts (id, email, provider, auth_method, imap_host, imap_port, imap_security,
       smtp_host, smtp_port, smtp_security, imap_password)
     VALUES ('imap-1', 'me@fastmail.com', 'imap', 'password', 'imap.fastmail.com', 993, 'ssl',
       'smtp.fastmail.com', 465, 'ssl', 'app-password')`,
  );
  clearAllProviders();
  gmailSend.mockReset().mockResolvedValue({ id: "gmail-sent-1" });
  tauriInvoke.mockReset().mockImplementation(async (cmd: string) =>
    cmd === "smtp_send_email" ? { success: true, message: "ok" } : undefined,
  );
  useUIStore.setState({ isOnline: true });
});

describe("Scheduled emails screen: list", () => {
  it("shows every scheduled email with its status, send time, email account and error", async () => {
    const sendAt = Date.parse("2026-10-15T07:00:00Z") / 1000;
    await schedule("gmail-1", "Quarterly report", { scheduledAt: sendAt });
    const failedId = await schedule("imap-1", "Contract renewal");
    await setRow(failedId, { status: "failed", last_error: "SMTP error: 554 mailbox unavailable", attempts: 5 });
    const sentId = await schedule("gmail-1", "Welcome aboard");
    await setRow(sentId, { status: "sent", attempts: 1 });
    const sendingId = await schedule("imap-1", "Invoice 42");
    await setRow(sendingId, { status: "sending", attempts: 1 });

    render(<ScheduledEmailsPage />);

    const pending = await entryFor("Quarterly report");
    expect(within(pending).getByText("Scheduled")).toBeInTheDocument();
    expect(within(pending).getByText("me@gmail.com")).toBeInTheDocument();
    expect(within(pending).getByText("customer@example.com", { exact: false })).toBeInTheDocument();
    expect(pending.querySelector("time")).toHaveAttribute("dateTime", "2026-10-15T07:00:00.000Z");

    const failed = await entryFor("Contract renewal");
    expect(within(failed).getByText("Failed")).toBeInTheDocument();
    expect(within(failed).getByText("me@fastmail.com")).toBeInTheDocument();
    expect(within(failed).getByText("SMTP error: 554 mailbox unavailable")).toBeInTheDocument();

    expect(within(await entryFor("Welcome aboard")).getByText("Sent")).toBeInTheDocument();
    expect(within(await entryFor("Invoice 42")).getByText("Sending")).toBeInTheDocument();
  });

  it("offers cancel only on pending emails and retry only on failed ones", async () => {
    await schedule("gmail-1", "Quarterly report");
    const failedId = await schedule("imap-1", "Contract renewal");
    await setRow(failedId, { status: "failed", last_error: "boom" });
    const sentId = await schedule("gmail-1", "Welcome aboard");
    await setRow(sentId, { status: "sent" });

    render(<ScheduledEmailsPage />);

    const pending = await entryFor("Quarterly report");
    expect(within(pending).getByRole("button", { name: /cancel/i })).toBeInTheDocument();
    expect(within(pending).queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
    const failed = await entryFor("Contract renewal");
    expect(within(failed).getByRole("button", { name: /retry/i })).toBeInTheDocument();
    expect(within(failed).queryByRole("button", { name: /cancel/i })).not.toBeInTheDocument();
    expect(within(await entryFor("Welcome aboard")).queryByRole("button")).not.toBeInTheDocument();
  });

  it("says so when nothing is scheduled", async () => {
    render(<ScheduledEmailsPage />);

    expect(await screen.findByText(/no scheduled emails/i)).toBeInTheDocument();
  });
});

describe("Scheduled emails screen: cancel", () => {
  it("removes a cancelled pending email, which is then never sent", async () => {
    await schedule("gmail-1", "Quarterly report", { scheduledAt: Math.floor(Date.now() / 1000) - 5 });
    render(<ScheduledEmailsPage />);

    fireEvent.click(within(await entryFor("Quarterly report")).getByRole("button", { name: /cancel/i }));

    await waitFor(() => expect(screen.queryByText("Quarterly report")).not.toBeInTheDocument());
    await processDueScheduledEmails();
    expect(gmailSend).not.toHaveBeenCalled();
    expect(await db.select("SELECT id FROM scheduled_emails")).toEqual([]);
  });

  it("keeps an email that started sending meanwhile and says it can no longer be cancelled", async () => {
    const id = await schedule("gmail-1", "Quarterly report");
    render(<ScheduledEmailsPage />);
    const entry = await entryFor("Quarterly report");
    // The background sender claims it while the screen is open
    await setRow(id, { status: "sending", attempts: 1 });

    fireEvent.click(within(entry).getByRole("button", { name: /cancel/i }));

    expect(await screen.findByText(/already sending/i)).toBeInTheDocument();
    expect(within(await entryFor("Quarterly report")).getByText("Sending")).toBeInTheDocument();
    expect(await db.select("SELECT status FROM scheduled_emails")).toEqual([{ status: "sending" }]);
  });
});

/** Leave a Gmail scheduled email failed the way a crash mid-send does; returns its id and sent Message-ID. */
async function failByCrashMidSend(subject: string) {
  const id = await schedule("gmail-1", subject, { scheduledAt: Math.floor(Date.now() / 1000) - 5 });
  gmailSend.mockImplementation(() => new Promise(() => {}));
  void processDueScheduledEmails();
  await waitFor(() => expect(gmailSend).toHaveBeenCalledTimes(1));
  const messageId = headerOf(decodeRaw(gmailSend.mock.calls[0]![0] as string), "Message-ID");
  // Next start
  clearAllProviders();
  gmailSend.mockReset().mockResolvedValue({ id: "gmail-sent-2" });
  await recoverInterruptedScheduledSends();
  return { id, messageId };
}

describe("Scheduled emails screen: retry", () => {
  it("sends a failed email once, with the same Message-ID, and shows it sent", async () => {
    const { messageId } = await failByCrashMidSend("Quarterly report");
    render(<ScheduledEmailsPage />);
    const entry = await entryFor("Quarterly report");
    expect(within(entry).getByText(/check your sent folder/i)).toBeInTheDocument();

    fireEvent.click(within(entry).getByRole("button", { name: /retry/i }));

    await waitFor(async () => expect(within(await entryFor("Quarterly report")).getByText("Sent")).toBeInTheDocument());
    expect(gmailSend).toHaveBeenCalledTimes(1);
    expect(headerOf(decodeRaw(gmailSend.mock.calls[0]![0] as string), "Message-ID")).toBe(messageId);
    expect(screen.queryByText(/check your sent folder/i)).not.toBeInTheDocument();
  });

  it("sends only once when Retry is pressed twice", async () => {
    const id = await schedule("imap-1", "Contract renewal");
    await setRow(id, { status: "failed", last_error: "SMTP timeout", attempts: 5 });
    render(<ScheduledEmailsPage />);
    const retry = within(await entryFor("Contract renewal")).getByRole("button", { name: /retry/i });

    fireEvent.click(retry);
    fireEvent.click(retry);

    await waitFor(async () => expect(within(await entryFor("Contract renewal")).getByText("Sent")).toBeInTheDocument());
    expect(tauriInvoke.mock.calls.filter(([cmd]) => cmd === "smtp_send_email")).toHaveLength(1);
  });

  it("shows the new error when the retry fails, and does not try again by itself", async () => {
    const id = await schedule("gmail-1", "Quarterly report", { scheduledAt: Math.floor(Date.now() / 1000) - 5 });
    await setRow(id, { status: "failed", last_error: "Gmail API error 503", attempts: 5 });
    gmailSend.mockRejectedValue(new Error("Gmail API error 401: invalid credentials"));
    render(<ScheduledEmailsPage />);

    fireEvent.click(within(await entryFor("Quarterly report")).getByRole("button", { name: /retry/i }));

    const entry = await entryFor("Quarterly report");
    expect(await within(entry).findByText("Gmail API error 401: invalid credentials")).toBeInTheDocument();
    expect(within(entry).getByText("Failed")).toBeInTheDocument();
    await processDueScheduledEmails();
    expect(gmailSend).toHaveBeenCalledTimes(1);
  });

  it("marks a failed email sent without sending again when its sent copy has synced", async () => {
    const { id, messageId } = await failByCrashMidSend("Quarterly report");
    // A later sync found the copy that did go out
    await db.execute("INSERT INTO threads (id, account_id) VALUES ('t-sent', 'gmail-1')");
    await db.execute(
      "INSERT INTO messages (id, account_id, thread_id, date, message_id_header) VALUES ('m-sent', 'gmail-1', 't-sent', 0, $1)",
      [messageId],
    );
    render(<ScheduledEmailsPage />);

    fireEvent.click(within(await entryFor("Quarterly report")).getByRole("button", { name: /retry/i }));

    await waitFor(async () => expect(within(await entryFor("Quarterly report")).getByText("Sent")).toBeInTheDocument());
    expect(gmailSend).not.toHaveBeenCalled();
    expect(await db.select("SELECT status FROM scheduled_emails WHERE id = $1", [id])).toEqual([{ status: "sent" }]);
  });

  it("does not send while offline and says why", async () => {
    const id = await schedule("gmail-1", "Quarterly report");
    await setRow(id, { status: "failed", last_error: "boom", attempts: 5 });
    useUIStore.setState({ isOnline: false });
    render(<ScheduledEmailsPage />);

    fireEvent.click(within(await entryFor("Quarterly report")).getByRole("button", { name: /retry/i }));

    expect(await screen.findByText(/offline/i)).toBeInTheDocument();
    expect(gmailSend).not.toHaveBeenCalled();
    expect(within(await entryFor("Quarterly report")).getByText("Failed")).toBeInTheDocument();
  });
});

describe("Scheduled emails screen: staying current", () => {
  it("shows an email as sent once the background sender has sent it", async () => {
    await schedule("gmail-1", "Quarterly report", { scheduledAt: Math.floor(Date.now() / 1000) - 5 });
    render(<ScheduledEmailsPage />);
    expect(within(await entryFor("Quarterly report")).getByText("Scheduled")).toBeInTheDocument();

    await processDueScheduledEmails();

    await waitFor(async () => expect(within(await entryFor("Quarterly report")).getByText("Sent")).toBeInTheDocument());
  });
});
