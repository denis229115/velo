import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createSqliteTestDb, type SqliteTestDb } from "@/test/sqliteTestDb";
import { createFreshdeskFetchStub } from "@/test/freshdeskFetchStub";
import { ALPHA_HOST, BETA_HOST, betaTenant } from "./__fixtures__/freshdeskFixtures";
import { FIXTURE_NOW, alphaTenantWithTickets, rateLimited } from "./__fixtures__/freshdeskTicketFixtures";

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
  encryptValue: vi.fn(async (v: string) => `enc:${btoa(v).split("").reverse().join("")}`),
  decryptValue: vi.fn(async (v: string) => atob(v.slice(4).split("").reverse().join(""))),
  isEncrypted: vi.fn((v: string) => v.startsWith("enc:")),
}));

const ALPHA_KEY = "fixture-key-alpha-0001";
const BETA_KEY = "fixture-key-beta-0002";
let stub: ReturnType<typeof createFreshdeskFetchStub>;
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (input: string, init?: RequestInit) => stub.fetch(input, init),
}));

import { runMigrations } from "@/services/db/migrations";
import { classifyStatus, connectHelpdesk } from "./connection";
import { fetchOlderTicket, getTicketList, syncTickets } from "./ticketSync";

vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});

const MIN = 60_000;

async function connectAlpha() {
  await connectHelpdesk({ host: ALPHA_HOST, apiKey: ALPHA_KEY });
  await classifyStatus("2", "open");
  await classifyStatus("3", "waiting");
  await classifyStatus("4", "done");
  await classifyStatus("5", "done");
  await classifyStatus("6", "open");
  stub.requests.length = 0;
}

const ids = async () => (await getTicketList()).tickets.map((t) => t.id);
const ticketRequests = () => stub.requests.filter((r) => !/\/(agents|groups|ticket_fields)/.test(r.url));

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXTURE_NOW);
  db = createSqliteTestDb();
  stub = createFreshdeskFetchStub({
    [ALPHA_HOST]: { apiKey: ALPHA_KEY, tenant: alphaTenantWithTickets },
    [BETA_HOST]: { apiKey: BETA_KEY, tenant: betaTenant },
  });
  await runMigrations();
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

describe("ticket sync scope", () => {
  it("loads every outstanding ticket plus 90 days of done tickets, newest update first", async () => {
    await connectAlpha();

    await syncTickets({ trigger: "manual" });

    // 1005 is done and 200 days old: outside the default scope.
    // 1006 is outstanding but untouched for 400 days: still loaded.
    expect(await ids()).toEqual(["1003", "1001", "1002", "1007", "1008", "1004", "1006"]);
  });

  it("shows Freshdesk's exact labels, and an unknown status instead of hiding the ticket", async () => {
    await connectAlpha();
    await syncTickets({ trigger: "manual" });

    const { tickets } = await getTicketList();
    const byId = new Map(tickets.map((t) => [t.id, t]));

    expect(byId.get("1002")).toMatchObject({
      subject: "Fixture: export stuck",
      customer: "Fixture Customer Bo",
      status: { id: "6", label: "Fixture: With engineering", known: true, statusClass: "open" },
      priority: { id: "2", label: "Medium" },
      assignee: "Fixture Colleague",
      updatedAt: FIXTURE_NOW - 3 * 86_400_000,
    });
    expect(byId.get("1003")?.status).toEqual({ id: "9", label: null, known: false, statusClass: null });
    expect(byId.get("1003")?.outstanding).toBe(true);
    expect(byId.get("1004")?.outstanding).toBe(false);
    expect(byId.get("1008")?.assignee).toBeNull();
    // Found through search, which carries no requester: the name is read from the contact
    expect(byId.get("1006")?.customer).toBe("Fixture Customer Cy");
  });
});

describe("older tickets on demand", () => {
  it("fetches a ticket outside the default scope by ID and keeps it", async () => {
    await connectAlpha();
    await syncTickets({ trigger: "manual" });
    stub.requests.length = 0;

    const older = await fetchOlderTicket("#1005");

    expect(older).toMatchObject({ id: "1005", subject: "Fixture: old closed request", fetchedOnDemand: true, outstanding: false });
    expect(ticketRequests().map((r) => new URL(r.url).pathname)).toEqual(["/api/v2/tickets/1005"]);
    expect(await ids()).toContain("1005");
  });

  it("answers null for an ID the helpdesk does not have", async () => {
    await connectAlpha();
    expect(await fetchOlderTicket("424242")).toBeNull();
  });
});

describe("throttling and credentials", () => {
  it("backs off for Retry-After on a 429, shows it, then resumes", async () => {
    await connectAlpha();
    stub.respondOnce(ALPHA_HOST, "/api/v2/tickets", rateLimited);

    const status = await syncTickets({ trigger: "manual" });

    expect(status).toMatchObject({ state: "rate_limited", retryAt: FIXTURE_NOW + 42_000 });
    expect(status.message).toMatch(/slow down/);

    // Neither a poll nor a manual refresh calls Freshdesk before Retry-After has passed
    stub.requests.length = 0;
    vi.setSystemTime(FIXTURE_NOW + 41_000);
    await syncTickets({ trigger: "poll" });
    await syncTickets({ trigger: "manual" });
    expect(ticketRequests()).toHaveLength(0);
    expect((await getTicketList()).sync.state).toBe("rate_limited");

    vi.setSystemTime(FIXTURE_NOW + 43_000);
    expect((await syncTickets({ trigger: "poll" })).state).toBe("ok");
    expect(await ids()).toHaveLength(7);
  });

  it("turns expired credentials into an actionable error without a retry loop", async () => {
    await connectAlpha();
    stub.respondOnce(ALPHA_HOST, "/api/v2/tickets", { status: 401, body: { code: "invalid_credentials" } });

    const status = await syncTickets({ trigger: "manual" });

    expect(status.state).toBe("auth_error");
    expect(status.message).toMatch(/Reconnect the helpdesk in Settings/);
    expect(status.message).not.toContain(ALPHA_KEY);
    expect(status.lastSuccessAt).toBeNull();

    // Background polls hours later still make no request
    stub.requests.length = 0;
    for (let i = 1; i <= 5; i++) {
      vi.setSystemTime(FIXTURE_NOW + i * 60 * MIN);
      await syncTickets({ trigger: "poll" });
    }
    expect(ticketRequests()).toHaveLength(0);

    // Reconnecting clears the block
    await connectHelpdesk({ host: ALPHA_HOST, apiKey: ALPHA_KEY });
    expect((await syncTickets({ trigger: "poll" })).state).toBe("ok");
  });
});

describe("freshness and coverage", () => {
  it("records the last successful sync and turns stale when polling stops succeeding", async () => {
    await connectAlpha();
    expect((await getTicketList()).sync).toMatchObject({ lastSuccessAt: null, stale: true });

    await syncTickets({ trigger: "manual" });
    expect((await getTicketList()).sync).toMatchObject({ state: "ok", lastSuccessAt: FIXTURE_NOW, stale: false });

    vi.setSystemTime(FIXTURE_NOW + 16 * MIN);
    expect((await getTicketList()).sync).toMatchObject({ lastSuccessAt: FIXTURE_NOW, stale: true });
  });

  it("reports partial coverage when search cannot download every outstanding ticket", async () => {
    await connectAlpha();
    stub.respondOnce(ALPHA_HOST, "/api/v2/search/tickets", {
      status: 200,
      body: { results: [alphaTenantWithTickets.tickets![0]], total: 450 },
    });

    await syncTickets({ trigger: "manual" });

    expect((await getTicketList()).sync.coverage).toEqual({ complete: false, outstandingTotal: 450, outstandingDownloaded: 1 });
  });

  it("re-reads only changed tickets between full syncs", async () => {
    await connectAlpha();
    await syncTickets({ trigger: "manual" });
    stub.requests.length = 0;

    vi.setSystemTime(FIXTURE_NOW + 6 * MIN);
    await syncTickets({ trigger: "poll" });

    const paths = ticketRequests().map((r) => new URL(r.url));
    expect(paths.map((u) => u.pathname)).toEqual(["/api/v2/tickets"]);
    expect(paths[0]?.searchParams.get("updated_since")).toBe("2026-10-14T11:55:00Z");
  });

  it("never shows one helpdesk's tickets after connecting another", async () => {
    await connectAlpha();
    await syncTickets({ trigger: "manual" });

    await connectHelpdesk({ host: BETA_HOST, apiKey: BETA_KEY });

    expect(await ids()).toEqual([]);
  });
});
