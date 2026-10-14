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
let alpha: typeof alphaTenantWithHistory;
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (input: string, init?: RequestInit) => stub.fetch(input, init),
}));

import { runMigrations } from "@/services/db/migrations";
import { classifyStatus, connectHelpdesk, refreshHelpdeskMetadata } from "./connection";
import { getTicketList, syncTickets, type TicketListData } from "./ticketSync";
import { hydrateTicketHistories, resetHydrationState } from "./ticketHistory";
import {
  applyTicketView,
  createTicketView,
  deleteTicketView,
  getTicketViews,
  selectTicketView,
  updateTicketView,
  viewCoverage,
  type TicketView,
} from "./ticketViews";

vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});

async function connectAndSync(classes: [string, "open" | "waiting" | "done"][] = [["2", "open"], ["3", "waiting"], ["4", "done"], ["5", "done"], ["6", "open"]]) {
  await connectHelpdesk({ host: ALPHA_HOST, apiKey: ALPHA_KEY });
  for (const [id, cls] of classes) await classifyStatus(id, cls);
  await syncTickets({ trigger: "manual" });
}

async function shown(viewId: string, data?: TicketListData): Promise<string[]> {
  const list = data ?? (await getTicketList());
  const { views } = await getTicketViews();
  const view = views.find((v) => v.id === viewId) as TicketView;
  return applyTicketView(view, list).map((t) => t.id);
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXTURE_NOW);
  db = createSqliteTestDb();
  alpha = { ...alphaTenantWithHistory };
  stub = createFreshdeskFetchStub({ [ALPHA_HOST]: { apiKey: ALPHA_KEY, tenant: alpha } });
  await runMigrations();
});

afterEach(async () => {
  await hydrateTicketHistories().catch(() => {});
  resetHydrationState();
  vi.useRealTimers();
  db.close();
});

describe("preset ticket views", () => {
  it("seeds the six presets from the status classification, Waiting on customer only when a status is waiting", async () => {
    await connectAndSync();
    expect((await getTicketViews()).views.map((v) => v.name)).toEqual([
      "My open tickets",
      "My outstanding tickets",
      "Needs reply",
      "Unassigned",
      "All outstanding",
      "Waiting on customer",
    ]);
    await classifyStatus("3", "open");
    expect((await getTicketViews()).views.map((v) => v.name)).not.toContain("Waiting on customer");
  });

  it("My open is the verified me in open statuses; My outstanding adds waiting and unknown statuses (A02)", async () => {
    await connectAndSync();
    // 1001 open, 1003 unknown status 9, 1006 waiting; 1007 is the namesake's, 1004/1005 are done
    expect(await shown("preset:my-open")).toEqual(["1001"]);
    expect(await shown("preset:my-outstanding")).toEqual(["1006", "1001", "1003"]);
  });

  it("My outstanding and Needs reply return different sets on the same tickets (A03)", async () => {
    await connectAndSync();
    await hydrateTicketHistories();
    const outstanding = await shown("preset:my-outstanding");
    const needsReply = await shown("preset:needs-reply");
    expect(needsReply).toContain("1001");
    // 1007 (the namesake's) waits on us but is not mine; Needs reply is not limited to me
    expect(needsReply).toContain("1007");
    expect(needsReply).not.toEqual(outstanding);
  });

  it("Unassigned, All outstanding and Waiting on customer match by status class and assignee", async () => {
    await connectAndSync();
    expect(await shown("preset:unassigned")).toEqual(["1008"]);
    expect(await shown("preset:all-outstanding")).toEqual(["1006", "1001", "1008", "1007", "1002", "1003"]);
    expect(await shown("preset:waiting")).toEqual(["1006"]);
  });

  it("sorts Needs reply by customer waiting longest, others by priority then oldest", async () => {
    await connectAndSync();
    const { views } = await getTicketViews();
    expect(views.find((v) => v.id === "preset:needs-reply")?.sort).toBe("customer_waiting");
    expect(views.filter((v) => v.id !== "preset:needs-reply").map((v) => v.sort)).toEqual(Array(5).fill("priority"));
  });

  it("remembers a changed sort per view across a restart", async () => {
    await connectAndSync();
    await updateTicketView("preset:all-outstanding", { sort: "updated" });
    resetHydrationState();
    const { views } = await getTicketViews();
    expect(views.find((v) => v.id === "preset:all-outstanding")?.sort).toBe("updated");
    expect(views.find((v) => v.id === "preset:unassigned")?.sort).toBe("priority");
    expect(await shown("preset:all-outstanding")).toEqual(["1003", "1001", "1002", "1007", "1008", "1006"]);
  });
});

describe("custom ticket views", () => {
  it("saves, renames and deletes a view with filters, columns and density; it and the selection survive a restart (A04)", async () => {
    await connectAndSync();
    const view = await createTicketView({
      name: "Engineering queue",
      filter: { statusIds: ["6", "2"], priorityIds: ["2"] },
      sort: "updated",
      columns: ["sla_due"],
      density: "spacious",
      presentation: "list",
    });
    await selectTicketView(view.id);

    // A restart: nothing in memory, everything read back from the database
    let state = await getTicketViews();
    expect(state.selectedViewId).toBe(view.id);
    const saved = state.views.find((v) => v.id === view.id);
    expect(saved).toMatchObject({ name: "Engineering queue", kind: "custom", sort: "updated", columns: ["sla_due"], density: "spacious" });
    expect(await shown(view.id)).toEqual(["1002", "1007", "1008"]);

    await updateTicketView(view.id, { name: "Engineering" });
    expect((await getTicketViews()).views.find((v) => v.id === view.id)?.name).toBe("Engineering");

    await deleteTicketView(view.id);
    state = await getTicketViews();
    expect(state.views.find((v) => v.id === view.id)).toBeUndefined();
    expect(state.selectedViewId).toBe("preset:all-outstanding");
  });

  it("filters AND across fields and OR within a field, on assignee me, agents and unassigned", async () => {
    await connectAndSync();
    const view = await createTicketView({
      name: "Mine or nobody's, open",
      filter: { assignees: ["me", "unassigned"], statusClasses: ["open"] },
      sort: "created",
      columns: [],
      density: "compact",
      presentation: "list",
    });
    expect(await shown(view.id)).toEqual(["1008", "1001"]);
  });

  it("keeps matching by status ID after Freshdesk renames the status (A07)", async () => {
    await connectAndSync();
    const view = await createTicketView({ name: "With engineering", filter: { statusIds: ["6"] }, sort: "priority", columns: [], density: "compact", presentation: "list" });
    alpha.ticketFields = alphaTicketFieldsRenamed;
    await refreshHelpdeskMetadata();
    const data = await getTicketList();
    expect(await shown(view.id, data)).toEqual(["1002"]);
    expect(data.tickets.find((t) => t.id === "1002")?.status.label).toBe("Fixture: With engineering team");
  });
});

describe("coverage", () => {
  it("is complete for an outstanding view once every outstanding ticket is downloaded", async () => {
    await connectAndSync();
    const data = await getTicketList();
    const { views } = await getTicketViews();
    expect(viewCoverage(views.find((v) => v.id === "preset:all-outstanding")!, data)).toEqual({ complete: true, reasons: [] });
  });

  it("is partial while Needs reply history is loading and when done tickets older than 90 days could match (A21)", async () => {
    await connectAndSync();
    const data = await getTicketList();
    const { views } = await getTicketViews();
    const needsReply = viewCoverage(views.find((v) => v.id === "preset:needs-reply")!, data);
    expect(needsReply.complete).toBe(false);
    expect(needsReply.reasons.join(" ")).toMatch(/history still loading for 6 tickets/);

    const custom = await createTicketView({ name: "Urgent", filter: { priorityIds: ["4"] }, sort: "priority", columns: [], density: "compact", presentation: "list" });
    expect(viewCoverage(custom, data).reasons).toContain("done tickets only from the last 90 days");
  });

  it("is partial when the last sync could not download every outstanding ticket (A21)", async () => {
    await connectAndSync();
    const data = await getTicketList();
    const partial: TicketListData = { ...data, sync: { ...data.sync, coverage: { complete: false, outstandingTotal: 40, outstandingDownloaded: 6 } } };
    const { views } = await getTicketViews();
    expect(viewCoverage(views.find((v) => v.id === "preset:all-outstanding")!, partial)).toEqual({
      complete: false,
      reasons: ["6 of 40 outstanding tickets downloaded"],
    });
  });
});
