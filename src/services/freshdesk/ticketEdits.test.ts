import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createSqliteTestDb, type SqliteTestDb } from "@/test/sqliteTestDb";
import { createFreshdeskFetchStub } from "@/test/freshdeskFetchStub";
import { ALPHA_HOST, BETA_HOST, betaTenant } from "./__fixtures__/freshdeskFixtures";
import {
  COLLEAGUE_ID,
  FIXTURE_NOW,
  accessDenied,
  alphaTenantWithTickets,
  closureFieldMissing,
  invalidAssignee,
} from "./__fixtures__/freshdeskTicketFixtures";

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

import { runMigrations } from "@/services/db/migrations";
import { classifyStatus, connectHelpdesk, currentCredentials } from "./connection";
import { getTicketList, syncTickets } from "./ticketSync";
import { getOperationJournal, updateTicket } from "./ticketEdits";
import { useUIStore } from "@/stores/uiStore";

vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});

const writes = () => stub.requests.filter((r) => r.method !== "GET");
const cached = async (id: string) => (await getTicketList()).tickets.find((t) => t.id === id)!;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXTURE_NOW);
  db = createSqliteTestDb();
  stub = createFreshdeskFetchStub({
    [ALPHA_HOST]: { apiKey: ALPHA_KEY, tenant: alphaTenantWithTickets },
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

describe("ticket edits (remote writes)", () => {
  it("changes the status by ID in one remote write, then updates the local copy and the journal", async () => {
    const result = await updateTicket("1001", { statusId: "3" });

    expect(result).toEqual({ outcome: "confirmed" });
    expect(writes()).toEqual([
      expect.objectContaining({ method: "PUT", url: `https://${ALPHA_HOST}/api/v2/tickets/1001`, body: { status: 3 } }),
    ]);
    expect((await cached("1001")).status).toMatchObject({ id: "3", label: "Pending" });
    expect(await getOperationJournal("1001")).toEqual([
      expect.objectContaining({ operation: "update_ticket", changes: { status: 3 }, outcome: "confirmed" }),
    ]);
  });

  it("keeps numeric zero and checkbox false typed in the API payload, cache, and journal", async () => {
    const fields = { cf_fixture_count: 0, cf_fixture_checked: false, cf_fixture_decimal: 12.5 };
    expect(await updateTicket("1001", { customFields: fields })).toEqual({ outcome: "confirmed" });
    expect(writes()[0]!.body).toEqual({ custom_fields: fields });
    expect((await cached("1001")).customFields).toMatchObject(fields);
    expect((await getOperationJournal("1001"))[0]?.changes).toEqual({ custom_fields: fields });
  });

  it("changes priority and assignee, keeping the customer it already knew", async () => {
    expect(await updateTicket("1001", { priorityId: "4", assigneeId: String(COLLEAGUE_ID) })).toEqual({ outcome: "confirmed" });

    expect(writes()[0]!.body).toEqual({ priority: 4, responder_id: COLLEAGUE_ID });
    const ticket = await cached("1001");
    expect(ticket.priority).toEqual({ id: "4", label: "Urgent" });
    expect(ticket.assigneeId).toBe(String(COLLEAGUE_ID));
    expect(ticket.customer).not.toBeNull();
  });

  it("unassigns with a null assignee", async () => {
    await updateTicket("1001", { assigneeId: null });
    expect(writes()[0]!.body).toEqual({ responder_id: null });
    expect((await cached("1001")).assignee).toBeNull();
  });

  it("asks for the fields Freshdesk requires for a transition, then sends them with the status (A08)", async () => {
    stub.respondOnce(ALPHA_HOST, "/api/v2/tickets/1001", closureFieldMissing);

    const asked = await updateTicket("1001", { statusId: "4" });
    expect(asked).toEqual({
      outcome: "needs_fields",
      fields: [
        {
          name: "cf_fixture_product",
          label: "Fixture product",
          message: "It should not be blank as this is a mandatory field",
          choices: [
            { value: "Fixture Widget", label: "Fixture Widget" },
            { value: "Fixture Gadget", label: "Fixture Gadget" },
          ],
        },
      ],
    });
    expect((await cached("1001")).status.id).toBe("2");

    const sent = await updateTicket("1001", { statusId: "4" }, { cf_fixture_product: "Fixture Gadget" });
    expect(sent).toEqual({ outcome: "confirmed" });
    expect(writes()[1]!.body).toEqual({ status: 4, custom_fields: { cf_fixture_product: "Fixture Gadget" } });
    expect((await cached("1001")).status.id).toBe("4");
  });

  it("reports a rejection in Freshdesk's words and keeps the local copy (A08)", async () => {
    stub.respondOnce(ALPHA_HOST, "/api/v2/tickets/1001", accessDenied);

    const result = await updateTicket("1001", { statusId: "3" });
    expect(result).toEqual({
      outcome: "rejected",
      message: "Freshdesk did not allow this change: You are not authorized to perform this action.",
    });
    expect((await cached("1001")).status.id).toBe("2");
    expect(await getOperationJournal("1001")).toEqual([expect.objectContaining({ outcome: "failed" })]);
  });

  it("names the field Freshdesk did not accept", async () => {
    stub.respondOnce(ALPHA_HOST, "/api/v2/tickets/1001", invalidAssignee);

    const result = await updateTicket("1001", { assigneeId: "123" });
    expect(result).toEqual({
      outcome: "rejected",
      message: "Freshdesk did not accept the change: There is no agent matching the given responder_id (responder_id)",
    });
    expect((await cached("1001")).assigneeId).toBe("9000000002");
  });

  it("never sends, or queues, a write while offline", async () => {
    useUIStore.setState({ isOnline: false });

    const result = await updateTicket("1001", { statusId: "3" });
    expect(result).toEqual({ outcome: "unavailable", message: "Changing a ticket needs a connection to Freshdesk." });
    expect(stub.requests).toEqual([]);
    expect(await getOperationJournal("1001")).toEqual([]);
  });

  it.each([0, 500, 502, 503])("reconciles an accepted edit with ambiguous response %s without writing again", async (status) => {
    stub.respondOnce(ALPHA_HOST, "/api/v2/tickets/1001", { method: "PUT", apply: true, ...(status ? { status, body: {} } : { networkError: true }) });

    expect(await updateTicket("1001", { statusId: "3" })).toEqual({ outcome: "confirmed" });
    expect(writes()).toHaveLength(1);
    expect((await cached("1001")).status.id).toBe("3");
    expect(await getOperationJournal("1001")).toEqual([expect.objectContaining({ outcome: "confirmed" })]);
  });

  it("reports a dropped write that did not land as not applied", async () => {
    stub.respondOnce(ALPHA_HOST, "/api/v2/tickets/1001", { method: "PUT", networkError: true });

    expect(await updateTicket("1001", { statusId: "3" })).toEqual({
      outcome: "rejected",
      message: "The connection dropped and Freshdesk did not apply the change.",
    });
    expect(writes()).toHaveLength(1);
    expect((await cached("1001")).status.id).toBe("2");
  });

  it.each([0, 503])("leaves an ambiguous edit %s unconfirmed when read-back fails too", async (status) => {
    stub.respondOnce(ALPHA_HOST, "/api/v2/tickets/1001", { method: "PUT", ...(status ? { status, body: {}, apply: true } : { networkError: true }) });
    stub.respondOnce(ALPHA_HOST, "/api/v2/tickets/1001", { method: "GET", networkError: true });

    const result = await updateTicket("1001", { statusId: "3" });
    expect(result).toEqual({
      outcome: "unconfirmed",
      message: "Velo could not confirm whether Freshdesk applied the change. The next sync will show the ticket as it is.",
    });
    expect(writes()).toHaveLength(1);
    expect(await getOperationJournal("1001")).toEqual([expect.objectContaining({ outcome: "unconfirmed" })]);
  });

  it("keeps an operator edit on the helpdesk connected now, and skips a change pinned to the previous connection", async () => {
    const previous = await currentCredentials();
    if (!previous) throw new Error("expected a connected helpdesk");
    await connectHelpdesk({ host: BETA_HOST, apiKey: BETA_KEY });
    stub.requests.length = 0;

    const skipped = await updateTicket("1001", { statusId: "4" }, {}, { tenantId: previous.tenantId, generation: previous.generation });

    expect(skipped).toMatchObject({ outcome: "unavailable", message: expect.stringMatching(/helpdesk connection changed/i) });
    expect(writes()).toEqual([]);

    const edited = await updateTicket("1001", { statusId: "3" });

    expect(writes().map((r) => `${r.method} ${new URL(r.url).host}${new URL(r.url).pathname}`)).toEqual([
      `PUT ${BETA_HOST}/api/v2/tickets/1001`,
    ]);
    expect(edited).toEqual({ outcome: "rejected", message: "Freshdesk could not find ticket #1001." });
  });
});
