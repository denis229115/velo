import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createSqliteTestDb, type SqliteTestDb } from "@/test/sqliteTestDb";
import { createFreshdeskFetchStub } from "@/test/freshdeskFetchStub";
import { ALPHA_HOST } from "./__fixtures__/freshdeskFixtures";
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

import { runMigrations } from "@/services/db/migrations";
import { classifyStatus, connectHelpdesk } from "./connection";
import { getTicketList, syncTickets } from "./ticketSync";
import { getOperationJournal } from "./ticketEdits";
import { getTicketHistory } from "./ticketHistory";
import { captureStalenessBaseline, reconcileTicketSend, sendTicketResponse, type StalenessBaseline } from "./ticketSend";
import { useUIStore } from "@/stores/uiStore";

vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});

const posts = () => stub.requests.filter((r) => r.method === "POST");
const writes = () => stub.requests.filter((r) => r.method !== "GET");
const later = (ms: number) => vi.setSystemTime(Date.now() + ms);

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXTURE_NOW);
  invoked.length = 0;
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

describe("sending a reply to the customer (A09)", () => {
  it("posts it through Freshdesk's reply call with the agent's signature, and sends no mail", async () => {
    const baseline = await captureStalenessBaseline("1001");
    later(60_000);

    const result = await sendTicketResponse({ ticketId: "1001", mode: "reply", bodyHtml: "<p>Fixed on our side.</p>", baseline });

    expect(result).toEqual({ outcome: "sent" });
    expect(posts()).toHaveLength(1);
    expect(posts()[0]!.url).toBe(`https://${ALPHA_HOST}/api/v2/tickets/1001/reply`);
    expect(posts()[0]!.body).toEqual({ body: "<p>Fixed on our side.</p><div>Fixture Operator</div>" });
    expect(stub.requests.every((r) => new URL(r.url).host === ALPHA_HOST)).toBe(true);
    expect(invoked.filter((c) => /smtp|gmail|imap/i.test(c))).toEqual([]);
  });
});

describe("CC addresses of a reply", () => {
  it("sends valid CC addresses in the reply call", async () => {
    const baseline = await captureStalenessBaseline("1001");

    const result = await sendTicketResponse({ ticketId: "1001", mode: "reply", bodyHtml: "<p>Hi</p>", ccEmails: ["boss@example.test", "team.lead@example.test"], baseline });

    expect(result).toEqual({ outcome: "sent" });
    expect(posts()[0]!.body).toMatchObject({ cc_emails: ["boss@example.test", "team.lead@example.test"] });
  });

  it("rejects text that is not an email address before anything is sent or even looked up", async () => {
    const baseline = await captureStalenessBaseline("1001");
    stub.requests.length = 0;

    const result = await sendTicketResponse({
      ticketId: "1001",
      mode: "reply",
      bodyHtml: "<p>Hi</p>",
      ccEmails: ["boss@example.test", "not an address", "a@example.test\r\nBcc: x@example.test"],
      baseline,
    });

    expect(result).toEqual({ outcome: "failed", message: expect.stringContaining("not an address") });
    expect(stub.requests).toEqual([]);
    expect((await getOperationJournal("1001")).map((e) => e.operation)).not.toContain("send_reply");
  });
});

describe("adding an internal note (A09)", () => {
  it("posts a private note through Freshdesk's notes call, without signature or CC", async () => {
    const baseline = await captureStalenessBaseline("1001");

    const result = await sendTicketResponse({
      ticketId: "1001",
      mode: "note",
      bodyHtml: "<p>Checked the logs.</p>",
      ccEmails: ["boss@example.test"],
      baseline,
    });

    expect(result).toEqual({ outcome: "sent" });
    expect(posts().map((r) => [r.url, r.body])).toEqual([
      [`https://${ALPHA_HOST}/api/v2/tickets/1001/notes`, { body: "<p>Checked the logs.</p>", private: true }],
    ]);
    expect((await getOperationJournal("1001")).map((e) => [e.operation, e.outcome])).toEqual([["add_note", "confirmed"]]);
  });
});

describe("after a send", () => {
  it("reads the conversation back so the reader shows it and Last answered moves", async () => {
    const baseline = await captureStalenessBaseline("1001");
    later(60_000);
    const sentAt = Date.now();

    await sendTicketResponse({ ticketId: "1001", mode: "reply", bodyHtml: "<p>All fixed.</p>", baseline });

    const history = await getTicketHistory("1001");
    expect(history?.entries.at(-1)).toMatchObject({ kind: "reply", visibility: "public", at: sentAt });
    const listed = (await getTicketList()).tickets.find((t) => t.id === "1001")!;
    expect(listed.activity.lastAnswered).toEqual({ state: "known", at: sentAt });
  });

  it("sanitises the editor HTML before it leaves Velo", async () => {
    const baseline = await captureStalenessBaseline("1001");

    await sendTicketResponse({
      ticketId: "1001",
      mode: "note",
      bodyHtml: `<p onclick="steal()">Hi<script>alert(1)</script></p>`,
      baseline,
    });

    expect(posts()[0]!.body).toEqual({ body: "<p>Hi</p>", private: true });
  });
});

describe("a send whose answer never arrives (A10)", () => {
  const dropped = (apply: boolean) =>
    stub.respondOnce(ALPHA_HOST, "/api/v2/tickets/1001/reply", { method: "POST", networkError: true, apply });

  it("is Unconfirmed, and reconciliation finds the reply Freshdesk did post without posting again", async () => {
    const baseline = await captureStalenessBaseline("1001");
    later(60_000);
    dropped(true);

    const sent = await sendTicketResponse({ ticketId: "1001", mode: "reply", bodyHtml: "<p>Fixed it.</p>", baseline });
    expect(sent).toMatchObject({ outcome: "unconfirmed" });
    expect((await getOperationJournal("1001")).map((e) => e.outcome)).toEqual(["unconfirmed"]);

    const reconciled = await reconcileTicketSend("1001", (sent as { entryId: number }).entryId);
    expect(reconciled).toEqual({ outcome: "sent" });
    expect(posts()).toHaveLength(1);
    expect((await getOperationJournal("1001")).map((e) => e.outcome)).toEqual(["confirmed"]);
    expect((await getTicketHistory("1001"))?.entries.at(-1)?.bodyText).toContain("Fixed it.");
  });

  it("is failed after reconciliation when Freshdesk has no such reply, and nothing is posted again", async () => {
    const baseline = await captureStalenessBaseline("1001");
    dropped(false);

    const sent = await sendTicketResponse({ ticketId: "1001", mode: "reply", bodyHtml: "<p>Fixed it.</p>", baseline });
    const reconciled = await reconcileTicketSend("1001", (sent as { entryId: number }).entryId);

    expect(reconciled).toMatchObject({ outcome: "failed" });
    expect(posts()).toHaveLength(1);
    expect((await getOperationJournal("1001")).map((e) => e.outcome)).toEqual(["failed"]);
  });

  it("stays Unconfirmed while Freshdesk cannot be read back", async () => {
    const baseline = await captureStalenessBaseline("1001");
    dropped(true);
    const sent = await sendTicketResponse({ ticketId: "1001", mode: "reply", bodyHtml: "<p>Fixed it.</p>", baseline });
    stub.respondOnce(ALPHA_HOST, "/api/v2/tickets/1001", { method: "GET", networkError: true });

    const reconciled = await reconcileTicketSend("1001", (sent as { entryId: number }).entryId);

    expect(reconciled).toMatchObject({ outcome: "unconfirmed" });
    expect(posts()).toHaveLength(1);
  });

  it("does not take someone else's identical reply for mine", async () => {
    const baseline = await captureStalenessBaseline("1001");
    dropped(false);
    const sent = await sendTicketResponse({ ticketId: "1001", mode: "reply", bodyHtml: "<p>Fixed it.</p>", baseline });
    stub.addConversation(ALPHA_HOST, 1001, { user_id: COLLEAGUE_ID, body: "<p>Fixed it.</p>" });

    expect(await reconcileTicketSend("1001", (sent as { entryId: number }).entryId)).toMatchObject({ outcome: "failed" });
  });
});

describe("the Staleness check (A11)", () => {
  it("warns before anything is sent when a colleague replied since the draft started", async () => {
    const baseline = await captureStalenessBaseline("1001");
    later(60_000);
    stub.addConversation(ALPHA_HOST, 1001, { user_id: COLLEAGUE_ID, body: "<p>I've got this one.</p>" });

    const result = await sendTicketResponse({ ticketId: "1001", mode: "reply", bodyHtml: "<p>Hi</p>", baseline });

    expect(result).toMatchObject({ outcome: "stale", changes: ["Fixture Colleague replied."] });
    expect(writes()).toEqual([]);
  });

  it("warns when the ticket was reassigned or the customer wrote meanwhile", async () => {
    const baseline = await captureStalenessBaseline("1001");
    later(60_000);
    stub.editTicket(ALPHA_HOST, 1001, { responder_id: COLLEAGUE_ID });
    stub.addConversation(ALPHA_HOST, 1001, { user_id: 5000000001, incoming: true, body: "<p>Any news?</p>" });

    const result = await sendTicketResponse({ ticketId: "1001", mode: "note", bodyHtml: "<p>Hi</p>", baseline });

    expect(result).toMatchObject({
      outcome: "stale",
      changes: ["Reassigned to Fixture Colleague.", "The customer wrote."],
    });
    expect(writes()).toEqual([]);
  });

  it("sends once the operator has seen the change (with the fresh baseline)", async () => {
    const baseline = await captureStalenessBaseline("1001");
    later(60_000);
    stub.addConversation(ALPHA_HOST, 1001, { user_id: COLLEAGUE_ID, body: "<p>I've got this one.</p>" });
    const stale = await sendTicketResponse({ ticketId: "1001", mode: "reply", bodyHtml: "<p>Hi</p>", baseline });

    const result = await sendTicketResponse({
      ticketId: "1001",
      mode: "reply",
      bodyHtml: "<p>Hi</p>",
      baseline: (stale as { baseline: StalenessBaseline }).baseline,
    });

    expect(result).toEqual({ outcome: "sent" });
    expect(posts()).toHaveLength(1);
  });

  it("does not warn about my own activity", async () => {
    const baseline = await captureStalenessBaseline("1001");
    later(60_000);
    stub.addConversation(ALPHA_HOST, 1001, { user_id: ME_ID, private: true, source: 2, body: "<p>Note to self</p>" });

    expect(await sendTicketResponse({ ticketId: "1001", mode: "reply", bodyHtml: "<p>Hi</p>", baseline })).toEqual({
      outcome: "sent",
    });
  });

  it("reads the ticket and its conversation again before the send goes out", async () => {
    const baseline = await captureStalenessBaseline("1001");

    await sendTicketResponse({ ticketId: "1001", mode: "reply", bodyHtml: "<p>Hi</p>", baseline });

    const order = stub.requests.map((r) => `${r.method} ${new URL(r.url).pathname}`);
    expect(order.slice(0, order.indexOf("POST /api/v2/tickets/1001/reply") + 1)).toEqual([
      "GET /api/v2/tickets/1001",
      "GET /api/v2/tickets/1001/conversations",
      "POST /api/v2/tickets/1001/reply",
    ]);
  });
});

describe("reply and set status", () => {
  it("is two journalled operations, using the Done status's own ID", async () => {
    const baseline = await captureStalenessBaseline("1001");

    const result = await sendTicketResponse({ ticketId: "1001", mode: "reply", bodyHtml: "<p>Done.</p>", baseline, thenStatusId: "4" });

    expect(result).toEqual({ outcome: "sent", status: { outcome: "confirmed" } });
    expect(writes().map((r) => [r.method, new URL(r.url).pathname, r.body])).toEqual([
      ["POST", "/api/v2/tickets/1001/reply", expect.anything()],
      ["PUT", "/api/v2/tickets/1001", { status: 4 }],
    ]);
    expect((await getOperationJournal("1001")).map((e) => [e.operation, e.outcome])).toEqual([
      ["send_reply", "confirmed"],
      ["update_ticket", "confirmed"],
    ]);
  });

  it("reports reply sent, status failed when Freshdesk rejects the status", async () => {
    const baseline = await captureStalenessBaseline("1001");
    stub.respondOnce(ALPHA_HOST, "/api/v2/tickets/1001", {
      method: "PUT",
      status: 400,
      body: { description: "Validation failed", errors: [{ field: "status", message: "Status is locked", code: "invalid_value" }] },
    });

    const result = await sendTicketResponse({ ticketId: "1001", mode: "reply", bodyHtml: "<p>Done.</p>", baseline, thenStatusId: "4" });

    expect(result).toMatchObject({ outcome: "sent", status: { outcome: "rejected" } });
    expect((await getOperationJournal("1001")).map((e) => [e.operation, e.outcome])).toEqual([
      ["send_reply", "confirmed"],
      ["update_ticket", "failed"],
    ]);
  });

  it("refuses a status that is not classified Done, before anything is sent", async () => {
    const baseline = await captureStalenessBaseline("1001");

    const result = await sendTicketResponse({ ticketId: "1001", mode: "reply", bodyHtml: "<p>Done.</p>", baseline, thenStatusId: "2" });

    expect(result).toMatchObject({ outcome: "failed" });
    expect(writes()).toEqual([]);
  });

  it("does not set the status when the reply itself failed", async () => {
    const baseline = await captureStalenessBaseline("1001");
    stub.respondOnce(ALPHA_HOST, "/api/v2/tickets/1001/reply", { method: "POST", status: 500, body: {} });

    const result = await sendTicketResponse({ ticketId: "1001", mode: "reply", bodyHtml: "<p>Done.</p>", baseline, thenStatusId: "4" });

    expect(result).toMatchObject({ outcome: "failed" });
    expect(writes().map((r) => r.method)).toEqual(["POST"]);
  });
});

describe("offline", () => {
  it("refuses to send and queues nothing", async () => {
    const baseline = await captureStalenessBaseline("1001");
    useUIStore.setState({ isOnline: false });

    const result = await sendTicketResponse({ ticketId: "1001", mode: "reply", bodyHtml: "<p>Hi</p>", baseline });

    expect(result).toMatchObject({ outcome: "unavailable" });
    expect(stub.requests).toEqual([]);
    expect(await getOperationJournal("1001")).toEqual([]);
  });
});
