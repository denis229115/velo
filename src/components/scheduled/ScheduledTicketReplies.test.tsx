import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createSqliteTestDb, type SqliteTestDb } from "@/test/sqliteTestDb";
import { createFreshdeskFetchStub } from "@/test/freshdeskFetchStub";
import { ALPHA_HOST } from "@/services/freshdesk/__fixtures__/freshdeskFixtures";
import { COLLEAGUE_ID, FIXTURE_NOW } from "@/services/freshdesk/__fixtures__/freshdeskTicketFixtures";
import { alphaTenantWithHistory } from "@/services/freshdesk/__fixtures__/freshdeskConversationFixtures";

let db: SqliteTestDb;
vi.mock("@tauri-apps/plugin-sql", () => ({
  default: {
    load: vi.fn(async () => ({
      select: (sql: string, params?: unknown[]) => db.select(sql, params),
      execute: (sql: string, params?: unknown[]) => db.execute(sql, params),
    })),
  },
}));
vi.mock("@/utils/crypto", () => ({
  encryptValue: vi.fn(async (v: string) => `enc:${v}`),
  decryptValue: vi.fn(async (v: string) => v.slice(4)),
  isEncrypted: vi.fn((v: string) => v.startsWith("enc:")),
}));
const ALPHA_KEY = "fixture-key-alpha-0001";
let stub: ReturnType<typeof createFreshdeskFetchStub>;
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (input: string, init?: RequestInit) => stub.fetch(input, init),
}));
vi.mock("@/services/notifications/notificationManager", () => ({
  notifyScheduledSendFailed: vi.fn(),
  notifyScheduledReplyHeld: vi.fn(),
  notifyScheduledReplyFailed: vi.fn(),
}));
const navigateToTicket = vi.hoisted(() => vi.fn());
vi.mock("@/router/navigate", () => ({ navigateToTicket }));

import { runMigrations } from "@/services/db/migrations";
import { insertScheduledEmail } from "@/services/db/scheduledEmails";
import { classifyStatus, connectHelpdesk } from "@/services/freshdesk/connection";
import { syncTickets } from "@/services/freshdesk/ticketSync";
import { loadTicketDraft, saveTicketDraft } from "@/services/freshdesk/ticketDrafts";
import { listScheduledReplies, processDueScheduledReplies, scheduleTicketReply } from "@/services/freshdesk/scheduledReplies";
import { useUIStore } from "@/stores/uiStore";
import { ScheduledEmailsPage } from "./ScheduledEmailsPage";

vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});

const HOUR_S = 3600;
const later = (ms: number) => vi.setSystemTime(Date.now() + ms);
const nowS = () => Math.floor(Date.now() / 1000);
const writes = () => stub.requests.filter((r) => r.method !== "GET");

async function scheduleReply() {
  await saveTicketDraft("1001", "reply", { bodyHtml: "<p>We fixed your sign-in.</p>" });
  const scheduled = await scheduleTicketReply("1001", { sendAt: nowS() + HOUR_S, thenStatusId: "4" });
  if (!scheduled.ok) throw new Error(scheduled.message);
  return scheduled.id;
}

/** A reply that fell due after a colleague answered the ticket */
async function heldReply() {
  const id = await scheduleReply();
  later(60_000);
  stub.addConversation(ALPHA_HOST, 1001, { user_id: COLLEAGUE_ID, body: "<p>I've got this one.</p>" });
  later(HOUR_S * 1000);
  await processDueScheduledReplies();
  stub.requests.length = 0;
  return id;
}

async function entryFor(title: string): Promise<HTMLElement> {
  const entry = (await screen.findByText(title)).closest("li");
  if (!entry) throw new Error(`no entry for ${title}`);
  return entry;
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXTURE_NOW);
  navigateToTicket.mockReset();
  db = createSqliteTestDb();
  stub = createFreshdeskFetchStub({ [ALPHA_HOST]: { apiKey: ALPHA_KEY, tenant: alphaTenantWithHistory } });
  await runMigrations();
  useUIStore.setState({ isOnline: true });
  await connectHelpdesk({ host: ALPHA_HOST, apiKey: ALPHA_KEY });
  for (const [id, cls] of [["2", "open"], ["3", "waiting"], ["4", "done"], ["5", "done"], ["6", "open"]] as const) {
    await classifyStatus(id, cls);
  }
  await syncTickets({ trigger: "manual" });
  stub.requests.length = 0;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  db.close();
});

describe("scheduled ticket replies on the Scheduled screen", () => {
  it("are listed next to scheduled emails, each kind on its own", async () => {
    await db.execute("INSERT INTO accounts (id, email, provider) VALUES ('gmail-1', 'me@gmail.com', 'gmail_api')");
    await insertScheduledEmail({
      accountId: "gmail-1",
      toAddresses: "customer@example.com",
      ccAddresses: null,
      bccAddresses: null,
      subject: "Quarterly report",
      bodyHtml: "<p>Hello</p>",
      replyToMessageId: null,
      threadId: null,
      scheduledAt: nowS() + 2 * HOUR_S,
      signatureId: null,
    });
    await scheduleReply();

    render(<ScheduledEmailsPage />);

    const emails = within(await screen.findByRole("region", { name: "Scheduled emails" }));
    expect(await emails.findByText("Quarterly report")).toBeInTheDocument();
    const replies = within(screen.getByRole("region", { name: "Scheduled ticket replies" }));
    const reply = within(await entryFor("Fixture: cannot sign in"));
    expect(replies.getByText("Fixture: cannot sign in")).toBeInTheDocument();
    expect(reply.getByText("Scheduled")).toBeInTheDocument();
    expect(reply.getByText(/Freshdesk · #1001/)).toBeInTheDocument();
    expect(reply.getByText(/Then set Resolved/)).toBeInTheDocument();
    expect(reply.getByRole("button", { name: "Edit" })).toBeEnabled();
    expect(reply.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it("shows a held reply with its reason and lets the operator send it anyway", async () => {
    await heldReply();
    render(<ScheduledEmailsPage />);
    const reply = within(await entryFor("Fixture: cannot sign in"));

    expect(reply.getByText("On hold – ticket changed")).toBeInTheDocument();
    expect(reply.getByText("Fixture Colleague replied.")).toBeInTheDocument();
    fireEvent.click(reply.getByRole("button", { name: "Send anyway" }));

    expect(await reply.findByText("Sent")).toBeInTheDocument();
    expect(writes().map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      "POST /api/v2/tickets/1001/reply",
      "PUT /api/v2/tickets/1001",
    ]);
  });

  it("moves a held reply back into the ticket's draft to edit, and opens the ticket", async () => {
    await heldReply();
    render(<ScheduledEmailsPage />);
    const reply = within(await entryFor("Fixture: cannot sign in"));

    fireEvent.click(reply.getByRole("button", { name: "Edit" }));

    await waitFor(() => expect(navigateToTicket).toHaveBeenCalledWith("1001"));
    expect((await loadTicketDraft("1001", "reply"))?.bodyHtml).toBe("<p>We fixed your sign-in.</p>");
    await waitFor(() => expect(screen.queryByText("Fixture: cannot sign in")).not.toBeInTheDocument());
  });

  it("cancels a held reply", async () => {
    await heldReply();
    render(<ScheduledEmailsPage />);
    const reply = within(await entryFor("Fixture: cannot sign in"));

    fireEvent.click(reply.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByText("Fixture: cannot sign in")).not.toBeInTheDocument());
    expect(await listScheduledReplies()).toEqual([]);
    expect(writes()).toEqual([]);
  });

  it("turns Send anyway off while offline, with the reason; nothing is queued", async () => {
    await heldReply();
    render(<ScheduledEmailsPage />);
    const reply = within(await entryFor("Fixture: cannot sign in"));

    act(() => useUIStore.setState({ isOnline: false }));

    expect(reply.getByRole("button", { name: "Send anyway" })).toBeDisabled();
    expect(reply.getByRole("button", { name: "Send anyway" })).toHaveAttribute("title", "Needs a connection to Freshdesk");
    expect(reply.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });
});
