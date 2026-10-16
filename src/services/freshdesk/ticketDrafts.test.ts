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

import { runMigrations } from "@/services/db/migrations";
import { classifyStatus, connectHelpdesk } from "./connection";
import { syncTickets } from "./ticketSync";
import {
  attachToTicketDraft,
  discardTicketDraft,
  loadTicketDraft,
  removeTicketDraftAttachment,
  saveTicketDraft,
  sendTicketDraft,
} from "./ticketDrafts";
import { useUIStore } from "@/stores/uiStore";

vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});

const posts = () => stub.requests.filter((r) => r.method === "POST");
const later = (ms: number) => vi.setSystemTime(Date.now() + ms);

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXTURE_NOW);
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

describe("ticket drafts", () => {
  it("are kept per ticket and per mode", async () => {
    await saveTicketDraft("1001", "reply", { bodyHtml: "<p>To the customer</p>" });
    await saveTicketDraft("1001", "note", { bodyHtml: "<p>For colleagues</p>" });

    expect((await loadTicketDraft("1001", "reply"))?.bodyHtml).toBe("<p>To the customer</p>");
    expect((await loadTicketDraft("1001", "note"))?.bodyHtml).toBe("<p>For colleagues</p>");
    expect(await loadTicketDraft("1002", "reply")).toBeNull();
  });

  it("survive a restart (they live in the database, CC included)", async () => {
    await saveTicketDraft("1001", "reply", { bodyHtml: "<p>Half written</p>", ccEmails: ["cc@example.test"] });
    await runMigrations();

    expect(await loadTicketDraft("1001", "reply")).toMatchObject({
      bodyHtml: "<p>Half written</p>",
      ccEmails: ["cc@example.test"],
      unconfirmedEntryId: null,
    });
  });

  it("stay editable offline", async () => {
    useUIStore.setState({ isOnline: false });
    await saveTicketDraft("1001", "reply", { bodyHtml: "<p>On the train</p>" });
    await saveTicketDraft("1001", "reply", { bodyHtml: "<p>On the train, still</p>" });

    expect((await loadTicketDraft("1001", "reply"))?.bodyHtml).toBe("<p>On the train, still</p>");
    expect(stub.requests).toEqual([]);
  });

  it("start their Staleness check baseline when first saved, not on every keystroke", async () => {
    await saveTicketDraft("1001", "reply", { bodyHtml: "<p>a</p>" });
    later(60_000);
    stub.addConversation(ALPHA_HOST, 1001, { user_id: COLLEAGUE_ID, body: "<p>Taking it</p>" });
    later(60_000);
    await saveTicketDraft("1001", "reply", { bodyHtml: "<p>ab</p>" });

    expect(await sendTicketDraft("1001", "reply")).toMatchObject({ outcome: "stale" });
    expect(posts()).toEqual([]);
  });

  it("are discarded once sent", async () => {
    await saveTicketDraft("1001", "note", { bodyHtml: "<p>Done</p>" });

    expect(await sendTicketDraft("1001", "note")).toEqual({ outcome: "sent" });
    expect(await loadTicketDraft("1001", "note")).toBeNull();
  });

  it("are kept after a failed send", async () => {
    await saveTicketDraft("1001", "reply", { bodyHtml: "<p>Important</p>" });
    stub.respondOnce(ALPHA_HOST, "/api/v2/tickets/1001/reply", { method: "POST", status: 429, body: {}, headers: { "Retry-After": "60" } });

    expect(await sendTicketDraft("1001", "reply")).toMatchObject({ outcome: "failed" });
    expect((await loadTicketDraft("1001", "reply"))?.bodyHtml).toBe("<p>Important</p>");
  });

  it("remember an Unconfirmed send, and are discarded only once reconciliation finds it", async () => {
    await saveTicketDraft("1001", "reply", { bodyHtml: "<p>Important</p>" });
    stub.respondOnce(ALPHA_HOST, "/api/v2/tickets/1001/reply", { method: "POST", networkError: true, apply: true });

    const sent = await sendTicketDraft("1001", "reply");
    const draft = await loadTicketDraft("1001", "reply");
    expect(sent).toMatchObject({ outcome: "unconfirmed" });
    expect(draft?.unconfirmedEntryId).toBe((sent as { entryId: number }).entryId);

    expect(await sendTicketDraft("1001", "reply")).toMatchObject({ outcome: "sent" });
    expect(posts()).toHaveLength(1);
    expect(await loadTicketDraft("1001", "reply")).toBeNull();
  });

  it("stay Unconfirmed after a server error, and the next send reconciles instead of posting again", async () => {
    await saveTicketDraft("1001", "reply", { bodyHtml: "<p>Important</p>" });
    stub.respondOnce(ALPHA_HOST, "/api/v2/tickets/1001/reply", { method: "POST", status: 503, body: {} });

    const sent = await sendTicketDraft("1001", "reply");
    expect(sent).toMatchObject({ outcome: "unconfirmed" });
    expect((await loadTicketDraft("1001", "reply"))?.unconfirmedEntryId).toBe((sent as { entryId: number }).entryId);

    expect(await sendTicketDraft("1001", "reply")).toMatchObject({ outcome: "failed" });
    expect(posts()).toHaveLength(1);
    expect((await loadTicketDraft("1001", "reply"))?.bodyHtml).toBe("<p>Important</p>");
  });

  it("can be discarded", async () => {
    await saveTicketDraft("1001", "reply", { bodyHtml: "<p>Never mind</p>" });
    await discardTicketDraft("1001", "reply");

    expect(await loadTicketDraft("1001", "reply")).toBeNull();
  });
});

describe("ticket draft attachments (#34)", () => {
  const file = (name: string, text: string, contentType = "text/plain") => ({ name, contentType, dataBase64: btoa(text) });
  const names = async (mode: "reply" | "note" = "reply") => (await loadTicketDraft("1001", mode))?.attachments.map((a) => [a.name, a.size]);
  const sentFiles = () => posts().map((r) => (r.body as { attachments?: { name: string }[] }).attachments?.map((a) => a.name));

  it("are kept with the draft across a restart and sent with it, then gone", async () => {
    await saveTicketDraft("1001", "reply", { bodyHtml: "<p>Logs attached.</p>" });
    expect(await attachToTicketDraft("1001", "reply", file("server.log", "hello"))).toMatchObject({ ok: true });
    expect(await attachToTicketDraft("1001", "reply", file("trace.txt", "boom"))).toMatchObject({ ok: true });
    await runMigrations();

    expect(await names()).toEqual([["server.log", 5], ["trace.txt", 4]]);
    expect(await sendTicketDraft("1001", "reply")).toEqual({ outcome: "sent" });
    expect(sentFiles()).toEqual([["server.log", "trace.txt"]]);
    expect(await loadTicketDraft("1001", "reply")).toBeNull();
    expect(await names()).toBeUndefined();
  });

  it("are kept after a failed send", async () => {
    await saveTicketDraft("1001", "reply", { bodyHtml: "<p>Logs.</p>" });
    await attachToTicketDraft("1001", "reply", file("server.log", "hello"));
    stub.respondOnce(ALPHA_HOST, "/api/v2/tickets/1001/reply", { method: "POST", status: 429, body: {}, headers: { "Retry-After": "60" } });

    expect(await sendTicketDraft("1001", "reply")).toMatchObject({ outcome: "failed" });
    expect(await names()).toEqual([["server.log", 5]]);
  });

  it("can be removed before sending", async () => {
    await saveTicketDraft("1001", "note", { bodyHtml: "<p>Dump.</p>" });
    await attachToTicketDraft("1001", "note", file("a.txt", "a"));
    const b = await attachToTicketDraft("1001", "note", file("b.txt", "b"));
    await removeTicketDraftAttachment("1001", "note", (b as { attachment: { attachmentId: string } }).attachment.attachmentId);

    await sendTicketDraft("1001", "note");
    expect(sentFiles()).toEqual([["a.txt"]]);
  });

  it("refuse a file that would take the draft over Freshdesk's 20 MB, and keep the others", async () => {
    await saveTicketDraft("1001", "reply", { bodyHtml: "<p>Videos.</p>" });
    const twelveMb = btoa("x".repeat(3)).repeat(4 * 1024 * 1024);
    expect(await attachToTicketDraft("1001", "reply", { name: "one.mp4", contentType: "video/mp4", dataBase64: twelveMb })).toMatchObject({ ok: true });

    expect(await attachToTicketDraft("1001", "reply", { name: "two.mp4", contentType: "video/mp4", dataBase64: twelveMb })).toEqual({
      ok: false,
      message: expect.stringMatching(/^two\.mp4 was not attached\..*24\.0 MB.*at most 20\.0 MB/),
    });
    expect(await names()).toEqual([["one.mp4", 12 * 1024 * 1024]]);
  });

  it("can be attached and removed offline, with nothing sent", async () => {
    useUIStore.setState({ isOnline: false });
    await saveTicketDraft("1001", "reply", { bodyHtml: "<p>On the train</p>" });
    await attachToTicketDraft("1001", "reply", file("photo.txt", "p"));

    expect(await names()).toEqual([["photo.txt", 1]]);
    expect(stub.requests).toEqual([]);
  });

  it("start a draft when the first thing added is a file", async () => {
    await attachToTicketDraft("1001", "note", file("first.txt", "f"));

    expect(await loadTicketDraft("1001", "note")).toMatchObject({ bodyHtml: "", attachments: [{ name: "first.txt" }] });
  });

  it("clean an untrusted file name and type before keeping them", async () => {
    await attachToTicketDraft("1001", "reply", { name: "C:\\Users\\x\\\u202Egnp.exe", contentType: "x<script>", dataBase64: btoa("x") });

    expect((await loadTicketDraft("1001", "reply"))?.attachments).toEqual([
      expect.objectContaining({ name: "gnp.exe", contentType: "application/octet-stream" }),
    ]);
  });

  it("stay with an Unconfirmed draft and are not sent twice while reconciling", async () => {
    await saveTicketDraft("1001", "reply", { bodyHtml: "<p>Logs attached.</p>" });
    await attachToTicketDraft("1001", "reply", file("server.log", "hello"));
    stub.respondOnce(ALPHA_HOST, "/api/v2/tickets/1001/reply", { method: "POST", networkError: true, apply: true });

    expect(await sendTicketDraft("1001", "reply")).toMatchObject({ outcome: "unconfirmed" });
    expect(await names()).toEqual([["server.log", 5]]);
    expect(await sendTicketDraft("1001", "reply")).toEqual({ outcome: "sent" });
    expect(posts()).toHaveLength(1);
    expect(await loadTicketDraft("1001", "reply")).toBeNull();
  });

  it("go with a discarded draft", async () => {
    await attachToTicketDraft("1001", "reply", file("a.txt", "a"));
    await discardTicketDraft("1001", "reply");
    await saveTicketDraft("1001", "reply", { bodyHtml: "<p>Fresh start</p>" });

    expect(await names()).toEqual([]);
  });
});

