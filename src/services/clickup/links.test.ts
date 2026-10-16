import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createSqliteTestDb, type SqliteTestDb } from "@/test/sqliteTestDb";
import { createClickUpFetchStub } from "@/test/clickupFetchStub";
import { createFreshdeskFetchStub } from "@/test/freshdeskFetchStub";
import { ALPHA_HOST, BETA_HOST, alphaTenant, betaTenant } from "@/services/freshdesk/__fixtures__/freshdeskFixtures";
import {
  ALPHA_TOKEN,
  BETA_TOKEN,
  alphaExportBug,
  alphaExportBugDone,
  alphaHostileTask,
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
import {
  getLinkedTicketSummary,
  getRelatedTasks,
  linkTask,
  refreshAllLinkedTasks,
  refreshRelatedTasks,
  searchTasksToLink,
  unlinkTask,
  type LinkedItem,
} from "./links";

vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});

const ticket = (ticketId: string): LinkedItem => ({ kind: "ticket", ticketId });

beforeEach(async () => {
  db = createSqliteTestDb();
  clickup = createClickUpFetchStub(clickupTokens);
  freshdesk = createFreshdeskFetchStub({
    [ALPHA_HOST]: { apiKey: HELPDESK_KEY, tenant: alphaTenant },
    [BETA_HOST]: { apiKey: "fixture-key-beta-0002", tenant: betaTenant },
  });
  await runMigrations();
  await connectHelpdesk({ host: ALPHA_HOST, apiKey: HELPDESK_KEY });
  await connectWorkspace({ token: ALPHA_TOKEN });
  clickup.requests.length = 0;
  freshdesk.requests.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

describe("linking an existing task to a ticket", () => {
  it("verifies a pasted task URL through ClickUp and shows the task in Related tasks", async () => {
    await linkTask(ticket("101"), "https://app.clickup.com/t/86a0exp01");

    // Verified first; the ticket's backlinks follow (see taskCreate.test.ts)
    expect(`${clickup.requests[0]?.method} ${clickup.requests[0]?.path}`).toBe("GET /task/86a0exp01");
    const related = await getRelatedTasks(ticket("101"));
    expect(related.state).toBe("ready");
    expect(related.tasks).toHaveLength(1);
    expect(related.tasks[0]).toMatchObject({
      taskId: "86a0exp01",
      name: "Fixture: export fails for large accounts",
      status: "fixture in progress",
      assignees: ["Fixture Operator", "Fixture Colleague"],
      dueAt: 1761868800000,
      url: "https://app.clickup.com/t/86a0exp01",
      done: false,
      origin: "linked",
    });
    expect(related.tasks[0]?.refreshedAt).toEqual(expect.any(Number));
  });

  it("accepts a bare task ID and a custom task ID URL", async () => {
    await linkTask(ticket("101"), "86a0exp01");
    await linkTask(ticket("101"), "https://app.clickup.com/t/9010000001/FIX-42");

    const related = await getRelatedTasks(ticket("101"));
    expect(related.tasks.map((t) => t.taskId).sort()).toEqual(["86a0exp01", "86a0inv02"]);
  });

  it("rejects an ID ClickUp does not know, after asking ClickUp, and stores no link", async () => {
    await expect(linkTask(ticket("101"), "86a0nope9")).rejects.toThrow(/No task 86a0nope9 in the connected workspace/);

    expect(clickup.requests.map((r) => r.path)).toEqual(["/task/86a0nope9"]);
    expect((await getRelatedTasks(ticket("101"))).tasks).toHaveLength(0);
  });

  it("rejects a task from another workspace", async () => {
    await expect(linkTask(ticket("101"), betaTask.url)).rejects.toThrow(/in the connected workspace/);

    expect((await getRelatedTasks(ticket("101"))).tasks).toHaveLength(0);
  });

  it("rejects text that is not a task URL or ID without calling ClickUp", async () => {
    await expect(linkTask(ticket("101"), "https://example.com/t/86a0exp01")).rejects.toThrow(/not a ClickUp task URL or ID/);

    expect(clickup.requests).toHaveLength(0);
  });

  it("prevents linking the same task to the same ticket twice", async () => {
    await linkTask(ticket("101"), "86a0exp01");

    await expect(linkTask(ticket("101"), alphaExportBug.url)).rejects.toThrow(/already linked/);

    expect((await getRelatedTasks(ticket("101"))).tasks).toHaveLength(1);
  });
});

describe("one task linked from two tickets (A15)", () => {
  it("keeps the task and the other ticket's link when one ticket unlinks it", async () => {
    await linkTask(ticket("101"), "86a0exp01");
    await linkTask(ticket("102"), "86a0exp01");
    clickup.requests.length = 0;
    freshdesk.requests.length = 0;

    await unlinkTask(ticket("101"), "86a0exp01");

    expect((await getRelatedTasks(ticket("101"))).tasks).toHaveLength(0);
    expect((await getRelatedTasks(ticket("102"))).tasks.map((t) => t.name)).toEqual([
      "Fixture: export fails for large accounts",
    ]);
    // Unlinking is local: nothing is sent to ClickUp, so the task itself is untouched
    expect(clickup.requests).toHaveLength(0);
    expect(freshdesk.requests).toHaveLength(0);
  });
});

describe("workspace isolation (A22)", () => {
  it("shows no links or tasks of the previous workspace after switching", async () => {
    await linkTask(ticket("101"), "86a0exp01");

    await connectWorkspace({ token: BETA_TOKEN });

    expect((await getRelatedTasks(ticket("101"))).tasks).toHaveLength(0);
    const tables = await db.select<{ name: string }[]>("SELECT name FROM sqlite_master WHERE type = 'table'");
    for (const { name } of tables) {
      expect(JSON.stringify(await db.select(`SELECT * FROM "${name}"`))).not.toContain("86a0exp01");
    }
    await linkTask(ticket("101"), betaTask.id);
    expect((await getRelatedTasks(ticket("101"))).tasks.map((t) => t.taskId)).toEqual([betaTask.id]);
  });
});

describe("helpdesk isolation", () => {
  it("clears ticket links of the previous helpdesk when a different helpdesk is connected", async () => {
    await linkTask(ticket("101"), "86a0exp01");

    await connectHelpdesk({ host: BETA_HOST, apiKey: "fixture-key-beta-0002" });

    expect((await getRelatedTasks(ticket("101"))).tasks).toHaveLength(0);
    expect(await db.select("SELECT * FROM task_links")).toHaveLength(0);
  });
});

describe("linking by search", () => {
  it("finds tasks by name and verifies the chosen one through ClickUp before linking", async () => {
    const results = await searchTasksToLink(ticket("101"), "invoice");

    expect(results.map((r) => [r.name, r.status, r.listName])).toEqual([
      ["Fixture: resend invoice copy", "fixture to do", "Fixture follow-ups"],
    ]);
    clickup.requests.length = 0;

    await linkTask(ticket("101"), results[0]!.taskId);

    expect(`${clickup.requests[0]?.method} ${clickup.requests[0]?.path}`).toBe("GET /task/86a0inv02");
    expect((await searchTasksToLink(ticket("101"), "invoice"))[0]?.alreadyLinked).toBe(true);
  });
});

describe("a linked task completing in ClickUp (A16)", () => {
  it("shows the task as done after a refresh and makes no request to the helpdesk", async () => {
    await linkTask(ticket("101"), "86a0exp01");
    clickup.replaceTask(alphaExportBugDone);
    clickup.requests.length = 0;
    freshdesk.requests.length = 0;

    const view = await refreshRelatedTasks(ticket("101"), { trigger: "manual" });

    expect(view.tasks[0]).toMatchObject({ status: "fixture complete", done: true });
    expect(freshdesk.requests).toHaveLength(0);
    expect(clickup.requests.every((r) => r.method === "GET")).toBe(true);
    expect(await getLinkedTicketSummary()).toEqual(new Map([["101", { count: 1, done: 1 }]]));
  });

  it("refreshes every linked task in the background", async () => {
    await linkTask(ticket("101"), "86a0exp01");
    clickup.replaceTask(alphaExportBugDone);

    await refreshAllLinkedTasks();

    expect((await getRelatedTasks(ticket("101"))).tasks[0]?.done).toBe(true);
  });

  it("marks a task ClickUp no longer returns as missing, keeping the link", async () => {
    await linkTask(ticket("101"), "86a0exp01");
    clickup.respondOnce("/task/86a0exp01", { status: 404, body: { err: "Task not found, deleted", ECODE: "ITEM_013" } });

    const view = await refreshRelatedTasks(ticket("101"), { trigger: "manual" });

    expect(view.tasks[0]).toMatchObject({ taskId: "86a0exp01", missing: true });
  });
});

describe("throttling and expired credentials (A17)", () => {
  it("waits for Retry-After before calling ClickUp again, then resumes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-14T10:00:00Z"));
    await linkTask(ticket("101"), "86a0exp01");
    clickup.respondOnce("/task/86a0exp01", { status: 429, body: { err: "Rate limit reached" }, headers: { "retry-after": "120" } });
    clickup.requests.length = 0;

    const throttled = await refreshRelatedTasks(ticket("101"), { trigger: "manual" });

    expect(throttled.refresh.state).toBe("rate_limited");
    expect(throttled.refresh.retryAt).toBe(Date.parse("2026-10-14T10:02:00Z"));
    expect(throttled.refresh.message).toMatch(/slow down/);
    // During the wait neither a refresh nor a link attempt reaches ClickUp
    await refreshRelatedTasks(ticket("101"), { trigger: "manual" });
    await refreshAllLinkedTasks();
    await expect(linkTask(ticket("102"), "86a0inv02")).rejects.toThrow(/Try again after/);
    expect(clickup.requests).toHaveLength(1);

    vi.setSystemTime(new Date("2026-10-14T10:02:01Z"));
    const resumed = await refreshRelatedTasks(ticket("101"), { trigger: "manual" });
    expect(resumed.refresh).toMatchObject({ state: "ok", message: null, retryAt: null });
    expect(clickup.requests).toHaveLength(2);
  });

  it("uses ClickUp's X-RateLimit-Reset when no Retry-After is given", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-14T10:00:00Z"));
    await linkTask(ticket("101"), "86a0exp01");
    const reset = String(Date.parse("2026-10-14T10:01:00Z") / 1000);
    clickup.respondOnce("/task/86a0exp01", { status: 429, body: {}, headers: { "x-ratelimit-reset": reset } });

    const view = await refreshRelatedTasks(ticket("101"), { trigger: "manual" });

    expect(view.refresh.retryAt).toBe(Date.parse("2026-10-14T10:01:00Z"));
  });

  it("asks for a reconnect when the token expires, keeps the last known tasks and stops background polling", async () => {
    await linkTask(ticket("101"), "86a0exp01");
    const lastRead = (await getRelatedTasks(ticket("101"))).tasks[0]?.refreshedAt;
    clickup.revoke(ALPHA_TOKEN);

    const view = await refreshRelatedTasks(ticket("101"), { trigger: "manual" });

    expect(view.refresh.state).toBe("auth_error");
    expect(view.refresh.message).toMatch(/Reconnect the workspace in Settings → ClickUp/);
    expect(view.refresh.message).not.toContain(ALPHA_TOKEN);
    expect(view.tasks[0]).toMatchObject({ name: "Fixture: export fails for large accounts", refreshedAt: lastRead });
    clickup.requests.length = 0;
    await refreshAllLinkedTasks();
    await refreshRelatedTasks(ticket("101"), { trigger: "open" });
    expect(clickup.requests).toHaveLength(0);
    await expect(linkTask(ticket("102"), "86a0inv02")).rejects.toThrow(/Reconnect the workspace/);
  });
});

describe("task content is untrusted", () => {
  it("strips control and direction characters, and never opens a non-ClickUp URL", async () => {
    await linkTask(ticket("101"), alphaHostileTask.id);

    const task = (await getRelatedTasks(ticket("101"))).tasks[0]!;
    expect(task.name).toBe("<img src=x onerror=alert(1)>evil name");
    expect(task.url).toBe("https://app.clickup.com/t/86a0hst03");
    expect(task.statusColor).toBeNull();
  });
});

describe("where links are available", () => {
  it("offers no links on sample tickets", async () => {
    await db.execute("DELETE FROM integration_accounts WHERE kind = 'freshdesk'");

    expect((await getRelatedTasks(ticket("1"))).state).toBe("sample_item");
    await expect(linkTask(ticket("1"), "86a0exp01")).rejects.toThrow(/sample tickets have no links/);
  });

  it("asks for a workspace when none is connected", async () => {
    await db.execute("DELETE FROM clickup_workspace");

    expect((await getRelatedTasks(ticket("101"))).state).toBe("no_workspace");
    await expect(linkTask(ticket("101"), "86a0exp01")).rejects.toThrow(/Connect a ClickUp workspace/);
  });

  it("scopes email links by email account", async () => {
    const personal: LinkedItem = { kind: "email", accountId: "acct-personal", threadId: "thread-1" };
    const work: LinkedItem = { kind: "email", accountId: "acct-work", threadId: "thread-1" };

    await linkTask(personal, "86a0exp01");
    await linkTask(work, "86a0exp01");
    await unlinkTask(personal, "86a0exp01");

    expect((await getRelatedTasks(personal)).tasks).toHaveLength(0);
    expect((await getRelatedTasks(work)).tasks).toHaveLength(1);
    expect((await getRelatedTasks(ticket("thread-1"))).tasks).toHaveLength(0);
  });
});


it.each([
  [ALPHA_HOST, "GET"], [BETA_HOST, "GET"], [ALPHA_HOST, "PUT"], [BETA_HOST, "PUT"],
])("does not write ticket backlinks after reconnecting to %s during a delayed ClickUp %s", async (host, method) => {
  const original = clickup.fetch;
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let delay = true;
  clickup.fetch = async (...args: Parameters<typeof original>) => {
    const response = await original(...args);
    if (delay && (args[1]?.method ?? "GET") === method && String(args[0]).includes("/task/86a0exp01")) {
      delay = false;
      started();
      await gate;
    }
    return response;
  };
  const linking = linkTask(ticket("101"), "86a0exp01");
  await waiting;
  await connectHelpdesk({ host, apiKey: host === ALPHA_HOST ? HELPDESK_KEY : "fixture-key-beta-0002" });
  release();
  await linking.catch(() => undefined);
  expect(freshdesk.requests.filter((r) => r.method === "POST")).toEqual([]);
});
