import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteTestDb, type SqliteTestDb } from "@/test/sqliteTestDb";
import { createClickUpFetchStub } from "@/test/clickupFetchStub";
import { ALPHA_TOKEN, BETA_TOKEN, clickupTokens } from "./__fixtures__/clickupFixtures";
let db: SqliteTestDb;
let remote: ReturnType<typeof createClickUpFetchStub>;
vi.mock("@tauri-apps/plugin-sql", () => ({ default: { load: async () => ({ select: (s: string, p?: unknown[]) => db.select(s, p), execute: (s: string, p?: unknown[]) => db.execute(s, p) }) } }));
vi.mock("@/utils/crypto", () => ({ encryptValue: async (v: string) => `enc:${v}`, decryptValue: async (v: string) => v.slice(4), isEncrypted: (v: string) => v.startsWith("enc:") }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: (s: string, i?: RequestInit) => remote.fetch(s, i) }));
import { setSetting } from "@/services/db/settings";
import { runMigrations } from "@/services/db/migrations";
import { connectWorkspace, setDefaultList } from "./connection";
import { getCreateTaskOptions, getTaskListDetails } from "./taskCreate";

const email = { kind: "email", accountId: "acct", threadId: "thread" } as const;
beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  db = createSqliteTestDb();
  remote = createClickUpFetchStub(clickupTokens);
  await runMigrations();
  await connectWorkspace({ token: ALPHA_TOKEN });
});
afterEach(() => { db.close(); });

describe("live task destinations at the ClickUp boundary", () => {
  it("keeps the previously remembered destination when upgrading to tenant-scoped choices", async () => {
    await setSetting("clickup_last_list_id", "li_a_follow");
    const options = await getCreateTaskOptions(email);
    expect(options.initialListId).toBe("li_a_follow");
    await connectWorkspace({ token: BETA_TOKEN });
    expect((await getCreateTaskOptions(email)).initialListId).toBe("li_b_1");
    await connectWorkspace({ token: ALPHA_TOKEN });
    expect((await getCreateTaskOptions(email)).initialListId).toBe("li_a_follow");
  });

  it("ignores an older list-detail response after a newer read has completed", async () => {
    const held = remote.holdNext("/list/li_a_bugs");
    const old = getTaskListDetails("li_a_bugs", "clickup:9010000001");
    const rejected = expect(old).rejects.toThrow(/choices changed/);
    await held.started;
    remote.respondOnce("/list/li_a_bugs", { body: { id: "li_a_bugs", name: "Fixture bugs", statuses: [{ status: "New remote status", type: "open", orderindex: 0 }] } });
    const latest = await getTaskListDetails("li_a_bugs", "clickup:9010000001");
    expect(latest.statuses).toEqual(["New remote status"]);
    held.release();
    await rejected;
    expect((await getCreateTaskOptions(email)).lists.find((l) => l.listId === "li_a_bugs")!.statuses).toEqual(["New remote status"]);
  });

  it("rejects discovery from a replaced connection without leaking its destinations", async () => {
    const held = remote.holdNext("/space/sp_a_1/list");
    const pending = getCreateTaskOptions(email, { refresh: true });
    const rejection = expect(pending).rejects.toThrow(/connection changed/);
    await held.started;
    await connectWorkspace({ token: BETA_TOKEN });
    held.release();
    await rejection;
    expect((await getCreateTaskOptions(email)).lists.map((l) => l.name)).toEqual(["Fixture beta list"]);
  });

  it("discloses the discovery cap and searches only real discovered choices", async () => {
    remote.respondOnce("/folder/fo_a_1/list", { body: { lists: Array.from({ length: 1001 }, (_, i) => ({ id: `remote_${i}`, name: `Remote ${i}` })) } });
    const options = await getCreateTaskOptions(email, { refresh: true });
    expect(options.discoveryComplete).toBe(false);
    expect(options.lists).toHaveLength(1000);
    expect(options.lists[999]!.name).toBe("Remote 999");
    expect(options.lists.some((l) => l.name === "Remote 1000")).toBe(false);
  });

  it("refreshes folder and folderless hierarchy, keeps the default and reports the actual discovery time", async () => {
    await setDefaultList("li_a_follow");
    remote.respondOnce("/space/sp_a_1/list", { body: { lists: [{ id: "li_new", name: "New remote list" }, { id: "li_a_follow", name: "Renamed follow-ups" }] } });
    const before = Date.now();
    const options = await getCreateTaskOptions(email, { refresh: true });
    expect(options.lists.map((l) => `${l.name} (${l.location})`)).toEqual([
      "Fixture bugs (Fixture space / Fixture folder)", "New remote list (Fixture space)", "Renamed follow-ups (Fixture space)",
    ]);
    expect(options.initialListId).toBe("li_a_follow");
    expect(options.discoveryRefreshedAt).toBeGreaterThanOrEqual(before);
    expect(options.discoveryComplete).toBe(true);
    const cached = await getCreateTaskOptions(email);
    expect(cached.lists).toEqual(options.lists);
    expect(cached.discoveryRefreshedAt).toBe(options.discoveryRefreshedAt);
    await connectWorkspace({ token: BETA_TOKEN });
    const beta = await getCreateTaskOptions(email);
    expect(beta.lists.map((l) => l.name)).toEqual(["Fixture beta list"]);
    expect(beta.initialListId).toBe("li_b_1");
  });
});
