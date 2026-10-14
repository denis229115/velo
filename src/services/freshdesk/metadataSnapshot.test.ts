import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createSqliteTestDb, type SqliteTestDb } from "@/test/sqliteTestDb";
import { createFreshdeskFetchStub } from "@/test/freshdeskFetchStub";
import { ALPHA_HOST, alphaTicketFieldsRenamed } from "./__fixtures__/freshdeskFixtures";
import { FIXTURE_NOW } from "./__fixtures__/freshdeskTicketFixtures";
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
import { classifyStatus, connectHelpdesk, getHelpdeskMetadataSummary, refreshHelpdeskMetadata } from "./connection";
import { getTicketList, syncTickets, type TicketListItem } from "./ticketSync";
import { getTicketHistory, hydrateTicketHistories, resetHydrationState } from "./ticketHistory";

vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});

/** Ticket 1003 carries status 9, which no metadata ever defines. */
const UNDEFINED_STATUS_TICKET = "1003";
const alphaTenant = alphaTenantWithHistory;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXTURE_NOW);
  db = createSqliteTestDb();
  stub = createFreshdeskFetchStub({ [ALPHA_HOST]: { apiKey: ALPHA_KEY, tenant: { ...alphaTenant } } });
  await runMigrations();
  resetHydrationState();
  await connectHelpdesk({ host: ALPHA_HOST, apiKey: ALPHA_KEY });
  for (const [id, cls] of [["2", "open"], ["3", "waiting"], ["4", "done"], ["5", "done"], ["6", "open"]] as const) {
    await classifyStatus(id, cls);
  }
  await syncTickets({ trigger: "manual" });
  await hydrateTicketHistories({ openedId: "1001", visibleIds: [] });
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

type Row = Awaited<ReturnType<typeof getTicketList>>["tickets"][number];

/** What a label can wrongly degrade to when metadata is read half-replaced. */
function degradedLabels(rows: Row[], authors: string[]): string[] {
  const problems: string[] = [];
  for (const t of rows) {
    if (t.id !== UNDEFINED_STATUS_TICKET && !t.status.known) problems.push(`#${t.id} Unknown status`);
    if (t.priority?.label.startsWith("Priority ")) problems.push(`#${t.id} ${t.priority.label}`);
    if (t.assignee?.startsWith("Agent ")) problems.push(`#${t.id} ${t.assignee}`);
  }
  for (const a of authors) if (/^Agent( \d+)?$/.test(a)) problems.push(`reader author ${a}`);
  return problems;
}

/** Runs `refresh` while the list and the reader keep reading, and returns every degraded label seen. */
async function readWhileRefreshing(refresh: () => Promise<unknown>): Promise<{ problems: string[]; reads: number }> {
  let done = false;
  const refreshing = refresh().finally(() => { done = true; });
  const problems: string[] = [];
  let reads = 0;
  while (!done) {
    const [list, history] = await Promise.all([getTicketList(), getTicketHistory("1001")]);
    problems.push(...degradedLabels(list.tickets, history?.entries.map((e) => e.author) ?? []));
    reads++;
  }
  await refreshing;
  return { problems, reads };
}

describe("metadata refresh while the list and reader read", () => {
  it("never shows an Unknown status, priority or agent that exists before and after the refresh", async () => {
    const { problems, reads } = await readWhileRefreshing(() => refreshHelpdeskMetadata());

    expect(reads).toBeGreaterThan(0);
    expect(problems).toEqual([]);
  });

  it("shows a renamed status with its new label, and never Unknown on the way", async () => {
    stub = createFreshdeskFetchStub({
      [ALPHA_HOST]: { apiKey: ALPHA_KEY, tenant: { ...alphaTenant, ticketFields: alphaTicketFieldsRenamed } },
    });

    const { problems } = await readWhileRefreshing(() => refreshHelpdeskMetadata());

    expect(problems).toEqual([]);
    const label = (rows: TicketListItem[], id: string) => rows.find((t) => t.id === id)!.status.label;
    expect(label((await getTicketList()).tickets, "1006")).toBe("Fixture: Awaiting customer");
  });

  it("reads statuses, priorities, agents and groups from one snapshot of the cache", async () => {
    const seen = new Set<string>();
    let done = false;
    const refreshing = refreshHelpdeskMetadata().finally(() => { done = true; });
    while (!done) {
      const summary = (await getHelpdeskMetadataSummary())!;
      seen.add(`${summary.priorities.length}/${summary.agents.length}/${summary.groups.length}/${summary.ticketFields.length}`);
    }
    await refreshing;
    const full = (await getHelpdeskMetadataSummary())!;

    expect([...seen]).toEqual([
      `${full.priorities.length}/${full.agents.length}/${full.groups.length}/${full.ticketFields.length}`,
    ]);
  });
});

describe("a status that is really gone", () => {
  it("still shows Unknown status and counts as Outstanding after the refresh", async () => {
    const withoutStatus6 = alphaTicketFieldsRenamed.map((f) =>
      f.name === "status"
        ? { ...f, choices: Object.fromEntries(Object.entries(f.choices as object).filter(([id]) => id !== "6")) }
        : f,
    );
    stub = createFreshdeskFetchStub({
      [ALPHA_HOST]: { apiKey: ALPHA_KEY, tenant: { ...alphaTenant, ticketFields: withoutStatus6 } },
    });

    await refreshHelpdeskMetadata();

    const ticket = (await getTicketList()).tickets.find((t) => t.id === "1002")!;
    expect(ticket.status).toMatchObject({ id: "6", label: null, known: false });
    expect(ticket.outstanding).toBe(true);
  });
});
