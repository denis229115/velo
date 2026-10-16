import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createSqliteTestDb, type SqliteTestDb } from "@/test/sqliteTestDb";
import { createClickUpFetchStub } from "@/test/clickupFetchStub";
import { createFreshdeskFetchStub } from "@/test/freshdeskFetchStub";
import { ALPHA_HOST, alphaTenant } from "@/services/freshdesk/__fixtures__/freshdeskFixtures";
import {
  ALPHA_TOKEN,
  alphaExportBugDone,
  alphaExportBugWithNotes,
  betaTask,
  clickupTokens,
} from "./__fixtures__/clickupFixtures";

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

const HELPDESK_KEY = "fixture-key-alpha-0001";
let clickup: ReturnType<typeof createClickUpFetchStub>;
let freshdesk: ReturnType<typeof createFreshdeskFetchStub>;
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (input: string, init?: RequestInit) =>
    String(input).startsWith("https://api.clickup.com/") ? clickup.fetch(input, init) : freshdesk.fetch(input, init),
}));

import { runMigrations } from "@/services/db/migrations";
import { connectHelpdesk } from "@/services/freshdesk/connection";
import { connectWorkspace } from "./connection";
import { readTaskForAi } from "./taskContent";
import { ClickUpError } from "./client";

vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});

beforeEach(async () => {
  db = createSqliteTestDb();
  clickup = createClickUpFetchStub(clickupTokens);
  freshdesk = createFreshdeskFetchStub({ [ALPHA_HOST]: { apiKey: HELPDESK_KEY, tenant: alphaTenant } });
  await runMigrations();
  await connectHelpdesk({ host: ALPHA_HOST, apiKey: HELPDESK_KEY });
  await connectWorkspace({ token: ALPHA_TOKEN });
  clickup.requests.length = 0;
});

afterEach(() => {
  db.close();
});

describe("reading a linked task for an AI reply draft", () => {
  it("reads the name, status, description and comment texts live from ClickUp, oldest comment first", async () => {
    clickup.replaceTask(alphaExportBugWithNotes);

    const task = await readTaskForAi(alphaExportBugWithNotes.id);

    expect(task.name).toBe("Fixture: export fails for large accounts");
    expect(task.status).toBe(alphaExportBugWithNotes.status.status);
    expect(task.done).toBe(false);
    expect(task.description).toContain("times out after 30 s");
    expect(task.comments).toEqual([
      "Reproduced on staging with the fixture account.",
      expect.stringContaining("Fix is in review, not deployed yet."),
    ]);
    expect(clickup.requests.every((r) => r.method === "GET")).toBe(true);
  });

  it("leaves out who commented and the lines Velo wrote itself", async () => {
    clickup.replaceTask(alphaExportBugWithNotes);

    const task = await readTaskForAi(alphaExportBugWithNotes.id);

    const text = JSON.stringify(task);
    expect(text).not.toContain("Fixture Colleague");
    expect(text).not.toContain("colleague@fixture.invalid");
    expect(text).not.toContain("velo-op-");
    expect(text).not.toContain("fixture-alpha.freshdesk.com");
  });

  it("says a done task is done", async () => {
    clickup.replaceTask(alphaExportBugDone);

    expect((await readTaskForAi(alphaExportBugDone.id)).done).toBe(true);
  });

  it("refuses a task outside the connected workspace", async () => {
    await expect(readTaskForAi(betaTask.id)).rejects.toBeInstanceOf(ClickUpError);
  });
});
