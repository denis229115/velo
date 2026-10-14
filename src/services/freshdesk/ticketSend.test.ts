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
import { captureStalenessBaseline, reconcileTicketSend, sendTicketResponse } from "./ticketSend";
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
