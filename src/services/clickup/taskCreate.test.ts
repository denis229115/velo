import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createSqliteTestDb, type SqliteTestDb } from "@/test/sqliteTestDb";
import { createClickUpFetchStub } from "@/test/clickupFetchStub";
import { createFreshdeskFetchStub } from "@/test/freshdeskFetchStub";
import { ALPHA_HOST } from "@/services/freshdesk/__fixtures__/freshdeskFixtures";
import { alphaTenantWithTickets } from "@/services/freshdesk/__fixtures__/freshdeskTicketFixtures";
import {
  ALPHA_BACKLOG_LIST_ID,
  ALPHA_STATUSES,
  ALPHA_TOKEN,
  clickupTokens,
} from "@/services/clickup/__fixtures__/clickupFixtures";

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
const HELPDESK_KEY = "fixture-key-alpha-0001";
let clickup: ReturnType<typeof createClickUpFetchStub>;
let freshdesk: ReturnType<typeof createFreshdeskFetchStub>;
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (input: string, init?: RequestInit) =>
    String(input).startsWith("https://api.clickup.com/") ? clickup.fetch(input, init) : freshdesk.fetch(input, init),
}));

import { runMigrations } from "@/services/db/migrations";
import { connectHelpdesk } from "@/services/freshdesk/connection";
import { useUIStore } from "@/stores/uiStore";
import { connectWorkspace, setTicketIdField } from "./connection";
import { getRelatedTasks, linkTask, type LinkedItem } from "./links";
import {
  createTaskFromItem,
  getPendingTaskCreations,
  reconcileTaskCreation,
  retryMissingBacklinks,
  type NewTaskInput,
} from "./taskCreate";

vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});

const TICKET: LinkedItem = { kind: "ticket", ticketId: "1002" };
const EMAIL: LinkedItem = { kind: "email", accountId: "acct-1", threadId: "thread-secret-77" };
const TICKET_URL = `https://${ALPHA_HOST}/a/tickets/1002`;
const FOLLOW_UPS = "li_a_follow";

const input = (overrides: Partial<NewTaskInput> = {}): NewTaskInput => ({
  listId: FOLLOW_UPS,
  name: "Fixture: chase the export fix",
  description: "Customer waits for the export fix.",
  assigneeIds: ["701"],
  priority: 2,
  status: ALPHA_STATUSES.todo.status,
  dueDate: "2026-10-20",
  ...overrides,
});

const writes = () =>
  [...clickup.requests, ...freshdesk.requests]
    .filter((r) => r.method !== "GET")
    .map((r) => `${r.method} ${new URL(r.url).pathname.replace(/^\/api\/v2/, "")}`);

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  db = createSqliteTestDb();
  clickup = createClickUpFetchStub(clickupTokens);
  freshdesk = createFreshdeskFetchStub({ [ALPHA_HOST]: { apiKey: HELPDESK_KEY, tenant: alphaTenantWithTickets } });
  useUIStore.setState({ isOnline: true });
  await runMigrations();
  await connectHelpdesk({ host: ALPHA_HOST, apiKey: HELPDESK_KEY });
  await connectWorkspace({ token: ALPHA_TOKEN });
  await setTicketIdField("cf-alpha-ticket");
  clickup.requests.length = 0;
  freshdesk.requests.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

describe("creating a task from a ticket", () => {
  it("creates the task with the chosen fields and writes all three backlinks (A13)", async () => {
    const result = await createTaskFromItem(TICKET, input());
    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") return;

    const create = clickup.requests.find((r) => r.method === "POST" && r.path === `/list/${FOLLOW_UPS}/task`)!;
    expect(create.body).toMatchObject({
      name: "Fixture: chase the export fix",
      assignees: [701],
      priority: 2,
      status: "fixture to do",
      // The date the operator picked, at noon UTC, so no time zone moves it to another day
      due_date: Date.UTC(2026, 9, 20, 12),
      due_date_time: false,
    });
    const description = String(create.body!.markdown_content);
    expect(description).toContain("Customer waits for the export fix.");
    expect(description).toContain(TICKET_URL);

    const taskId = result.task.taskId;
    expect(clickup.task(taskId)!.custom_fields).toEqual([{ id: "cf-alpha-ticket", value: "1002" }]);
    const note = freshdesk.requests.find((r) => r.method === "POST" && r.url.endsWith("/tickets/1002/notes"))!;
    expect(note.body).toMatchObject({ private: true });
    expect(String(note.body!.body)).toContain(`https://app.clickup.com/t/${taskId}`);

    const related = (await getRelatedTasks(TICKET)).tasks;
    expect(related.map((t) => [t.taskId, t.origin])).toEqual([[taskId, "created"]]);
    expect(related[0]!.backlinks.map((b) => [b.step, b.state])).toEqual([
      ["description", "done"],
      ["ticketIdField", "done"],
      ["internalNote", "done"],
    ]);
  });
});

describe("backlinks that cannot or did not get written", () => {
  it("warns when the list lacks the Ticket-ID field, and still writes the ticket link and the internal note", async () => {
    const result = await createTaskFromItem(TICKET, input({ listId: ALPHA_BACKLOG_LIST_ID, assigneeIds: [], status: null }));
    if (result.outcome !== "created") throw new Error(result.outcome);
    expect(result.task.backlinks.map((b) => [b.step, b.state])).toEqual([
      ["description", "done"],
      ["ticketIdField", "skipped"],
      ["internalNote", "done"],
    ]);
    expect(result.task.backlinks[1]!.message).toMatch(/“Fixture backlog” has no Ticket-ID field/);
    expect(writes()).toEqual([`POST /list/${ALPHA_BACKLOG_LIST_ID}/task`, "POST /tickets/1002/notes"]);
  });

  it("keeps a rejected backlink as a pending step and retries only that one (A14)", async () => {
    freshdesk.respondOnce(ALPHA_HOST, "/api/v2/tickets/1002/notes", { method: "POST", status: 403, body: {} });
    const result = await createTaskFromItem(TICKET, input());
    if (result.outcome !== "created") throw new Error(result.outcome);
    expect(result.task.backlinks.map((b) => b.state)).toEqual(["done", "done", "failed"]);

    clickup.requests.length = 0;
    freshdesk.requests.length = 0;
    const retried = await retryMissingBacklinks(TICKET, result.task.taskId);
    expect(retried.backlinks.map((b) => b.state)).toEqual(["done", "done", "done"]);
    expect(writes()).toEqual(["POST /tickets/1002/notes"]);
    expect(clickup.tasksInList(FOLLOW_UPS).filter((t) => t.name === "Fixture: chase the export fix")).toHaveLength(1);
  });

  it.each([0, 500, 502, 503])("checks the ticket before retrying an internal note with ambiguous response %s", async (status) => {
    freshdesk.respondOnce(ALPHA_HOST, "/api/v2/tickets/1002/notes", { method: "POST", apply: true, ...(status ? { status, body: {} } : { networkError: true }) });
    const result = await createTaskFromItem(TICKET, input());
    if (result.outcome !== "created") throw new Error(result.outcome);
    expect(result.task.backlinks[2]!.state).toBe("unconfirmed");

    freshdesk.requests.length = 0;
    const retried = await retryMissingBacklinks(TICKET, result.task.taskId);
    expect(retried.backlinks[2]!.state).toBe("done");
    expect(freshdesk.requests.filter((r) => r.method === "POST")).toHaveLength(0);
  });
});

describe("an ambiguous creation timeout", () => {
  it.each([0, 500, 502, 503])("reconciles an accepted creation with ambiguous response %s without a second create", async (status) => {
    clickup.respondOnce(`/list/${FOLLOW_UPS}/task`, { method: "POST", apply: true, ...(status ? { status, body: {} } : { networkError: true }) });
    const first = await createTaskFromItem(TICKET, input());
    if (first.outcome !== "unconfirmed") throw new Error(first.outcome);
    expect(writes()).toEqual([`POST /list/${FOLLOW_UPS}/task`]);
    expect(await getPendingTaskCreations(TICKET)).toHaveLength(1);

    // Creating again while unsettled sends nothing
    const again = await createTaskFromItem(TICKET, input());
    expect(again.outcome).toBe("unconfirmed");
    expect(writes()).toEqual([`POST /list/${FOLLOW_UPS}/task`]);

    const settled = await reconcileTaskCreation(first.operationId);
    if (settled.outcome !== "created") throw new Error(settled.outcome);
    expect(writes().filter((w) => w === `POST /list/${FOLLOW_UPS}/task`)).toHaveLength(1);
    expect(clickup.tasksInList(FOLLOW_UPS).filter((t) => t.name === "Fixture: chase the export fix")).toHaveLength(1);
    expect(settled.task.backlinks.map((b) => b.state)).toEqual(["done", "done", "done"]);
    expect(await getPendingTaskCreations(TICKET)).toEqual([]);
  });

  it("is settled as not created when ClickUp has no task with the marker, and then allows a new attempt", async () => {
    clickup.respondOnce(`/list/${FOLLOW_UPS}/task`, { method: "POST", networkError: true });
    const first = await createTaskFromItem(TICKET, input());
    if (first.outcome !== "unconfirmed") throw new Error(first.outcome);
    const settled = await reconcileTaskCreation(first.operationId);
    expect(settled).toMatchObject({ outcome: "failed", message: expect.stringMatching(/none was created/) });
    expect((await createTaskFromItem(TICKET, input())).outcome).toBe("created");
  });
});

describe("validation against the chosen list", () => {
  it("rejects a status of another list and an assignee who is not a member of the list, sending nothing", async () => {
    expect(await createTaskFromItem(TICKET, input({ status: "fixture in progress" }))).toMatchObject({ outcome: "failed" });
    expect(await createTaskFromItem(TICKET, input({ assigneeIds: ["702"] }))).toMatchObject({
      outcome: "failed",
      message: expect.stringMatching(/can't be assigned/),
    });
    expect(writes()).toEqual([]);
  });

  it("is refused while ClickUp's Retry-After wait runs, and asks for a reconnect when the token expired", async () => {
    clickup.respondOnce(`/list/${FOLLOW_UPS}/task`, { method: "POST", status: 429, body: {}, headers: { "Retry-After": "60" } });
    expect(await createTaskFromItem(TICKET, input({ assigneeIds: [] }))).toMatchObject({ outcome: "failed", message: /slow down/ });
    expect(await createTaskFromItem(TICKET, input({ assigneeIds: [] }))).toMatchObject({ outcome: "failed", message: /slow down/ });
    expect(writes()).toEqual([`POST /list/${FOLLOW_UPS}/task`]);
  });
});

describe("creating and linking from an email thread", () => {
  it("sends nothing about the email in the create request, and writes no backlinks (A27)", async () => {
    const result = await createTaskFromItem(EMAIL, input({ description: "" }));
    if (result.outcome !== "created") throw new Error(result.outcome);
    const create = clickup.requests.find((r) => r.method === "POST")!;
    const sent = JSON.stringify(create.body);
    expect(sent).not.toContain("thread-secret-77");
    expect(sent).not.toContain("acct-1");
    expect(sent).not.toMatch(/freshdesk|ticket/i);
    expect(writes()).toEqual([`POST /list/${FOLLOW_UPS}/task`]);
    expect(result.task.backlinks).toEqual([]);
    expect((await getRelatedTasks(EMAIL)).tasks.map((t) => t.taskId)).toEqual([result.task.taskId]);
  });

  it("links an existing task to an email without writing to ClickUp", async () => {
    await linkTask(EMAIL, "86a0inv02");
    expect(writes()).toEqual([]);
  });

  it("lets a ticket and an email link the same task (A15)", async () => {
    const result = await createTaskFromItem(TICKET, input());
    if (result.outcome !== "created") throw new Error(result.outcome);
    await linkTask(EMAIL, result.task.taskId);
    expect((await getRelatedTasks(EMAIL)).tasks.map((t) => t.taskId)).toEqual([result.task.taskId]);
    expect((await getRelatedTasks(TICKET)).tasks.map((t) => t.taskId)).toEqual([result.task.taskId]);
  });
});

describe("linking an existing task to a ticket", () => {
  it("writes the same three backlinks once confirmed, keeping the task's own description", async () => {
    const related = await linkTask(TICKET, "86a0inv02");
    expect(writes()).toEqual(["PUT /task/86a0inv02", "POST /task/86a0inv02/field/cf-alpha-ticket", "POST /tickets/1002/notes"]);
    expect(clickup.task("86a0inv02")!.description).toContain(TICKET_URL);
    expect(related.backlinks.map((b) => b.state)).toEqual(["done", "done", "done"]);
  });

  it("retries only the missing backlink of a linked task", async () => {
    clickup.respondOnce("/task/86a0inv02", { method: "PUT", status: 500, body: {} });
    const related = await linkTask(TICKET, "86a0inv02");
    // ClickUp's failure starts Velo's backoff, so the field waits too; the internal note is written
    expect(related.backlinks.map((b) => b.state)).toEqual(["failed", "failed", "done"]);
    expect(related.backlinks[1]!.message).toMatch(/Try again after/);
    clickup.requests.length = 0;
    freshdesk.requests.length = 0;
    vi.setSystemTime(Date.now() + 10 * 60_000);
    const retried = await retryMissingBacklinks(TICKET, "86a0inv02");
    expect(writes()).toEqual(["PUT /task/86a0inv02", "POST /task/86a0inv02/field/cf-alpha-ticket"]);
    expect(retried.backlinks.map((b) => b.state)).toEqual(["done", "done", "done"]);
  });
});

describe("offline", () => {
  it("writes nothing and queues nothing", async () => {
    useUIStore.setState({ isOnline: false });
    expect(await createTaskFromItem(TICKET, input())).toMatchObject({ outcome: "unavailable" });
    await expect(linkTask(TICKET, "86a0inv02")).rejects.toThrow(/Needs a connection/);
    expect([...clickup.requests, ...freshdesk.requests]).toEqual([]);
    expect(await getPendingTaskCreations(TICKET)).toEqual([]);
  });
});


it("keeps task creation Unconfirmed after bounded discovery with more pages remaining", async () => {
  clickup.respondOnce(`/list/${FOLLOW_UPS}/task`, { method: "POST", apply: true, networkError: true });
  const first = await createTaskFromItem(EMAIL, input());
  if (first.outcome !== "unconfirmed") throw new Error(first.outcome);
  for (let page = 0; page < 5; page++) {
    clickup.respondOnce(`/list/${FOLLOW_UPS}/task`, { method: "GET", body: { tasks: [{ id: `unrelated-${page}` }], last_page: false } });
  }
  expect(await reconcileTaskCreation(first.operationId)).toMatchObject({ outcome: "unconfirmed" });
  expect(await getPendingTaskCreations(EMAIL)).toHaveLength(1);
  expect(await createTaskFromItem(EMAIL, input())).toMatchObject({ outcome: "unconfirmed" });
  expect(writes()).toEqual([`POST /list/${FOLLOW_UPS}/task`]);
  // Once the actual marker is visible, positive evidence settles it.
  expect(await reconcileTaskCreation(first.operationId)).toMatchObject({ outcome: "created" });
  expect(writes()).toEqual([`POST /list/${FOLLOW_UPS}/task`]);
});
