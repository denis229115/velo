import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createSqliteTestDb, type SqliteTestDb } from "@/test/sqliteTestDb";
import { createFreshdeskFetchStub } from "@/test/freshdeskFetchStub";
import {
  ALPHA_HOST,
  BETA_HOST,
  alphaTenant,
  alphaTicketFieldsRenamed,
  betaTenant,
  invalidStatusValue,
  type FreshdeskFixtureTenant,
} from "./__fixtures__/freshdeskFixtures";

let db: SqliteTestDb;
vi.mock("@tauri-apps/plugin-sql", () => ({
  default: {
    load: vi.fn(async () => ({
      select: (sql: string, params?: unknown[]) => db.select(sql, params),
      execute: (sql: string, params?: unknown[]) => db.execute(sql, params),
    })),
  },
}));

// Reversible stand-in for AES-GCM whose output never contains the plaintext.
vi.mock("@/utils/crypto", () => ({
  encryptValue: vi.fn(async (v: string) => `enc:${btoa(v).split("").reverse().join("")}`),
  decryptValue: vi.fn(async (v: string) => atob(v.slice(4).split("").reverse().join(""))),
  isEncrypted: vi.fn((v: string) => v.startsWith("enc:")),
}));

const ALPHA_KEY = "fixture-key-alpha-0001";
const BETA_KEY = "fixture-key-beta-0002";
let stub: ReturnType<typeof createFreshdeskFetchStub>;
/** Per-test copy of the alpha helpdesk, so a test can change what it answers. */
let alpha: FreshdeskFixtureTenant;
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (input: string, init?: RequestInit) => stub.fetch(input, init),
}));

import { runMigrations } from "@/services/db/migrations";
import {
  classifyStatus,
  connectHelpdesk,
  disconnectHelpdesk,
  getHelpdeskConnection,
  getHelpdeskMetadataSummary,
  getStatusClassification,
  refreshHelpdeskMetadata,
  refreshMetadataAfterInvalidValue,
} from "./connection";
import { FreshdeskError } from "./client";

vi.spyOn(console, "log").mockImplementation(() => {});

beforeEach(async () => {
  db = createSqliteTestDb();
  alpha = { ...alphaTenant };
  stub = createFreshdeskFetchStub({
    [ALPHA_HOST]: { apiKey: ALPHA_KEY, tenant: alpha },
    [BETA_HOST]: { apiKey: BETA_KEY, tenant: betaTenant },
  });
  await runMigrations();
});

afterEach(() => {
  db.close();
});

/** Every text value stored anywhere in the database. */
async function everyStoredValue(): Promise<string> {
  const tables = await db.select<{ name: string }[]>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%'",
  );
  const dumps: string[] = [];
  for (const { name } of tables) {
    dumps.push(JSON.stringify(await db.select(`SELECT * FROM "${name}"`)));
  }
  return dumps.join("\n");
}

describe("connecting a helpdesk", () => {
  it("reads the exact statuses and IDs, identifies me from /agents/me and keeps the key encrypted", async () => {
    await connectHelpdesk({ host: ALPHA_HOST, apiKey: ALPHA_KEY });

    const classification = await getStatusClassification();
    expect(classification.isSample).toBe(false);
    expect(classification.statuses.map((s) => [s.id, s.label])).toEqual([
      ["2", "Open"],
      ["3", "Pending"],
      ["4", "Resolved"],
      ["5", "Closed"],
      ["6", "Fixture: With engineering"],
    ]);
    expect(classification.statuses.every((s) => s.statusClass === null)).toBe(true);

    const connection = await getHelpdeskConnection();
    // The namesake agent 9000000001 has the same name; only /agents/me decides.
    expect(connection?.me).toEqual({
      agentId: "9000000002",
      name: "Fixture Operator",
      email: "operator.fixture@example.test",
    });
    expect(connection?.host).toBe(ALPHA_HOST);

    expect(stub.requests.every((r) => r.authorization === `Basic ${btoa(`${ALPHA_KEY}:X`)}`)).toBe(true);
    expect(stub.requests.map((r) => new URL(r.url).pathname)).toContain("/api/v2/agents/me");

    const stored = await everyStoredValue();
    expect(stored).not.toContain(ALPHA_KEY);
    expect(await db.select("SELECT value FROM settings WHERE key = 'freshdesk_api_key'")).toEqual([
      { value: expect.stringMatching(/^enc:/) },
    ]);
  });
});

describe("classifying statuses", () => {
  it("keeps each status class by ID when Freshdesk renames and adds statuses", async () => {
    await connectHelpdesk({ host: ALPHA_HOST, apiKey: ALPHA_KEY });
    await classifyStatus("3", "waiting");
    await classifyStatus("6", "open");
    await classifyStatus("5", "done");

    alpha.ticketFields = alphaTicketFieldsRenamed;
    await refreshHelpdeskMetadata();

    const { statuses } = await getStatusClassification();
    expect(statuses.map((s) => [s.id, s.label, s.statusClass])).toEqual([
      ["2", "Open", null],
      ["3", "Fixture: Awaiting customer", "waiting"],
      ["4", "Resolved", null],
      ["5", "Closed", "done"],
      ["6", "Fixture: With engineering team", "open"],
      ["7", "Fixture: On hold", null],
    ]);
  });

  it("refuses a status ID the helpdesk does not have", async () => {
    await connectHelpdesk({ host: ALPHA_HOST, apiKey: ALPHA_KEY });
    await expect(classifyStatus("99", "done")).rejects.toThrow();
  });

  it("refreshes metadata after Freshdesk rejects a value as invalid", async () => {
    await connectHelpdesk({ host: ALPHA_HOST, apiKey: ALPHA_KEY });
    stub.respondOnce(ALPHA_HOST, "/api/v2/ticket_fields", { status: 400, body: invalidStatusValue });
    const rejection = await refreshHelpdeskMetadata().catch((e: unknown) => e);
    expect(rejection).toBeInstanceOf(FreshdeskError);
    expect((rejection as FreshdeskError).kind).toBe("invalid_value");

    alpha.ticketFields = alphaTicketFieldsRenamed;
    expect(await refreshMetadataAfterInvalidValue(rejection)).toBe(true);
    const { statuses } = await getStatusClassification();
    expect(statuses.map((s) => s.label)).toContain("Fixture: On hold");
    expect(await refreshMetadataAfterInvalidValue(new Error("other"))).toBe(false);
  });
});

describe("switching helpdesks", () => {
  it("leaves nothing from the previous helpdesk after connecting to a different one", async () => {
    await connectHelpdesk({ host: ALPHA_HOST, apiKey: ALPHA_KEY });
    await classifyStatus("6", "open");
    await classifyStatus("2", "open");

    await connectHelpdesk({ host: BETA_HOST, apiKey: BETA_KEY });

    const classification = await getStatusClassification();
    expect(classification.statuses.map((s) => [s.id, s.label, s.statusClass])).toEqual([
      ["2", "Open", null],
      ["5", "Closed", null],
      ["8", "Fixture: Beta only", null],
    ]);
    const summary = await getHelpdeskMetadataSummary();
    expect(summary?.agents.map((a) => a.name)).toEqual(["Fixture Beta Operator"]);
    expect(summary?.groups.map((g) => g.name)).toEqual(["Fixture Beta Group"]);
    expect((await getHelpdeskConnection())?.me?.agentId).toBe("7000000001");

    const stored = await everyStoredValue();
    for (const leftover of ["Fixture: With engineering", "Fixture Billing", "Fixture Colleague", ALPHA_HOST, ALPHA_KEY]) {
      expect(stored).not.toContain(leftover);
    }
  });

  it("keeps the current helpdesk untouched when the new credentials are rejected", async () => {
    await connectHelpdesk({ host: ALPHA_HOST, apiKey: ALPHA_KEY });
    await classifyStatus("3", "waiting");

    const failure = await connectHelpdesk({ host: BETA_HOST, apiKey: "wrong-key-123" }).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(FreshdeskError);
    expect((failure as FreshdeskError).kind).toBe("auth");
    expect(String((failure as Error).message)).not.toContain("wrong-key-123");
    expect((await getHelpdeskConnection())?.host).toBe(ALPHA_HOST);
    const { statuses } = await getStatusClassification();
    expect(statuses.find((s) => s.id === "3")?.statusClass).toBe("waiting");
    expect(await everyStoredValue()).not.toContain("wrong-key-123");
  });
});

describe("sample data", () => {
  it("offers sample statuses until a helpdesk is connected, and again after disconnecting", async () => {
    const before = await getStatusClassification();
    expect(before.isSample).toBe(true);
    expect(before.statuses.length).toBeGreaterThan(0);
    expect(await getHelpdeskConnection()).toBeNull();
    expect(await getHelpdeskMetadataSummary()).toBeNull();

    await classifyStatus("3", "waiting");
    expect((await getStatusClassification()).statuses.find((s) => s.id === "3")?.statusClass).toBe("waiting");

    await connectHelpdesk({ host: ALPHA_HOST, apiKey: ALPHA_KEY });
    expect((await getStatusClassification()).isSample).toBe(false);

    await disconnectHelpdesk();
    expect(await getHelpdeskConnection()).toBeNull();
    expect((await getStatusClassification()).isSample).toBe(true);
    expect(await db.select("SELECT key FROM settings WHERE key = 'freshdesk_api_key'")).toEqual([]);
    // Nothing is fetched without a connection.
    const requestsBefore = stub.requests.length;
    expect(await refreshHelpdeskMetadata()).toBe(false);
    expect(stub.requests).toHaveLength(requestsBefore);
  });
});

describe("Freshdesk errors", () => {
  it("reports throttling with Retry-After instead of retrying", async () => {
    stub.respondOnce(ALPHA_HOST, "/api/v2/agents/me", {
      status: 429,
      body: { message: "Rate limit exceeded" },
      headers: { "Retry-After": "42" },
    });

    const failure = await connectHelpdesk({ host: ALPHA_HOST, apiKey: ALPHA_KEY }).catch((e: unknown) => e);

    expect((failure as FreshdeskError).kind).toBe("rate_limited");
    expect((failure as FreshdeskError).retryAfterSeconds).toBe(42);
    expect(stub.requests).toHaveLength(1);
    expect(await getHelpdeskConnection()).toBeNull();
  });
});
