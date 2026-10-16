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
    stub.respondOnce(ALPHA_HOST, "/api/v2/tickets/1001/reply", {
      method: "POST",
      status: 400,
      body: { description: "Validation failed", errors: [{ field: "body", message: "It should not be blank", code: "missing_field" }] },
    });

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

describe("a reply or note with attachments (#34)", () => {
  const file = (name: string, text: string, contentType = "text/plain") => ({
    name,
    contentType,
    size: new TextEncoder().encode(text).length,
    dataBase64: btoa(text),
  });

  it("goes out as one multipart request to Freshdesk, with every file and the journal naming them", async () => {
    const baseline = await captureStalenessBaseline("1001");
    later(60_000);

    const result = await sendTicketResponse({
      ticketId: "1001",
      mode: "reply",
      bodyHtml: "<p>Logs attached.</p>",
      ccEmails: ["boss@example.test"],
      attachments: [file("server.log", "line 1\nline 2"), file("trace.txt", "boom")],
      baseline,
    });

    expect(result).toEqual({ outcome: "sent" });
    expect(posts()).toHaveLength(1);
    const [post] = posts();
    expect(post!.url).toBe(`https://${ALPHA_HOST}/api/v2/tickets/1001/reply`);
    expect(post!.contentType).toBeNull();
    expect(post!.body).toMatchObject({
      body: expect.stringContaining("<p>Logs attached.</p>"),
      cc_emails: ["boss@example.test"],
      attachments: [
        { name: "server.log", content_type: "text/plain", size: 13 },
        { name: "trace.txt", content_type: "text/plain", size: 4 },
      ],
    });
    expect((await getTicketHistory("1001"))?.entries.at(-1)?.attachments?.map((a) => a.name)).toEqual(["server.log", "trace.txt"]);
    expect(invoked).toEqual([]);
  });

  it("sends a note's files as a private note", async () => {
    const baseline = await captureStalenessBaseline("1001");

    await sendTicketResponse({ ticketId: "1001", mode: "note", bodyHtml: "<p>Dump.</p>", attachments: [file("dump.bin", "x", "application/octet-stream")], baseline });

    expect(posts().map((r) => [r.url, r.body])).toEqual([
      [
        `https://${ALPHA_HOST}/api/v2/tickets/1001/notes`,
        { body: "<p>Dump.</p>", private: "true", attachments: [{ name: "dump.bin", content_type: "application/octet-stream", size: 1 }] },
      ],
    ]);
  });

  it("refuses files over Freshdesk's 20 MB total before anything is posted or journalled", async () => {
    const baseline = await captureStalenessBaseline("1001");
    const big = { ...file("video.mp4", "x", "video/mp4"), size: 12 * 1024 * 1024 };

    const result = await sendTicketResponse({ ticketId: "1001", mode: "reply", bodyHtml: "<p>Two videos.</p>", attachments: [big, big], baseline });

    expect(result).toEqual({ outcome: "failed", message: expect.stringMatching(/24\.0 MB.*at most 20\.0 MB/) });
    expect(writes()).toEqual([]);
    expect(await getOperationJournal("1001")).toEqual([]);
  });

  it("is failed with Freshdesk's reason when Freshdesk rejects the files", async () => {
    const baseline = await captureStalenessBaseline("1001");
    stub.respondOnce(ALPHA_HOST, "/api/v2/tickets/1001/reply", {
      method: "POST",
      status: 400,
      body: { description: "Validation failed", errors: [{ field: "attachments", message: "Invalid file type", code: "invalid_value" }] },
    });

    const result = await sendTicketResponse({ ticketId: "1001", mode: "reply", bodyHtml: "<p>Run this.</p>", attachments: [file("setup.exe", "MZ")], baseline });

    expect(result).toMatchObject({ outcome: "failed", message: expect.stringContaining("Invalid file type") });
    expect(posts()).toHaveLength(1);
    expect((await getOperationJournal("1001")).map((e) => e.outcome)).toEqual(["failed"]);
  });

  it("is failed when Freshdesk refuses the request as too large", async () => {
    const baseline = await captureStalenessBaseline("1001");
    stub.respondOnce(ALPHA_HOST, "/api/v2/tickets/1001/reply", { method: "POST", status: 413, body: null });

    const result = await sendTicketResponse({ ticketId: "1001", mode: "reply", bodyHtml: "<p>Big.</p>", attachments: [file("a.zip", "z", "application/zip")], baseline });

    expect(result).toEqual({ outcome: "failed", message: expect.stringContaining("too large"), rejected: true });
  });

  it("is Unconfirmed when the answer is lost, and reconciliation finds it by its text and file names without posting again", async () => {
    const baseline = await captureStalenessBaseline("1001");
    later(60_000);
    stub.respondOnce(ALPHA_HOST, "/api/v2/tickets/1001/reply", { method: "POST", networkError: true, apply: true });

    const sent = await sendTicketResponse({ ticketId: "1001", mode: "reply", bodyHtml: "<p>Logs attached.</p>", attachments: [file("server.log", "l")], baseline });
    expect(sent).toMatchObject({ outcome: "unconfirmed" });

    expect(await reconcileTicketSend("1001", (sent as { entryId: number }).entryId)).toEqual({ outcome: "sent" });
    expect(posts()).toHaveLength(1);
    expect((await getOperationJournal("1001")).map((e) => e.outcome)).toEqual(["confirmed"]);
  });

  it("does not take my same text without the files for the send that carried them", async () => {
    const baseline = await captureStalenessBaseline("1001");
    later(60_000);
    stub.respondOnce(ALPHA_HOST, "/api/v2/tickets/1001/reply", { method: "POST", networkError: true });

    const sent = await sendTicketResponse({ ticketId: "1001", mode: "reply", bodyHtml: "<p>Logs attached.</p>", attachments: [file("server.log", "l")], baseline });
    stub.addConversation(ALPHA_HOST, 1001, { user_id: ME_ID, body: "<p>Logs attached.</p>" });

    expect(await reconcileTicketSend("1001", (sent as { entryId: number }).entryId)).toMatchObject({ outcome: "failed" });
    expect(posts()).toHaveLength(1);
  });

  it("sends a file's untrusted name without its path or control characters", async () => {
    const baseline = await captureStalenessBaseline("1001");

    await sendTicketResponse({
      ticketId: "1001",
      mode: "note",
      bodyHtml: "<p>See file.</p>",
      attachments: [file("../../etc/\u202Eexe.txt\u0007", "x", "text/html; <script>")],
      baseline,
    });

    expect((posts()[0]!.body as { attachments: unknown }).attachments).toEqual([
      { name: "exe.txt", content_type: "application/octet-stream", size: 1 },
    ]);
  });
});

describe("a send Freshdesk answers with an error", () => {
  const withFiles = [{ name: "server.log", contentType: "text/plain", size: 5, dataBase64: btoa("hello") }];
  const cases = [
    ["a plain reply", "reply", undefined],
    ["a reply with files", "reply", withFiles],
    ["a plain note", "note", undefined],
    ["a note with files", "note", withFiles],
  ] as const;

  describe.each(cases)("for %s", (_label, mode, attachments) => {
    const path = `/api/v2/tickets/1001/${mode === "reply" ? "reply" : "notes"}`;
    const send = async () =>
      sendTicketResponse({
        ticketId: "1001",
        mode,
        bodyHtml: "<p>Fixed it.</p>",
        ...(attachments && { attachments: [...attachments] }),
        baseline: await captureStalenessBaseline("1001"),
      });

    it.each([true, false])("reconciles a dropped POST answer (stored: %s) without another POST", async (apply) => {
      stub.respondOnce(ALPHA_HOST, path, { method: "POST", networkError: true, apply });

      const sent = await send();
      expect(sent).toMatchObject({ outcome: "unconfirmed" });
      const reconciled = await reconcileTicketSend("1001", (sent as { entryId: number }).entryId);
      expect(reconciled.outcome).toBe(apply ? "sent" : "failed");
      expect(posts()).toHaveLength(1);
    });

    it.each([500, 502, 503])("is Unconfirmed on HTTP %i, and reconciliation finds what Freshdesk stored without posting again", async (status) => {
      later(60_000);
      stub.respondOnce(ALPHA_HOST, path, { method: "POST", status, body: {}, apply: true });

      const sent = await send();
      expect(sent).toMatchObject({ outcome: "unconfirmed", message: expect.stringContaining(`HTTP ${status}`) });
      expect((await getOperationJournal("1001")).map((e) => e.outcome)).toEqual(["unconfirmed"]);

      expect(await reconcileTicketSend("1001", (sent as { entryId: number }).entryId)).toEqual({ outcome: "sent" });
      expect(posts()).toHaveLength(1);
    });

    it.each([500, 502, 503])("is Unconfirmed on HTTP %i, and failed only once reconciliation shows nothing was stored", async (status) => {
      later(60_000);
      stub.respondOnce(ALPHA_HOST, path, { method: "POST", status, body: {} });

      const sent = await send();
      expect(sent).toMatchObject({ outcome: "unconfirmed" });

      expect(await reconcileTicketSend("1001", (sent as { entryId: number }).entryId)).toMatchObject({ outcome: "failed" });
      expect(posts()).toHaveLength(1);
    });

    it("is failed on a 429 with Freshdesk's message and when to try again", async () => {
      stub.respondOnce(ALPHA_HOST, path, {
        method: "POST",
        status: 429,
        body: { message: "You have exceeded the limit of requests per minute" },
        headers: { "Retry-After": "120" },
      });

      const result = await send();

      expect(result).toEqual({
        outcome: "failed",
        message: expect.stringMatching(/You have exceeded the limit of requests per minute.*2 minutes.*Nothing was sent/),
        retryAfterSeconds: 120,
      });
      expect((await getOperationJournal("1001")).map((e) => e.outcome)).toEqual(["failed"]);
      expect(posts()).toHaveLength(1);
    });

    it("is failed on a 400 with Freshdesk's reason, as a rejection", async () => {
      stub.respondOnce(ALPHA_HOST, path, {
        method: "POST",
        status: 400,
        body: { description: "Validation failed", errors: [{ field: "cc_emails", message: "It should be a valid email", code: "invalid_value" }] },
      });

      const result = await send();

      expect(result).toEqual({ outcome: "failed", message: expect.stringContaining("It should be a valid email"), rejected: true });
      expect((await getOperationJournal("1001")).map((e) => e.outcome)).toEqual(["failed"]);
    });
  });
});
