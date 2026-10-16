import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import { ALPHA_HOST } from "@/services/freshdesk/__fixtures__/freshdeskFixtures";
import { FIXTURE_NOW, alphaTenantWithTickets } from "@/services/freshdesk/__fixtures__/freshdeskTicketFixtures";

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

// The app router, swapped for one holding just the Freshdesk routes on a memory history
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
import { getSelectedThreadId } from "@/router/navigate";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useTicketStore } from "@/stores/ticketStore";
import { useShortcutStore } from "@/stores/shortcutStore";
import { getDefaultKeyMap } from "@/constants/shortcuts";
import { FreshdeskPage } from "./FreshdeskPage";
import { ShortcutsTab } from "@/components/settings/SettingsPage";
import { FreshdeskViewNav } from "./FreshdeskViewNav";

vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});

function Shell() {
  useKeyboardShortcuts();
  return (
    <>
      <nav aria-label="Sidebar">
        <FreshdeskViewNav collapsed={false} />
      </nav>
      <Outlet />
    </>
  );
}

function renderFreshdesk(path = "/freshdesk") {
  const rootRoute = createRootRoute({ component: Shell });
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

async function connectAndSync() {
  await connectHelpdesk({ host: ALPHA_HOST, apiKey: ALPHA_KEY });
  for (const [id, cls] of [["2", "open"], ["3", "waiting"], ["4", "done"], ["5", "done"], ["6", "open"]] as const) {
    await classifyStatus(id, cls);
  }
  await syncTickets({ trigger: "manual" });
}

const rows = () => screen.queryAllByRole("button", { name: /^Ticket #/ });
const rowIds = () => rows().map((r) => r.getAttribute("aria-label")?.match(/^Ticket #([\w-]+)/)?.[1]);
const press = (key: string) => act(() => void fireEvent.keyDown(window, { key }));
const reader = () => screen.getByRole("region", { name: "Ticket reader" });
const sidebar = () => within(screen.getByRole("group", { name: "Freshdesk views" }));
const sidebarView = (name: string) => sidebar().findByRole("button", { name });
/** A restart: the in-memory store is dropped and everything is read back from the database */
async function restart() {
  cleanup();
  useTicketStore.setState(useTicketStore.getInitialState(), true);
  renderFreshdesk();
  await waitFor(() => expect(rows().length).toBeGreaterThan(0));
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXTURE_NOW);
  db = createSqliteTestDb();
  stub = createFreshdeskFetchStub({ [ALPHA_HOST]: { apiKey: ALPHA_KEY, tenant: alphaTenantWithTickets } });
  await runMigrations();
  useTicketStore.setState(useTicketStore.getInitialState(), true);
  useShortcutStore.setState({ keyMap: getDefaultKeyMap() });
});

afterEach(async () => {
  // Let background history reads finish before the database goes away
  await hydrateTicketHistories().catch(() => {});
  resetHydrationState();
  vi.useRealTimers();
  db.close();
});

describe("Freshdesk ticket list", () => {
  it("lists outstanding tickets with every column and an empty reader on the right", async () => {
    await connectAndSync();
    renderFreshdesk();

    await screen.findByText("Fixture: export stuck");
    // All outstanding, priority then oldest; done ticket 1004 is downloaded but not outstanding
    expect(screen.getByRole("heading", { name: "All outstanding" })).toBeInTheDocument();
    expect(rowIds()).toEqual(["1006", "1001", "1008", "1007", "1002", "1003"]);

    const row = within(screen.getByRole("button", { name: /^Ticket #1002/ }));
    expect(row.getByText("#1002")).toBeInTheDocument();
    expect(row.getByText("Fixture: export stuck")).toBeInTheDocument();
    expect(row.getByText("Fixture Customer Bo")).toBeInTheDocument();
    expect(row.getByText("Fixture: With engineering")).toBeInTheDocument();
    expect(row.getByText("Medium")).toBeInTheDocument();
    expect(row.getByText("Fixture Colleague")).toBeInTheDocument();
    // The row's own time (last updated) sits on the first line, apart from the activity times
    expect(row.getByText("Fixture Customer Bo").closest("[data-line]")?.querySelector("time")).toHaveAttribute(
      "dateTime",
      new Date(FIXTURE_NOW - 3 * 86_400_000).toISOString(),
    );

    // The unknown status is labelled, not hidden; an unassigned ticket says so
    expect(within(screen.getByRole("button", { name: /^Ticket #1003/ })).getByText("Unknown status")).toBeInTheDocument();
    expect(within(screen.getByRole("button", { name: /^Ticket #1008/ })).getByText("Unassigned")).toBeInTheDocument();

    expect(within(reader()).getByText("Select a ticket to read")).toBeInTheDocument();
  });

  it("filters to My open tickets: the verified me in open-classified statuses", async () => {
    await connectAndSync();
    renderFreshdesk();
    await screen.findByText("Fixture: export stuck");

    fireEvent.click(await sidebarView("My open tickets"));

    // Not 1003 (mine, unknown status), 1006 (mine, waiting), 1007 (a namesake's)
    expect(rowIds()).toEqual(["1001"]);
  });

  it("moves through the list with j/k and opens with Enter, in the reader on the right", async () => {
    await connectAndSync();
    const router = renderFreshdesk();
    await screen.findByText("Fixture: export stuck");

    press("Enter");
    expect(await within(reader()).findByRole("heading", { name: "Fixture: long-waiting reply" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Ticket #1006/ })).toHaveAttribute("aria-selected", "true");

    press("j");
    expect(await within(reader()).findByRole("heading", { name: "Fixture: cannot sign in" })).toBeInTheDocument();
    press("j");
    expect(await within(reader()).findByRole("heading", { name: "Fixture: nobody assigned" })).toBeInTheDocument();
    press("k");
    expect(await within(reader()).findByRole("heading", { name: "Fixture: cannot sign in" })).toBeInTheDocument();

    // Ticket IDs live in their own route parameter and never select an email thread
    expect(router.state.location.pathname).toBe("/freshdesk/ticket/1001");
    expect(getSelectedThreadId()).toBeNull();
  });

  it("shows the last sync, the downloaded count, and an actionable error for rejected credentials", async () => {
    await connectAndSync();
    stub.respondOnce(ALPHA_HOST, "/api/v2/tickets", { status: 401, body: { code: "invalid_credentials" } });
    vi.setSystemTime(FIXTURE_NOW + 7 * 60 * 60_000);
    await syncTickets({ trigger: "poll" });
    renderFreshdesk();
    await screen.findByText("Fixture: export stuck");

    expect(screen.getByText(/7 downloaded/)).toBeInTheDocument();
    expect(screen.getByText(/Stale/)).toBeInTheDocument();
    expect(screen.getByText(/Last synced 7 hours ago/)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/Reconnect the helpdesk in Settings/);
  });

  it("marks sample tickets as sample until a helpdesk is connected", async () => {
    renderFreshdesk();

    expect(await screen.findByText("Sample ticket: cannot sign in")).toBeInTheDocument();
    expect(screen.getByText(/Sample data/)).toBeInTheDocument();
    expect(within(screen.getByRole("button", { name: /^Ticket #sample-4/ })).getByText("Unknown status")).toBeInTheDocument();
  });
});

describe("Freshdesk ticket views", () => {
  it("lists the presets under Freshdesk in the sidebar and opens each one", async () => {
    await connectAndSync();
    renderFreshdesk();
    await screen.findByText("Fixture: export stuck");
    expect(sidebar().getAllByRole("button").map((b) => b.textContent)).toEqual([
      "My open tickets",
      "My outstanding tickets",
      "Needs reply",
      "Unassigned",
      "All outstanding",
      "Waiting on customer",
    ]);
    fireEvent.click(await sidebarView("Unassigned"));
    await waitFor(() => expect(rowIds()).toEqual(["1008"]));
    expect(await sidebarView("Unassigned")).toHaveAttribute("aria-current", "page");
  });

  it("changes a view's sort and remembers it, and the selected view, after a restart (A04)", async () => {
    await connectAndSync();
    renderFreshdesk();
    await screen.findByText("Fixture: export stuck");
    expect(screen.getByRole("combobox", { name: "Sort" })).toHaveDisplayValue("Priority, then oldest");
    fireEvent.change(screen.getByRole("combobox", { name: "Sort" }), { target: { value: "updated" } });
    await waitFor(() => expect(rowIds()).toEqual(["1003", "1001", "1002", "1007", "1008", "1006"]));
    fireEvent.click(await sidebarView("Waiting on customer"));
    await waitFor(() => expect(rowIds()).toEqual(["1006"]));

    await restart();
    expect(await screen.findByRole("heading", { name: "Waiting on customer" })).toBeInTheDocument();
    fireEvent.click(await sidebarView("All outstanding"));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Sort" })).toHaveDisplayValue("Last updated"));
    expect(rowIds()).toEqual(["1003", "1001", "1002", "1007", "1008", "1006"]);
  });

  it("saves a custom view from edited filters with its columns and density, renames and deletes it", async () => {
    await connectAndSync();
    renderFreshdesk();
    await screen.findByText("Fixture: export stuck");

    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    const panel = within(await screen.findByRole("region", { name: "Filters" }));
    fireEvent.click(await panel.findByRole("checkbox", { name: "Fixture: With engineering" }));
    fireEvent.click(panel.getByRole("checkbox", { name: "Open" }));
    fireEvent.click(panel.getByRole("checkbox", { name: "Medium" }));
    await waitFor(() => expect(rowIds()).toEqual(["1008", "1007", "1002"]));

    fireEvent.change(panel.getByRole("textbox", { name: "View name" }), { target: { value: "Engineering queue" } });
    fireEvent.click(panel.getByRole("button", { name: "Save as view" }));
    expect(await screen.findByRole("heading", { name: "Engineering queue" })).toBeInTheDocument();
    expect(await sidebarView("Engineering queue")).toHaveAttribute("aria-current", "page");

    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "SLA due" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Density" }), { target: { value: "spacious" } });
    await waitFor(() => expect(within(screen.getByRole("button", { name: /^Ticket #1002/ })).getByText(/^Due/)).toBeInTheDocument());

    await restart();
    expect(await screen.findByRole("heading", { name: "Engineering queue" })).toBeInTheDocument();
    await waitFor(() => expect(rowIds()).toEqual(["1008", "1007", "1002"]));
    expect(screen.getByRole("combobox", { name: "Density" })).toHaveDisplayValue("Spacious");
    expect(within(screen.getByRole("button", { name: /^Ticket #1002/ })).getByText(/^Due/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Rename view" }));
    fireEvent.change(screen.getByRole("textbox", { name: "View name" }), { target: { value: "Engineering" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "View name" }), { key: "Enter" });
    expect(await sidebarView("Engineering")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete view" }));
    await waitFor(() => expect(sidebar().queryByRole("button", { name: "Engineering" })).not.toBeInTheDocument());
    expect(await screen.findByRole("heading", { name: "All outstanding" })).toBeInTheDocument();
  });

  it("shows the coverage indicator while Needs reply is partial, never a total (A21)", async () => {
    await connectAndSync();
    renderFreshdesk();
    await screen.findByText("Fixture: export stuck");
    expect(screen.queryByRole("status", { name: "Coverage" })).not.toBeInTheDocument();
    cleanup();

    // The next full sync's search finds 450 outstanding tickets but downloads one
    stub.respondOnce(ALPHA_HOST, "/api/v2/search/tickets", {
      status: 200,
      body: { results: [alphaTenantWithTickets.tickets![0]], total: 450 },
    });
    vi.setSystemTime(FIXTURE_NOW + 7 * 60 * 60_000);
    await syncTickets({ trigger: "manual" });
    useTicketStore.setState(useTicketStore.getInitialState(), true);
    renderFreshdesk();
    const coverage = await screen.findByRole("status", { name: "Coverage" });
    expect(coverage).toHaveTextContent(/Partial results/);
    expect(coverage).toHaveTextContent("1 of 450 outstanding tickets downloaded");
    expect(coverage).not.toHaveTextContent(/\b6 tickets\b|of 6\b/);
    expect(within(coverage).getByRole("button", { name: "Refresh" })).toBeInTheDocument();

    // The sync line keeps to downloads and freshness: the coverage is stated once, in the bar
    expect(screen.getByText(/^\d+ downloaded/)).not.toHaveTextContent(/partial|of 450/i);
    expect(screen.getAllByText(/1 of 450 outstanding/)).toHaveLength(1);
    expect(screen.getByText(/Last synced/)).toBeInTheDocument();
  });

  it("keeps the all-outstanding coverage note on the sync line while no Partial results bar is shown", async () => {
    await connectAndSync();
    renderFreshdesk();
    await screen.findByText("Fixture: export stuck");
    expect(screen.queryByRole("status", { name: "Coverage" })).not.toBeInTheDocument();
    expect(screen.getByText(/downloaded/)).toHaveTextContent("all outstanding + 90 days of done");
  });

  it("keeps the assignee readable on the row, with the optional columns on their own line after it", async () => {
    await connectAndSync();
    renderFreshdesk();
    await screen.findByText("Fixture: export stuck");
    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "SLA due" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Company / group" }));
    const row = within(screen.getByRole("button", { name: /^Ticket #1002/ }));
    await waitFor(() => expect(row.getByText(/^Due/)).toBeInTheDocument());

    const assignee = row.getByText("Fixture Colleague");
    expect(assignee.closest("[data-column=assignee]")).toHaveClass("shrink-0");
    const sla = row.getByText(/^Due/);
    expect(assignee.closest("[data-line]")).not.toBe(sla.closest("[data-line]"));
    expect(sla.closest("[data-line]")).toBe(row.getByText(/Fixture/, { selector: "[data-column=company_group]" }).closest("[data-line]"));
    // Assignee first, then the answer metrics, on the line that was squeezing it out
    expect(assignee.closest("[data-line]")).toBe(row.getByText("Answered").closest("[data-line]"));
    expect(assignee.compareDocumentPosition(row.getByText("Answered"))).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("gives the assignee, last answer and last customer message a line of their own, so the customer text is not clipped by the subject", async () => {
    await connectAndSync();
    renderFreshdesk();
    await screen.findByText("Fixture: export stuck");
    const row = within(screen.getByRole("button", { name: /^Ticket #1002/ }));

    const details = row.getByText("Fixture Colleague").closest("[data-line]");
    expect(details).not.toBe(row.getByText("Fixture: export stuck").closest("[data-line]"));
    // Whole items, most important first; the customer fact is the first to go when the list is narrow
    expect(details).toHaveClass("flex-wrap", "overflow-hidden");
    expect(details).toContainElement(row.getByText("Answered"));
    expect(details).toContainElement(row.getByText("Customer"));
    expect(row.getByText("Answered").compareDocumentPosition(row.getByText("Customer"))).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("closes the Columns menu on Escape and returns focus to its button", async () => {
    await connectAndSync();
    const router = renderFreshdesk("/freshdesk/ticket/1001");
    await screen.findByText("Fixture: export stuck");
    const button = screen.getByRole("button", { name: "Columns" });

    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    const checkbox = screen.getByRole("checkbox", { name: "SLA due" });
    checkbox.focus();
    fireEvent.keyDown(checkbox, { key: "Escape" });

    expect(screen.queryByRole("group", { name: "Optional columns" })).not.toBeInTheDocument();
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).toHaveFocus();
    // Escape closes only the menu; it must not also close the open ticket
    expect(router.state.location.pathname).toBe("/freshdesk/ticket/1001");
  });

  it("closes the Columns menu on a click outside it, but not on a click inside", async () => {
    await connectAndSync();
    renderFreshdesk();
    await screen.findByText("Fixture: export stuck");
    const button = screen.getByRole("button", { name: "Columns" });

    fireEvent.click(button);
    fireEvent.mouseDown(screen.getByRole("checkbox", { name: "SLA due" }));
    expect(screen.getByRole("group", { name: "Optional columns" })).toBeInTheDocument();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("group", { name: "Optional columns" })).not.toBeInTheDocument();
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).toHaveFocus();

    // Clicking the button toggles it again, and a second click closes it
    fireEvent.click(button);
    expect(screen.getByRole("group", { name: "Optional columns" })).toBeInTheDocument();
    fireEvent.mouseDown(button);
    fireEvent.click(button);
    expect(screen.queryByRole("group", { name: "Optional columns" })).not.toBeInTheDocument();
  });

  it("offers optional columns only when Freshdesk provides their data, hidden by default", async () => {
    renderFreshdesk();
    await screen.findByText("Sample ticket: cannot sign in");
    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    expect(screen.queryByRole("checkbox", { name: "SLA due" })).not.toBeInTheDocument();
    expect(screen.getByText("No optional columns: Freshdesk has not provided company, group or SLA data.")).toBeInTheDocument();
    cleanup();

    await connectAndSync();
    useTicketStore.setState(useTicketStore.getInitialState(), true);
    renderFreshdesk();
    await screen.findByText("Fixture: export stuck");
    expect(within(screen.getByRole("button", { name: /^Ticket #1002/ })).queryByText(/^Due/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    expect(screen.getByRole("checkbox", { name: "SLA due" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "Company / group" }));
    await waitFor(() => expect(within(screen.getByRole("button", { name: /^Ticket #1002/ })).getByText(/Fixture/, { selector: "[data-column=company_group]" })).toBeInTheDocument());
  });
});


describe("ticket shortcuts", () => {
  it("reuses r to open Reply to customer on the selected ticket", async () => {
    await connectAndSync();
    renderFreshdesk("/freshdesk/ticket/1001");
    await within(await screen.findByRole("region", { name: "Ticket reader" })).findByRole("button", { name: "Reply" });

    press("r");

    expect(await screen.findByRole("region", { name: "Reply to customer" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Internal note" })).not.toBeInTheDocument();
  });
});


it("rebinds Internal note from settings and uses the new key immediately", async () => {
  await connectAndSync();
  renderFreshdesk("/freshdesk/ticket/1001");
  await within(await screen.findByRole("region", { name: "Ticket reader" })).findByRole("button", { name: "Reply" });
  const settings = render(<ShortcutsTab />);
  const row = screen.getByText("Ticket: Internal note").closest("[data-shortcut-row]")!;
  const binding = within(row as HTMLElement).getByRole("button", { name: "n" });
  fireEvent.click(binding);
  fireEvent.keyDown(binding, { key: "y" });
  settings.unmount();

  press("n");
  expect(screen.queryByRole("region", { name: "Internal note" })).not.toBeInTheDocument();
  press("y");
  expect(await screen.findByRole("region", { name: "Internal note" })).toBeVisible();
  expect(screen.queryByRole("region", { name: "Reply to customer" })).not.toBeInTheDocument();
});


it.each([
  ["S", "Status"], ["P", "Priority"], ["A", "Assignee"],
])("Shift+%s focuses the existing %s control", async (key, label) => {
  await connectAndSync();
  renderFreshdesk("/freshdesk/ticket/1001");
  const region = within(await screen.findByRole("region", { name: "Ticket reader" }));
  const control = await region.findByRole("combobox", { name: label });
  fireEvent.keyDown(window, { key, shiftKey: true });
  expect(control).toHaveFocus();
});


it("ignores ticket actions in inputs, selects and nested editable text, including rebound modified keys", async () => {
  await connectAndSync();
  renderFreshdesk("/freshdesk/ticket/1001");
  await within(await screen.findByRole("region", { name: "Ticket reader" })).findByRole("button", { name: "Reply" });
  act(() => useShortcutStore.getState().setKey("ticket.note", "Alt+N"));
  const targets = [document.createElement("input"), document.createElement("textarea"), document.createElement("select")];
  const editable = document.createElement("div");
  editable.setAttribute("contenteditable", "true");
  const child = document.createElement("span");
  editable.append(child);
  document.body.append(editable, ...targets);
  for (const target of [...targets, child]) {
    fireEvent.keyDown(target, { key: "n", altKey: true });
    fireEvent.keyDown(target, { key: "r" });
  }
  expect(screen.queryByRole("region", { name: "Internal note" })).not.toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Reply to customer" })).not.toBeInTheDocument();
  editable.remove();
  targets.forEach((target) => target.remove());
  fireEvent.keyDown(window, { key: "n", altKey: true });
  expect(await screen.findByRole("region", { name: "Internal note" })).toBeVisible();
});


it("switches the current ticket view between list and board with b", async () => {
  await connectAndSync();
  renderFreshdesk();
  const list = await screen.findByRole("button", { name: "List", exact: true });
  const board = screen.getByRole("button", { name: "Board", exact: true });
  expect(list).toHaveAttribute("aria-pressed", "true");
  press("b");
  await waitFor(() => expect(board).toHaveAttribute("aria-pressed", "true"));
  press("b");
  await waitFor(() => expect(list).toHaveAttribute("aria-pressed", "true"));
});


it("opens tickets with the registry's Enter default and stops using Enter after rebinding", async () => {
  await connectAndSync();
  renderFreshdesk();
  await screen.findByText("Fixture: export stuck");
  act(() => useShortcutStore.getState().setKey("nav.open", "y"));
  press("Enter");
  expect(within(reader()).getByText("Select a ticket to read")).toBeInTheDocument();
  press("y");
  await within(reader()).findByRole("heading", { level: 2 });
});
