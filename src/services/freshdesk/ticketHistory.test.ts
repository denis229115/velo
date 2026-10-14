import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createSqliteTestDb, type SqliteTestDb } from "@/test/sqliteTestDb";
import { createFreshdeskFetchStub } from "@/test/freshdeskFetchStub";
import { ALPHA_HOST } from "./__fixtures__/freshdeskFixtures";
import { FIXTURE_NOW, rateLimited } from "./__fixtures__/freshdeskTicketFixtures";
import { HOUR, alphaTenantWithHistory } from "./__fixtures__/freshdeskConversationFixtures";

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
import { getTicketList, syncTickets } from "./ticketSync";
import { getTicketHistory, hydrateTicketHistories, resetHydrationState } from "./ticketHistory";

vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});

async function connectAndSync() {
  await connectHelpdesk({ host: ALPHA_HOST, apiKey: ALPHA_KEY });
  for (const [id, cls] of [["2", "open"], ["3", "waiting"], ["4", "done"], ["5", "done"], ["6", "open"]] as const) {
    await classifyStatus(id, cls);
  }
  await syncTickets({ trigger: "manual" });
  stub.requests.length = 0;
}

const activityOf = async (id: string) => (await getTicketList()).tickets.find((t) => t.id === id)!.activity;
const historyRequests = () => stub.requests.filter((r) => /\/tickets\/\d+(\/conversations)?\?|\/tickets\/\d+$/.test(r.url));
const ticketOf = (url: string) => url.match(/\/tickets\/(\d+)/)?.[1];

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXTURE_NOW);
  db = createSqliteTestDb();
  stub = createFreshdeskFetchStub({ [ALPHA_HOST]: { apiKey: ALPHA_KEY, tenant: alphaTenantWithHistory } });
  await runMigrations();
  resetHydrationState();
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

describe("activity metrics", () => {
  it("Last answered is the public reply, not the later internal note; the customer's newer message needs a reply (A05)", async () => {
    await connectAndSync();
    await hydrateTicketHistories({ openedId: "1001", visibleIds: [] });

    expect(await activityOf("1001")).toEqual({
      history: "complete",
      lastAnswered: { state: "known", at: FIXTURE_NOW - 44 * HOUR },
      lastCustomerMessage: { state: "known", at: FIXTURE_NOW - 26 * HOUR },
      lastInternalNote: { state: "known", at: FIXTURE_NOW - 36 * HOUR },
      lastActivity: { state: "known", at: FIXTURE_NOW - 26 * HOUR },
      needsReply: true,
    });
  });
});

describe("what does not count as an answer", () => {
  it("an automated reply, a public note, a phone log and an internal note leave a complete history Never answered", async () => {
    await connectAndSync();
    await hydrateTicketHistories({ openedId: "1002" });

    const activity = await activityOf("1002");
    expect(activity.history).toBe("complete");
    expect(activity.lastAnswered).toEqual({ state: "never" });
    expect(activity.lastInternalNote).toEqual({ state: "known", at: FIXTURE_NOW - 80 * HOUR });
    expect(activity.lastActivity).toEqual({ state: "known", at: FIXTURE_NOW - 80 * HOUR });
    // The original request is the customer's latest message
    expect(activity.lastCustomerMessage).toEqual({ state: "known", at: FIXTURE_NOW - 96 * HOUR });
    expect(activity.needsReply).toBe(true);
  });

  it("a newer reply from an author who is not one of the helpdesk's agents makes Last answered Unknown", async () => {
    await connectAndSync();
    await hydrateTicketHistories({ openedId: "1008" });

    const activity = await activityOf("1008");
    expect(activity.history).toBe("complete");
    expect(activity.lastAnswered).toEqual({ state: "unknown" });
    expect(activity.needsReply).toBeNull();
  });
});

describe("incomplete history (A06)", () => {
  it("a history whose second page was refused shows Unknown, not Never answered, and completes on a later run", async () => {
    await connectAndSync();
    stub.respondOnce(ALPHA_HOST, "/api/v2/tickets/1007/conversations", { ...rateLimited, page: 2 });
    await hydrateTicketHistories({ openedId: "1007" });

    const partial = await activityOf("1007");
    expect(partial.history).toBe("incomplete");
    expect(partial.lastAnswered).toEqual({ state: "unknown" });
    expect(partial.lastCustomerMessage).toEqual({ state: "unknown" });
    expect(partial.needsReply).toBeNull();
    const view = await getTicketHistory("1007");
    expect(view?.history).toBe("incomplete");
    expect(view?.entries).toHaveLength(1 + 100);

    vi.setSystemTime(FIXTURE_NOW + 43_000);
    await hydrateTicketHistories({ openedId: "1007" });
    const full = await activityOf("1007");
    expect(full.history).toBe("complete");
    // Entry 102 (the last of 103) is a customer message 122.6 hours ago; entry 101 the reply before it
    expect(full.lastCustomerMessage).toEqual({ state: "known", at: FIXTURE_NOW - (143 - 102 * 0.2) * HOUR });
    expect(full.lastAnswered).toEqual({ state: "known", at: FIXTURE_NOW - (143 - 101 * 0.2) * HOUR });
    expect(full.needsReply).toBe(true);
    expect((await getTicketHistory("1007"))?.entries).toHaveLength(1 + 103);
  });

  it("before any history is read every metric is Unknown", async () => {
    await connectAndSync();
    expect(await activityOf("1001")).toMatchObject({ history: "not_loaded", lastAnswered: { state: "unknown" }, needsReply: null });
  });

  it("a ticket updated after its history was read is Unknown until read again", async () => {
    await connectAndSync();
    await hydrateTicketHistories({ openedId: "1001" });
    const t = alphaTenantWithHistory.tickets!.find((x) => x.id === 1001)!;
    const original = t.updated_at;
    t.updated_at = new Date(FIXTURE_NOW - HOUR).toISOString().replace(/\.\d{3}Z$/, "Z");
    try {
      vi.setSystemTime(FIXTURE_NOW + 6 * 60 * 60_000);
      await syncTickets({ trigger: "manual" });
      expect((await activityOf("1001")).lastAnswered).toEqual({ state: "unknown" });
      await hydrateTicketHistories({ openedId: "1001" });
      expect((await activityOf("1001")).lastAnswered).toEqual({ state: "known", at: FIXTURE_NOW - 44 * HOUR });
    } finally {
      t.updated_at = original;
    }
  });
});

describe("hydration", () => {
  it("reads the opened ticket first, then the visible ones, at most a bounded number per run", async () => {
    await connectAndSync();
    await hydrateTicketHistories({ openedId: "1008", visibleIds: ["1002", "1001"] });

    const order = [...new Set(historyRequests().map((r) => ticketOf(r.url)))];
    expect(order.slice(0, 3)).toEqual(["1008", "1002", "1001"]);
    expect(order.length).toBeLessThanOrEqual(8);
  });

  it("does not read a history again while the ticket is unchanged", async () => {
    await connectAndSync();
    await hydrateTicketHistories({ openedId: "1001" });
    stub.requests.length = 0;
    await hydrateTicketHistories({ openedId: "1001" });
    expect(historyRequests().filter((r) => ticketOf(r.url) === "1001")).toHaveLength(0);
  });

  it("stops at a 429 and makes no request until Retry-After has passed", async () => {
    await connectAndSync();
    stub.respondOnce(ALPHA_HOST, "/api/v2/tickets/1001", rateLimited);
    await hydrateTicketHistories({ openedId: "1001", visibleIds: ["1002"] });
    expect(historyRequests()).toHaveLength(1);

    stub.requests.length = 0;
    vi.setSystemTime(FIXTURE_NOW + 41_000);
    await hydrateTicketHistories({ openedId: "1001" });
    await syncTickets({ trigger: "manual" });
    expect(stub.requests).toHaveLength(0);

    vi.setSystemTime(FIXTURE_NOW + 43_000);
    await hydrateTicketHistories({ openedId: "1001" });
    expect(ticketOf(historyRequests()[0]!.url)).toBe("1001");
    expect((await activityOf("1001")).history).toBe("complete");
  });
});
