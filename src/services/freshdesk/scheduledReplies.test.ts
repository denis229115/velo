import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createSqliteTestDb, type SqliteTestDb } from "@/test/sqliteTestDb";
import { createFreshdeskFetchStub } from "@/test/freshdeskFetchStub";
import { ALPHA_HOST, BETA_HOST, betaTenant } from "./__fixtures__/freshdeskFixtures";
import { COLLEAGUE_ID, FIXTURE_NOW, ME_ID } from "./__fixtures__/freshdeskTicketFixtures";
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
const BETA_KEY = "fixture-key-beta-0002";
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
import { moveScheduledReply } from "@/services/db/freshdeskScheduledReplies";
import { startJournalEntry } from "@/services/db/freshdeskJournal";
import { classifyStatus, connectHelpdesk, currentTenantId } from "./connection";
import { syncTickets } from "./ticketSync";
import { getOperationJournal } from "./ticketEdits";
import { attachToTicketDraft, loadTicketDraft, saveTicketDraft } from "./ticketDrafts";
import {
  cancelScheduledReply,
  checkScheduledReply,
  editScheduledReply,
  listScheduledReplies,
  MAX_ATTEMPTS,
  processDueScheduledReplies,
  recoverInterruptedScheduledReplies,
  scheduleTicketReply,
  sendScheduledReplyNow,
} from "./scheduledReplies";
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
  stub = createFreshdeskFetchStub({
    [ALPHA_HOST]: { apiKey: ALPHA_KEY, tenant: alphaTenantWithHistory },
    [BETA_HOST]: { apiKey: BETA_KEY, tenant: betaTenant },
  });
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

describe("a reply already sent on the ticket since scheduling", () => {
  it("holds the scheduled reply even when I sent it myself, so the customer cannot get two answers", async () => {
    const id = await scheduleReply();
    later(30 * 60_000);
    stub.addConversation(ALPHA_HOST, 1001, { user_id: ME_ID, body: "<p>Quick answer from the web app.</p>" });
    later(30 * 60_000);

    await processDueScheduledReplies();

    expect(writes()).toEqual([]);
    expect((await listScheduledReplies()).find((r) => r.id === id)).toMatchObject({
      state: "held",
      holdReasons: ["A reply was already sent since you scheduled this."],
    });
  });

  it("does not hold it for my own internal note alone", async () => {
    const id = await scheduleReply();
    later(30 * 60_000);
    stub.addConversation(ALPHA_HOST, 1001, { user_id: ME_ID, private: true, source: 2, body: "<p>Note to self</p>" });
    later(30 * 60_000);

    await processDueScheduledReplies();

    expect(posts().map((r) => new URL(r.url).pathname)).toEqual(["/api/v2/tickets/1001/reply"]);
    expect((await listScheduledReplies()).find((r) => r.id === id)).toMatchObject({ state: "sent" });
  });

  it("sends once the operator chose Send anyway, having seen it", async () => {
    const id = await scheduleReply();
    later(30 * 60_000);
    stub.addConversation(ALPHA_HOST, 1001, { user_id: ME_ID, body: "<p>Quick answer from the web app.</p>" });
    later(30 * 60_000);
    await processDueScheduledReplies();
    later(60_000);

    expect(await sendScheduledReplyNow(id)).toBeNull();
    expect((await listScheduledReplies()).find((r) => r.id === id)).toMatchObject({ state: "sent" });
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

describe("a scheduled reply due while offline", () => {
  it("waits without using up attempts, then checks the ticket again before sending once online", async () => {
    const id = await scheduleReply();
    later(HOUR_S * 1000);
    useUIStore.setState({ isOnline: false });

    for (let i = 0; i < 8; i++) {
      await processDueScheduledReplies();
      later(HOUR_S * 1000);
    }
    expect(stub.requests).toEqual([]);
    expect((await listScheduledReplies()).find((r) => r.id === id)).toMatchObject({ state: "pending", error: null });

    stub.addConversation(ALPHA_HOST, 1001, { user_id: 5000000001, incoming: true, body: "<p>Hello?</p>" });
    useUIStore.setState({ isOnline: true });
    await processDueScheduledReplies();

    expect(stub.requests.map((r) => `${r.method} ${new URL(r.url).pathname}`)[0]).toBe("GET /api/v2/tickets/1001");
    expect(writes()).toEqual([]);
    expect((await listScheduledReplies()).find((r) => r.id === id)).toMatchObject({ state: "held", holdReasons: ["The customer wrote."] });
  });
});

describe("the operator deciding about a held reply", () => {
  async function heldReply() {
    const id = await scheduleReply();
    later(60_000);
    stub.addConversation(ALPHA_HOST, 1001, { user_id: COLLEAGUE_ID, body: "<p>I've got this one.</p>" });
    later(HOUR_S * 1000);
    await processDueScheduledReplies();
    stub.requests.length = 0;
    return id;
  }
  const reply = async (id: string) => (await listScheduledReplies()).find((r) => r.id === id);

  it("sends it anyway, having seen the change", async () => {
    const id = await heldReply();

    expect(await sendScheduledReplyNow(id)).toBeNull();

    expect(posts().map((r) => new URL(r.url).pathname)).toEqual(["/api/v2/tickets/1001/reply"]);
    expect(await reply(id)).toMatchObject({ state: "sent" });
  });

  it("holds it again instead when the ticket changed once more since it was held", async () => {
    const id = await heldReply();
    later(60_000);
    stub.addConversation(ALPHA_HOST, 1001, { user_id: 5000000001, incoming: true, body: "<p>Hello?</p>" });

    expect(await sendScheduledReplyNow(id)).toMatch(/changed again/);

    expect(writes()).toEqual([]);
    expect(await reply(id)).toMatchObject({ state: "held", holdReasons: ["The customer wrote."] });
  });

  it("moves it back into the ticket's reply draft to edit, removing it from the schedule", async () => {
    const id = await heldReply();

    expect(await editScheduledReply(id)).toEqual({ ok: true, ticketId: "1001" });

    expect((await loadTicketDraft("1001", "reply"))?.bodyHtml).toBe("<p>We fixed your sign-in.</p>");
    expect(await reply(id)).toBeUndefined();
  });

  it("does not overwrite a reply draft the operator started meanwhile", async () => {
    const id = await heldReply();
    await saveTicketDraft("1001", "reply", { bodyHtml: "<p>A newer thought.</p>" });

    expect(await editScheduledReply(id)).toMatchObject({ ok: false });

    expect((await loadTicketDraft("1001", "reply"))?.bodyHtml).toBe("<p>A newer thought.</p>");
    expect(await reply(id)).toMatchObject({ state: "held" });
  });

  it("cancels it: nothing is sent, ever", async () => {
    const id = await heldReply();

    expect(await cancelScheduledReply(id)).toBe(true);
    later(HOUR_S * 1000);
    await processDueScheduledReplies();

    expect(await reply(id)).toBeUndefined();
    expect(writes()).toEqual([]);
  });

  it("cannot send it while offline; nothing is queued", async () => {
    const id = await heldReply();
    useUIStore.setState({ isOnline: false });

    expect(await sendScheduledReplyNow(id)).toMatch(/connection/);
    useUIStore.setState({ isOnline: true });
    later(HOUR_S * 1000);
    await processDueScheduledReplies();

    expect(stub.requests).toEqual([]);
    expect(await reply(id)).toMatchObject({ state: "held" });
  });
});

describe("changing a pending scheduled reply", () => {
  it("can be cancelled or moved back to the draft before it is due", async () => {
    const first = await scheduleReply();
    expect(await editScheduledReply(first)).toEqual({ ok: true, ticketId: "1001" });
    const second = await scheduleReply();
    expect(await cancelScheduledReply(second)).toBe(true);

    later(HOUR_S * 1000);
    await processDueScheduledReplies();

    expect(await listScheduledReplies()).toEqual([]);
    expect(writes()).toEqual([]);
  });
});

describe("a scheduled reply Freshdesk keeps rate limiting", () => {
  it("is tried a bounded number of times with backoff, then fails visibly and is not tried again", async () => {
    const id = await scheduleReply();
    for (let i = 0; i < MAX_ATTEMPTS + 2; i++) {
      stub.respondOnce(ALPHA_HOST, "/api/v2/tickets/1001/reply", { method: "POST", status: 429, body: {} });
    }
    later(HOUR_S * 1000);

    await processDueScheduledReplies();
    await processDueScheduledReplies(); // still backing off
    expect(posts()).toHaveLength(1);
    for (let i = 0; i < 10; i++) {
      later(2 * HOUR_S * 1000);
      await processDueScheduledReplies();
    }

    expect(posts()).toHaveLength(MAX_ATTEMPTS);
    expect((await listScheduledReplies()).find((r) => r.id === id)).toMatchObject({ state: "failed" });
    expect(notified.map((n) => n.title)).toEqual(["failed"]);
  });
});

describe.each([false, true])("scheduled send errors (with files: %s)", (withFiles) => {
  async function dueReply() {
    await saveTicketDraft("1001", "reply", { bodyHtml: "<p>We fixed your sign-in.</p>" });
    if (withFiles) {
      await attachToTicketDraft("1001", "reply", { name: "report.csv", contentType: "text/csv", dataBase64: btoa("a,b") });
    }
    const scheduled = await scheduleTicketReply("1001", { sendAt: nowS() + HOUR_S });
    if (!scheduled.ok) throw new Error(scheduled.message);
    stub.requests.length = 0;
    later(HOUR_S * 1000);
    return scheduled.id;
  }

  it.each([500, 502, 503, "dropped"] as const)("reconciles an accepted send after %s without a second POST", async (status) => {
    const id = await dueReply();
    stub.respondOnce(ALPHA_HOST, "/api/v2/tickets/1001/reply", {
      method: "POST", apply: true,
      ...(status === "dropped" ? { networkError: true } : { status, body: {} }),
    });

    await processDueScheduledReplies();

    expect((await listScheduledReplies()).find((r) => r.id === id)).toMatchObject({
      state: "unconfirmed", attachments: withFiles ? [{ name: "report.csv", size: 3 }] : [],
    });
    later(60_000);
    await processDueScheduledReplies();
    expect((await listScheduledReplies()).find((r) => r.id === id)).toMatchObject({ state: "sent", attachments: [] });
    expect(posts()).toHaveLength(1);
  });

  it.each([500, 502, 503])("requires operator action after HTTP %i when reconciliation finds no stored reply", async (status) => {
    const id = await dueReply();
    stub.respondOnce(ALPHA_HOST, "/api/v2/tickets/1001/reply", { method: "POST", status, body: {} });

    await processDueScheduledReplies();
    expect((await listScheduledReplies()).find((r) => r.id === id)?.state).toBe("unconfirmed");
    later(60_000);
    await processDueScheduledReplies();
    expect((await listScheduledReplies()).find((r) => r.id === id)).toMatchObject({
      state: "failed", error: expect.stringContaining("no record of this reply"),
      attachments: withFiles ? [{ name: "report.csv", size: 3 }] : [],
    });
    later(2 * HOUR_S * 1000);
    await processDueScheduledReplies();
    expect(posts()).toHaveLength(1);
  });

  it("keeps a rate-limited reply and waits at least Retry-After before trying again", async () => {
    const id = await dueReply();
    stub.respondOnce(ALPHA_HOST, "/api/v2/tickets/1001/reply", {
      method: "POST", status: 429, body: { message: "Too many requests" }, headers: { "Retry-After": "7200" },
    });

    await processDueScheduledReplies();

    expect((await listScheduledReplies()).find((r) => r.id === id)).toMatchObject({
      state: "pending", error: expect.stringMatching(/Too many requests.*120 minutes/),
      attachments: withFiles ? [{ name: "report.csv", size: 3 }] : [],
    });
    later(7_199_000);
    await processDueScheduledReplies();
    expect(posts()).toHaveLength(1);
    later(1_000);
    await processDueScheduledReplies();
    expect(posts()).toHaveLength(2);
    expect((await listScheduledReplies()).find((r) => r.id === id)?.state).toBe("sent");
  });

  it("keeps a rejected 400 reply for correction, with field errors, without automatically trying it again", async () => {
    const id = await dueReply();
    stub.respondOnce(ALPHA_HOST, "/api/v2/tickets/1001/reply", {
      method: "POST", status: 400,
      body: { description: "Validation failed", errors: [{ field: "cc_emails", message: "It should be a valid email", code: "invalid_value" }] },
    });

    await processDueScheduledReplies();

    expect((await listScheduledReplies()).find((r) => r.id === id)).toMatchObject({
      state: "failed", error: expect.stringContaining("cc_emails: It should be a valid email"),
      bodyHtml: "<p>We fixed your sign-in.</p>",
      attachments: withFiles ? [{ name: "report.csv", size: 3 }] : [],
    });
    later(2 * HOUR_S * 1000);
    await processDueScheduledReplies();
    expect(posts()).toHaveLength(1);
  });
});

describe("a scheduled reply interrupted by a crash or quit while sending", () => {
  /** The background run took the reply, then Velo stopped */
  async function interrupted(options: { postStarted: boolean }) {
    const id = await scheduleReply();
    later(HOUR_S * 1000);
    const claimedAt = Math.floor(Date.now() / 1000);
    await moveScheduledReply(id, ["pending"], "sending", { claimedAt, attempts: 1 });
    // What the send journals just before it posts
    const record = { mode: "reply", sentAfter: claimedAt, fingerprint: "Wefixedyoursign-in.", ccEmails: [], thenStatusId: null };
    if (options.postStarted) await startJournalEntry(await currentTenantId(), "1001", "send_reply", record);
    return id;
  }

  it("is sent normally when it never reached Freshdesk", async () => {
    const id = await interrupted({ postStarted: false });

    await recoverInterruptedScheduledReplies();
    await processDueScheduledReplies();

    expect(posts()).toHaveLength(1);
    expect((await listScheduledReplies()).find((r) => r.id === id)).toMatchObject({ state: "sent" });
  });

  it("is Unconfirmed when its send had started, and reconciliation finds it without posting again", async () => {
    const id = await interrupted({ postStarted: true });
    stub.addConversation(ALPHA_HOST, 1001, { user_id: ME_ID, body: "<p>We fixed your sign-in.</p>" });

    await recoverInterruptedScheduledReplies();
    expect((await listScheduledReplies()).find((r) => r.id === id)).toMatchObject({ state: "unconfirmed" });
    await processDueScheduledReplies();

    expect(posts()).toEqual([]);
    expect((await listScheduledReplies()).find((r) => r.id === id)).toMatchObject({ state: "sent" });
  });
});

describe("the operator checking an Unconfirmed scheduled reply", () => {
  it("reads Freshdesk now and settles it, never posting again", async () => {
    const id = await scheduleReply();
    later(HOUR_S * 1000);
    stub.respondOnce(ALPHA_HOST, "/api/v2/tickets/1001/reply", { method: "POST", networkError: true, apply: true });
    await processDueScheduledReplies();

    expect(await checkScheduledReply(id)).toBeNull();

    expect(posts()).toHaveLength(1);
    expect((await listScheduledReplies()).find((r) => r.id === id)).toMatchObject({ state: "sent" });
  });
});

describe("a scheduled reply with attachments (#34)", () => {
  const sentFiles = () => posts().map((r) => (r.body as { attachments?: { name: string }[] }).attachments?.map((a) => a.name));

  async function scheduleWithFile() {
    await saveTicketDraft("1001", "reply", { bodyHtml: "<p>The report is attached.</p>" });
    await attachToTicketDraft("1001", "reply", { name: "report.csv", contentType: "text/csv", dataBase64: btoa("a,b\n1,2") });
    const scheduled = await scheduleTicketReply("1001", { sendAt: nowS() + HOUR_S });
    if (!scheduled.ok) throw new Error(scheduled.message);
    stub.requests.length = 0;
    return scheduled.id;
  }

  it("keeps its files with the schedule and sends them with it when due", async () => {
    const id = await scheduleWithFile();
    expect(await loadTicketDraft("1001", "reply")).toBeNull();
    expect((await listScheduledReplies()).find((r) => r.id === id)?.attachments).toEqual([{ name: "report.csv", size: 7 }]);

    later(HOUR_S * 1000);
    await processDueScheduledReplies();

    expect(sentFiles()).toEqual([["report.csv"]]);
    expect((await listScheduledReplies()).find((r) => r.id === id)).toMatchObject({ state: "sent" });
  });

  it("takes its files back into the draft when moved back to edit", async () => {
    const id = await scheduleWithFile();

    expect(await editScheduledReply(id)).toEqual({ ok: true, ticketId: "1001" });

    expect((await loadTicketDraft("1001", "reply"))?.attachments.map((a) => a.name)).toEqual(["report.csv"]);
  });

  it("sends its files when the operator sends a held reply anyway", async () => {
    const id = await scheduleWithFile();
    later(60_000);
    stub.addConversation(ALPHA_HOST, 1001, { user_id: COLLEAGUE_ID, body: "<p>I had a look too.</p>" });
    later(HOUR_S * 1000);
    await processDueScheduledReplies();
    expect((await listScheduledReplies()).find((r) => r.id === id)).toMatchObject({ state: "held" });
    stub.requests.length = 0;

    expect(await sendScheduledReplyNow(id)).toBeNull();
    expect(sentFiles()).toEqual([["report.csv"]]);
  });
});

describe("switching helpdesks", () => {
  it("leaves no CC address of a scheduled reply behind after connecting a different helpdesk", async () => {
    await saveTicketDraft("1001", "reply", { bodyHtml: "<p>We fixed your sign-in.</p>", ccEmails: ["copied.person@example.test"] });
    const scheduled = await scheduleTicketReply("1001", { sendAt: nowS() + HOUR_S });
    expect(scheduled.ok).toBe(true);

    await connectHelpdesk({ host: BETA_HOST, apiKey: BETA_KEY });

    const rows = await db.select("SELECT * FROM freshdesk_scheduled_replies");
    expect(JSON.stringify(rows)).not.toContain("copied.person@example.test");
  });

  it("removes the old helpdesk's draft and scheduled files while keeping files when reconnecting the same helpdesk", async () => {
    const file = { name: "server.log", contentType: "text/plain", dataBase64: btoa("hello") };
    await saveTicketDraft("1001", "reply", { bodyHtml: "<p>Logs attached</p>" });
    await attachToTicketDraft("1001", "reply", file);
    expect((await scheduleTicketReply("1001", { sendAt: nowS() + HOUR_S })).ok).toBe(true);
    await attachToTicketDraft("1001", "note", file);

    await connectHelpdesk({ host: ALPHA_HOST, apiKey: ALPHA_KEY });
    expect((await loadTicketDraft("1001", "note"))?.attachments).toMatchObject([{ name: "server.log" }]);
    expect((await listScheduledReplies())[0]?.attachments).toEqual([{ name: "server.log", size: 5 }]);

    await connectHelpdesk({ host: BETA_HOST, apiKey: BETA_KEY });
    expect(await db.select("SELECT * FROM freshdesk_reply_attachments")).toEqual([]);
    await connectHelpdesk({ host: ALPHA_HOST, apiKey: ALPHA_KEY });
    await saveTicketDraft("1001", "note", { bodyHtml: "<p>New draft</p>" });
    expect((await loadTicketDraft("1001", "note"))?.attachments).toEqual([]);
  });
});


it.each(["move", "delete", "commit"])("rolls back the entire draft transfer if scheduling fails at %s", async (phase) => {
  await saveTicketDraft("1001", "reply", { bodyHtml: "<p>Keep this draft.</p>" });
  await attachToTicketDraft("1001", "reply", { name: "report.csv", contentType: "text/csv", dataBase64: btoa("a,b") });
  const draft = await loadTicketDraft("1001", "reply");
  if (phase !== "commit") {
    await db.execute(phase === "move"
      ? "CREATE TEMP TRIGGER fail_schedule BEFORE UPDATE OF owner ON freshdesk_reply_attachments BEGIN SELECT RAISE(ABORT, 'fixture transfer fault'); END"
      : "CREATE TEMP TRIGGER fail_schedule BEFORE DELETE ON freshdesk_ticket_drafts BEGIN SELECT RAISE(ABORT, 'fixture transfer fault'); END");
  }
  const execute = db.execute.bind(db);
  const fault = vi.spyOn(db, "execute").mockImplementation(async (sql, params) => {
    if (phase === "commit" && sql === "COMMIT") throw new Error("fixture commit fault");
    return execute(sql, params);
  });
  try {
    await expect(scheduleTicketReply("1001", { sendAt: nowS() })).rejects.toThrow(/fixture/);
  } finally { fault.mockRestore(); }
  expect(await listScheduledReplies()).toEqual([]);
  expect(await loadTicketDraft("1001", "reply")).toEqual(draft);
  await processDueScheduledReplies();
  expect(posts()).toEqual([]);
});
