import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createSqliteTestDb, type SqliteTestDb } from "@/test/sqliteTestDb";
import { createClickUpFetchStub } from "@/test/clickupFetchStub";
import { ALPHA_TOKEN, BETA_TOKEN, clickupTokens } from "./__fixtures__/clickupFixtures";

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

let stub: ReturnType<typeof createClickUpFetchStub>;
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (input: string, init?: RequestInit) => stub.fetch(input, init),
}));

import { runMigrations } from "@/services/db/migrations";
import {
  connectWorkspace,
  disconnectWorkspace,
  getClickUpSettings,
  setDefaultList,
  setTicketIdField,
} from "./connection";
import { ClickUpError } from "./client";

vi.spyOn(console, "log").mockImplementation(() => {});

beforeEach(async () => {
  db = createSqliteTestDb();
  stub = createClickUpFetchStub(clickupTokens);
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
  for (const { name } of tables) dumps.push(JSON.stringify(await db.select(`SELECT * FROM "${name}"`)));
  return dumps.join("\n");
}

describe("connecting a ClickUp workspace", () => {
  it("reads the workspace's lists with their statuses, its members and custom fields", async () => {
    await connectWorkspace({ token: ALPHA_TOKEN });

    const settings = await getClickUpSettings();
    expect(settings.isSample).toBe(false);
    expect(settings.workspace?.name).toBe("Fixture Workspace Alpha");
    expect(settings.lists.map((l) => [l.name, l.location, l.statuses.map((s) => s.name)])).toEqual([
      ["Fixture bugs", "Fixture space / Fixture folder", ["fixture to do", "fixture in progress", "fixture complete"]],
      ["Fixture follow-ups", "Fixture space", ["fixture to do", "fixture waiting on vendor", "fixture complete"]],
      ["Fixture backlog", "Fixture space", ["fixture to do", "fixture in progress", "fixture complete"]],
    ]);
    expect(settings.members.map((m) => m.name)).toEqual(["Fixture Colleague", "Fixture Operator"]);
    expect(settings.customFields.map((f) => [f.name, f.listNames])).toEqual([
      ["Fixture effort", ["Fixture bugs"]],
      ["Fixture ticket ID", ["Fixture bugs", "Fixture follow-ups"]],
    ]);
  });

  it("sends the token only as ClickUp's Authorization header and stores it encrypted", async () => {
    await connectWorkspace({ token: ALPHA_TOKEN });

    expect(stub.requests.length).toBeGreaterThan(0);
    expect(stub.requests.every((r) => r.authorization === ALPHA_TOKEN && !r.url.includes(ALPHA_TOKEN))).toBe(true);
    expect(await everyStoredValue()).not.toContain(ALPHA_TOKEN);
    const stored = await db.select<{ value: string }[]>("SELECT value FROM settings WHERE key = 'clickup_api_token'");
    expect(stored[0]?.value.startsWith("enc:")).toBe(true);
  });

  it("stores nothing when ClickUp rejects the token", async () => {
    const attempt = connectWorkspace({ token: "pk_not_a_fixture_token" });

    await expect(attempt).rejects.toMatchObject({ kind: "auth" });
    await expect(attempt).rejects.toBeInstanceOf(ClickUpError);
    expect((await getClickUpSettings()).isSample).toBe(true);
    expect(await db.select("SELECT * FROM settings WHERE key = 'clickup_api_token'")).toHaveLength(0);
  });

  it("lets the operator pick a default list and the Ticket-ID field from the workspace", async () => {
    await connectWorkspace({ token: ALPHA_TOKEN });

    await setDefaultList("li_a_follow");
    await setTicketIdField("cf-alpha-ticket");

    const settings = await getClickUpSettings();
    expect(settings.defaultListId).toBe("li_a_follow");
    expect(settings.ticketIdFieldId).toBe("cf-alpha-ticket");
    await expect(setDefaultList("li_b_1")).rejects.toThrow(/not in the connected workspace/);
    await expect(setTicketIdField("cf-made-up")).rejects.toThrow(/not in the connected workspace/);
  });

  it("does not carry the default list or Ticket-ID field over to a different workspace", async () => {
    await connectWorkspace({ token: ALPHA_TOKEN });
    await setDefaultList("li_a_follow");
    await setTicketIdField("cf-alpha-ticket");

    await connectWorkspace({ token: BETA_TOKEN });

    const settings = await getClickUpSettings();
    expect(settings.workspace?.name).toBe("Fixture Workspace Beta");
    expect(settings.lists.map((l) => l.name)).toEqual(["Fixture beta list"]);
    expect(settings.defaultListId).toBeNull();
    expect(settings.ticketIdFieldId).toBeNull();
    expect(await everyStoredValue()).not.toContain("Fixture bugs");
  });
});

describe("before a workspace is connected", () => {
  it("shows sample lists, marked as sample, and offers no selections", async () => {
    const settings = await getClickUpSettings();

    expect(settings.isSample).toBe(true);
    expect(settings.lists.map((l) => l.name)).toEqual(["Sample list one", "Sample list two"]);
    await expect(setDefaultList("sample-list-1")).rejects.toThrow(/Connect a ClickUp workspace/);
    expect(stub.requests).toHaveLength(0);
  });

  it("returns to sample lists after disconnecting and forgets the token", async () => {
    await connectWorkspace({ token: ALPHA_TOKEN });

    await disconnectWorkspace();

    expect((await getClickUpSettings()).isSample).toBe(true);
    expect(await db.select("SELECT * FROM settings WHERE key = 'clickup_api_token'")).toHaveLength(0);
  });
});
