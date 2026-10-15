import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { createSqliteTestDb, type SqliteTestDb } from "@/test/sqliteTestDb";
import { createFreshdeskFetchStub } from "@/test/freshdeskFetchStub";
import { createClickUpFetchStub } from "@/test/clickupFetchStub";
import { ALPHA_HOST } from "@/services/freshdesk/__fixtures__/freshdeskFixtures";
import { FIXTURE_NOW, alphaTenantWithTickets } from "@/services/freshdesk/__fixtures__/freshdeskTicketFixtures";
import {
  ALPHA_TOKEN,
  alphaExportBugDone,
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
let freshdesk: ReturnType<typeof createFreshdeskFetchStub>;
let clickup: ReturnType<typeof createClickUpFetchStub>;
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (input: string, init?: RequestInit) =>
    String(input).startsWith("https://api.clickup.com/") ? clickup.fetch(input, init) : freshdesk.fetch(input, init),
}));
const opened = vi.hoisted(() => ({ urls: [] as string[] }));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(async (url: string) => {
    opened.urls.push(url);
  }),
}));

const testRouter = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/router", () => ({
  get router() {
    return testRouter.current;
  },
}));

import { runMigrations } from "@/services/db/migrations";
import { classifyStatus, connectHelpdesk } from "@/services/freshdesk/connection";
import { syncTickets } from "@/services/freshdesk/ticketSync";
import { hydrateTicketHistories, resetHydrationState } from "@/services/freshdesk/ticketHistory";
import { connectWorkspace } from "@/services/clickup/connection";
import { linkTask } from "@/services/clickup/links";
import { useTicketStore } from "@/stores/ticketStore";
import { FreshdeskPage } from "@/components/freshdesk/FreshdeskPage";

// The ticket reader sizes conversation bodies, such as the backlink's internal note
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});

function renderFreshdesk(path: string) {
  const rootRoute = createRootRoute({ component: Outlet });
  const freshdeskRoute = createRoute({ getParentRoute: () => rootRoute, path: "freshdesk", component: FreshdeskPage });
  const ticketRoute = createRoute({ getParentRoute: () => freshdeskRoute, path: "ticket/$ticketId" });
  const router = createRouter({
    routeTree: rootRoute.addChildren([freshdeskRoute.addChildren([ticketRoute])]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  testRouter.current = router;
  render(<RouterProvider router={router} />);
  return router;
}

const linkedWork = async () => within(await screen.findByRole("region", { name: "Linked work" }));
/** The full Related tasks list, opened from the ticket header's linked-work row */
const panel = async () => {
  fireEvent.click(await (await linkedWork()).findByRole("button", { name: "Show tasks" }));
  return screen.findByRole("region", { name: "Related tasks" });
};
/** A ticket with no linked tasks: Link task from the linked-work row, which then opens the full list */
const linkFromRow = async () => fireEvent.click(await (await linkedWork()).findByRole("button", { name: "Link task" }));
const ticket = (ticketId: string) => ({ kind: "ticket" as const, ticketId });

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXTURE_NOW);
  db = createSqliteTestDb();
  freshdesk = createFreshdeskFetchStub({ [ALPHA_HOST]: { apiKey: HELPDESK_KEY, tenant: alphaTenantWithTickets } });
  clickup = createClickUpFetchStub(clickupTokens);
  opened.urls.length = 0;
  await runMigrations();
  useTicketStore.setState(useTicketStore.getInitialState(), true);
  await connectHelpdesk({ host: ALPHA_HOST, apiKey: HELPDESK_KEY });
  for (const [id, cls] of [["2", "open"], ["3", "waiting"], ["4", "done"], ["5", "done"], ["6", "open"]] as const) {
    await classifyStatus(id, cls);
  }
  await syncTickets({ trigger: "manual" });
  await connectWorkspace({ token: ALPHA_TOKEN });
});

afterEach(async () => {
  await hydrateTicketHistories().catch(() => {});
  resetHydrationState();
  vi.useRealTimers();
  db.close();
});

describe("Related tasks on a ticket", () => {
  it("shows each linked task's name, status, assignees, due date, last refresh and an Open in ClickUp link", async () => {
    await linkTask(ticket("1002"), "86a0exp01");
    renderFreshdesk("/freshdesk/ticket/1002");

    const region = await panel();
    const row = await within(region).findByRole("listitem", { name: /export fails for large accounts/ });
    expect(within(row).getByText("Fixture: export fails for large accounts")).toBeInTheDocument();
    expect(within(row).getByText("fixture in progress")).toBeInTheDocument();
    expect(within(row).getByText("Fixture Operator, Fixture Colleague")).toBeInTheDocument();
    expect(within(row).getByText(/Due/)).toBeInTheDocument();
    expect(within(row).getByText(/Refreshed/)).toBeInTheDocument();

    fireEvent.click(within(row).getByRole("button", { name: "Open in ClickUp" }));
    await waitFor(() => expect(opened.urls).toEqual(["https://app.clickup.com/t/86a0exp01"]));
  });

  it("links a pasted task URL from the link dialog, and rejects an unknown ID and a duplicate", async () => {
    renderFreshdesk("/freshdesk/ticket/1002");
    expect(await (await linkedWork()).findByText("No linked tasks")).toBeInTheDocument();

    await linkFromRow();
    const dialog = await screen.findByRole("dialog", { name: "Link a ClickUp task" });
    const field = within(dialog).getByLabelText("Search tasks or paste a task URL or ID");

    fireEvent.change(field, { target: { value: "86a0nope9" } });
    fireEvent.submit(field.closest("form")!);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("No task 86a0nope9 in the connected workspace");

    fireEvent.change(field, { target: { value: "https://app.clickup.com/t/86a0exp01" } });
    fireEvent.submit(field.closest("form")!);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Link a ClickUp task" })).not.toBeInTheDocument());
    const region = await screen.findByRole("region", { name: "Related tasks" });
    expect(await within(region).findByText("Fixture: export fails for large accounts")).toBeInTheDocument();

    fireEvent.click(within(region).getByRole("button", { name: "Link task" }));
    const again = await screen.findByRole("dialog", { name: "Link a ClickUp task" });
    const field2 = within(again).getByLabelText("Search tasks or paste a task URL or ID");
    fireEvent.change(field2, { target: { value: "86a0exp01" } });
    fireEvent.submit(field2.closest("form")!);
    expect(await within(again).findByRole("alert")).toHaveTextContent(/already linked/);
  });

  it("links a task found by name", async () => {
    renderFreshdesk("/freshdesk/ticket/1002");
    await linkFromRow();
    const dialog = await screen.findByRole("dialog", { name: "Link a ClickUp task" });
    const field = within(dialog).getByLabelText("Search tasks or paste a task URL or ID");

    fireEvent.change(field, { target: { value: "invoice" } });
    fireEvent.submit(field.closest("form")!);
    const result = await within(dialog).findByRole("listitem", { name: /resend invoice copy/ });
    fireEvent.click(within(result).getByRole("button", { name: "Link" }));

    const region = await screen.findByRole("region", { name: "Related tasks" });
    expect(await within(region).findByText("Fixture: resend invoice copy")).toBeInTheDocument();
  });

  it("unlinks a task from this ticket only", async () => {
    await linkTask(ticket("1002"), "86a0exp01");
    await linkTask(ticket("1001"), "86a0exp01");
    clickup.requests.length = 0;
    renderFreshdesk("/freshdesk/ticket/1002");
    const region = await panel();

    fireEvent.click(await within(region).findByRole("button", { name: /Unlink Fixture: export fails/ }));

    expect(await within(region).findByText(/No tasks linked/)).toBeInTheDocument();
    expect(clickup.requests.filter((r) => r.method !== "GET")).toHaveLength(0);
  });

  it("shows a done badge and the Follow-up cue when the task completes in ClickUp, without changing the ticket (A16)", async () => {
    await linkTask(ticket("1002"), "86a0exp01");
    // The backlinks are written; what follows must change nothing in the helpdesk
    freshdesk.requests.length = 0;
    clickup.replaceTask(alphaExportBugDone);
    renderFreshdesk("/freshdesk/ticket/1002");
    const region = await panel();
    await within(region).findByText("fixture in progress");

    fireEvent.click(within(region).getByRole("button", { name: "Refresh tasks" }));

    expect(await within(region).findByText("Done")).toBeInTheDocument();
    expect(within(region).getByText(/Follow up with customer/)).toBeInTheDocument();
    expect(within(region).getByText(/The ticket is unchanged/)).toBeInTheDocument();
    expect(freshdesk.requests.filter((r) => r.method !== "GET")).toHaveLength(0);
  });

  it("explains throttling with the time it resumes (A17)", async () => {
    await linkTask(ticket("1002"), "86a0exp01");
    clickup.respondOnce("/task/86a0exp01", { status: 429, body: {}, headers: { "retry-after": "300" } });
    renderFreshdesk("/freshdesk/ticket/1002");
    const region = await panel();

    fireEvent.click(await within(region).findByRole("button", { name: "Refresh tasks" }));

    expect(await within(region).findByRole("alert")).toHaveTextContent(/ClickUp asked Velo to slow down/);
    expect(within(region).getByRole("alert")).toHaveTextContent(/Next try/);
  });
});

describe("linked work in the ticket list", () => {
  it("badges tickets with linked tasks and filters to linked work", async () => {
    await linkTask(ticket("1002"), "86a0exp01");
    renderFreshdesk("/freshdesk");

    const linkedRow = await screen.findByRole("button", { name: /^Ticket #1002/ });
    expect(within(linkedRow.closest("[data-ticket-id]") as HTMLElement).getByText("1 task")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Ticket #1001/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Linked work only" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: /^Ticket #1001/ })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: /^Ticket #1002/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Linked work only" })).toHaveAttribute("aria-pressed", "true");
  });
});
