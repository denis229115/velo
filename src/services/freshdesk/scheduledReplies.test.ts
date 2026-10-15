import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createSqliteTestDb, type SqliteTestDb } from "@/test/sqliteTestDb";
import { createFreshdeskFetchStub } from "@/test/freshdeskFetchStub";
import { ALPHA_HOST } from "./__fixtures__/freshdeskFixtures";
import { COLLEAGUE_ID, FIXTURE_NOW } from "./__fixtures__/freshdeskTicketFixtures";
import { alphaTenantWithHistory } from "./__fixtures__/freshdeskConversationFixtures";

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
// Mail goes out through Tauri commands (smtp_send_email) or the Gmail API; neither may be touched
const invoked = vi.hoisted(() => [] as string[]);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string) => {
    invoked.push(command);
    return null;
  }),
}));
const notified = vi.hoisted(() => [] as { title: string; body: string }[]);
vi.mock("@/services/notifications/notificationManager", () => ({
  notifyScheduledReplyHeld: vi.fn((subject: string, reasons: string[]) => notified.push({ title: "held", body: `${subject}: ${reasons.join(" ")}` })),
  notifyScheduledReplyFailed: vi.fn((subject: string, reason: string) => notified.push({ title: "failed", body: `${subject}: ${reason}` })),
}));

import { runMigrations } from "@/services/db/migrations";
import { classifyStatus, connectHelpdesk } from "./connection";
import { syncTickets } from "./ticketSync";
import { getOperationJournal } from "./ticketEdits";
import { loadTicketDraft, saveTicketDraft } from "./ticketDrafts";
import { listScheduledReplies, processDueScheduledReplies, scheduleTicketReply } from "./scheduledReplies";
import { useUIStore } from "@/stores/uiStore";

vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});

const HOUR_S = 3600;
const posts = () => stub.requests.filter((r) => r.method === "POST");
const writes = () => stub.requests.filter((r) => r.method !== "GET");
const later = (ms: number) => vi.setSystemTime(Date.now() + ms);
const nowS = () => Math.floor(Date.now() / 1000);

/** The operator writes a reply on ticket 1001 and schedules it an hour ahead */
async function scheduleReply(options: { thenStatusId?: string } = {}) {
  await saveTicketDraft("1001", "reply", { bodyHtml: "<p>We fixed your sign-in.</p>" });
  const scheduled = await scheduleTicketReply("1001", { sendAt: nowS() + HOUR_S, ...options });
  if (!scheduled.ok) throw new Error(scheduled.message);
  stub.requests.length = 0;
  return scheduled.id;
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXTURE_NOW);
  invoked.length = 0;
  notified.length = 0;
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
  vi.useRealTimers();
  db.close();
});

describe("a scheduled ticket reply", () => {
  it("waits until it is due, then goes out through Freshdesk's reply call and sends no mail", async () => {
    const id = await scheduleReply();

    await processDueScheduledReplies();
    expect(stub.requests).toEqual([]);

    later(HOUR_S * 1000);
    await processDueScheduledReplies();

    expect(posts().map((r) => new URL(r.url).pathname)).toEqual(["/api/v2/tickets/1001/reply"]);
    expect(String((posts()[0]!.body as { body: string }).body)).toContain("We fixed your sign-in.");
    expect(invoked.filter((c) => /smtp|gmail|imap/i.test(c))).toEqual([]);
    expect((await listScheduledReplies()).find((r) => r.id === id)).toMatchObject({ state: "sent", ticketId: "1001" });
  });
});

describe("holding a scheduled reply when the ticket changed (A26)", () => {
  const CUSTOMER_ID = 5000000001;
  it.each([
    ["the customer wrote", () => stub.addConversation(ALPHA_HOST, 1001, { user_id: CUSTOMER_ID, incoming: true, body: "<p>Any news?</p>" }), "The customer wrote."],
    ["a colleague replied", () => stub.addConversation(ALPHA_HOST, 1001, { user_id: COLLEAGUE_ID, body: "<p>I've got this one.</p>" }), "Fixture Colleague replied."],
    ["the ticket was reassigned", () => stub.editTicket(ALPHA_HOST, 1001, { responder_id: COLLEAGUE_ID }), "Reassigned to Fixture Colleague."],
    ["the ticket was closed", () => stub.editTicket(ALPHA_HOST, 1001, { status: 5 }), "Status changed to Closed."],
  ])("holds it when %s: nothing is sent, the text is kept, the reason shown and notified", async (_, change, reason) => {
    const id = await scheduleReply({ thenStatusId: "4" });
    later(30 * 60_000);
    change();
    later(30 * 60_000);

    await processDueScheduledReplies();

    expect(writes()).toEqual([]);
    const held = (await listScheduledReplies()).find((r) => r.id === id);
    expect(held).toMatchObject({ state: "held", holdReasons: [reason], bodyHtml: "<p>We fixed your sign-in.</p>" });
    expect(notified).toEqual([{ title: "held", body: `Fixture: cannot sign in: ${reason}` }]);

    // Held replies wait for the operator; later runs leave them alone
    later(HOUR_S * 1000);
    await processDueScheduledReplies();
    expect(writes()).toEqual([]);
  });
});

describe("the status to set after a scheduled reply (A26)", () => {
  const dropped = (apply: boolean) =>
    stub.respondOnce(ALPHA_HOST, "/api/v2/tickets/1001/reply", { method: "POST", networkError: true, apply });
  const writeLog = () => writes().map((r) => `${r.method} ${new URL(r.url).pathname}`);

  it("is set once the reply is confirmed sent, as a second journalled operation", async () => {
    const id = await scheduleReply({ thenStatusId: "4" });
    later(HOUR_S * 1000);

    await processDueScheduledReplies();

    expect(writeLog()).toEqual(["POST /api/v2/tickets/1001/reply", "PUT /api/v2/tickets/1001"]);
    expect(writes()[1]!.body).toEqual({ status: 4 });
    expect((await getOperationJournal("1001")).map((e) => [e.operation, e.outcome])).toEqual([
      ["send_reply", "confirmed"],
      ["update_ticket", "confirmed"],
    ]);
    expect((await listScheduledReplies()).find((r) => r.id === id)).toMatchObject({ state: "sent", statusProblem: null });
  });

  it("is not set while the send is Unconfirmed; reconciliation finds the reply, then sets it, never posting again", async () => {
    const id = await scheduleReply({ thenStatusId: "4" });
    later(HOUR_S * 1000);
    dropped(true);

    await processDueScheduledReplies();
    expect(writeLog()).toEqual(["POST /api/v2/tickets/1001/reply"]);
    expect((await listScheduledReplies()).find((r) => r.id === id)).toMatchObject({ state: "unconfirmed" });

    later(60_000);
    await processDueScheduledReplies();

    expect(writeLog()).toEqual(["POST /api/v2/tickets/1001/reply", "PUT /api/v2/tickets/1001"]);
    expect((await listScheduledReplies()).find((r) => r.id === id)).toMatchObject({ state: "sent" });
  });

  it("is never set when reconciliation shows the reply did not go out; the reply fails visibly and is not posted again", async () => {
    const id = await scheduleReply({ thenStatusId: "4" });
    later(HOUR_S * 1000);
    dropped(false);

    await processDueScheduledReplies();
    later(60_000);
    await processDueScheduledReplies();
    later(HOUR_S * 1000);
    await processDueScheduledReplies();

    expect(writeLog()).toEqual(["POST /api/v2/tickets/1001/reply"]);
    const failed = (await listScheduledReplies()).find((r) => r.id === id);
    expect(failed).toMatchObject({ state: "failed", bodyHtml: "<p>We fixed your sign-in.</p>" });
    expect(failed?.error).toMatch(/no record of this reply/);
    expect(notified.map((n) => n.title)).toEqual(["failed"]);
  });

  it("reports the reply sent and the status not set when Freshdesk rejects the status", async () => {
    const id = await scheduleReply({ thenStatusId: "4" });
    later(HOUR_S * 1000);
    stub.respondOnce(ALPHA_HOST, "/api/v2/tickets/1001", {
      method: "PUT",
      status: 400,
      body: { description: "Validation failed", errors: [{ field: "status", message: "Status is locked", code: "invalid_value" }] },
    });

    await processDueScheduledReplies();

    const sent = (await listScheduledReplies()).find((r) => r.id === id);
    expect(sent?.state).toBe("sent");
    expect(sent?.statusProblem).toMatch(/Status is locked/);
  });
});
