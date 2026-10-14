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
import {
  FIXTURE_NOW,
  accessDenied,
  alphaTenantWithTickets,
  closureFieldMissing,
} from "@/services/freshdesk/__fixtures__/freshdeskTicketFixtures";

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

// Drag and drop: the board's DndContext hands its drop handler to the test, which plays the pointer
const dnd = vi.hoisted(() => ({ onDragEnd: null as null | ((event: unknown) => void) }));
vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>();
  return {
    ...actual,
    DndContext: ({ children, onDragEnd }: { children: React.ReactNode; onDragEnd: (event: unknown) => void }) => {
      dnd.onDragEnd = onDragEnd;
      return children;
    },
    DragOverlay: () => null,
    useDraggable: () => ({ attributes: {}, listeners: {}, setNodeRef: () => {}, isDragging: false }),
    useDroppable: () => ({ setNodeRef: () => {}, isOver: false }),
  };
});

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
import { useUIStore } from "@/stores/uiStore";
import { FreshdeskPage } from "./FreshdeskPage";
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

const cards = () => screen.queryAllByRole("article", { name: /^Ticket #/ });
const cardIds = () => cards().map((c) => c.getAttribute("aria-label")?.match(/^Ticket #([\w-]+)/)?.[1]);
const column = (label: string) => screen.getByRole("region", { name: `${label} column` });
const columnIds = (label: string) =>
  within(column(label)).queryAllByRole("article").map((c) => c.getAttribute("aria-label")?.match(/^Ticket #([\w-]+)/)?.[1]);
const writes = () => stub.requests.filter((r) => r.method !== "GET");
async function openBoard() {
  fireEvent.click(await screen.findByRole("button", { name: "Board" }));
  await waitFor(() => expect(cards().length).toBeGreaterThan(0));
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
  await waitFor(() => expect(rows().length + cards().length).toBeGreaterThan(0));
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXTURE_NOW);
  db = createSqliteTestDb();
  stub = createFreshdeskFetchStub({ [ALPHA_HOST]: { apiKey: ALPHA_KEY, tenant: alphaTenantWithTickets } });
  await runMigrations();
  useTicketStore.setState(useTicketStore.getInitialState(), true);
  useUIStore.setState({ isOnline: true });
});

afterEach(async () => {
  // Let background history reads finish before the database goes away
  await hydrateTicketHistories().catch(() => {});
  resetHydrationState();
  vi.useRealTimers();
  db.close();
});

describe("Freshdesk ticket board", () => {
  it("has one column per status by ID, empty ones too, done columns collapsed but expandable", async () => {
    await connectAndSync();
    renderFreshdesk();
    await openBoard();

    const board = screen.getByRole("region", { name: "Ticket board" });
    const names = within(board)
      .getAllByRole("region")
      .map((r) => r.getAttribute("aria-label"));
    expect(names).toEqual([
      "Open column",
      "Pending column",
      "Resolved column",
      "Closed column",
      "Fixture: With engineering column",
      "Unknown status (ID 9) column",
    ]);
    expect(columnIds("Open").sort()).toEqual(["1001", "1007", "1008"]);
    expect(columnIds("Pending")).toEqual(["1006"]);
    expect(columnIds("Fixture: With engineering")).toEqual(["1002"]);
    expect(columnIds("Unknown status (ID 9)")).toEqual(["1003"]);

    // Done columns are collapsed, and say so
    const resolved = within(column("Resolved")).getByRole("button", { name: /Resolved/ });
    expect(resolved).toHaveAttribute("aria-expanded", "false");
    expect(columnIds("Resolved")).toEqual([]);
    fireEvent.click(resolved);
    expect(within(column("Resolved")).getByRole("button", { name: /Collapse Resolved/ })).toHaveAttribute("aria-expanded", "true");
    expect(within(column("Resolved")).getByText("No tickets in this view")).toBeInTheDocument();
  });

  it("shows exactly the list's tickets for the view; switching keeps the filters and persists (A04)", async () => {
    await connectAndSync();
    renderFreshdesk();
    await waitFor(() => expect(rows().length).toBeGreaterThan(0));
    fireEvent.click(await sidebarView("My open tickets"));
    await waitFor(() => expect(rowIds()).toEqual(["1001"]));
    const listed = rowIds();

    await openBoard();
    expect(cardIds().sort()).toEqual([...listed].sort());
    expect(screen.getByRole("button", { name: "Board" })).toHaveAttribute("aria-pressed", "true");

    await restart();
    expect(screen.getByRole("button", { name: "Board" })).toHaveAttribute("aria-pressed", "true");
    expect(cardIds().sort()).toEqual([...listed].sort());

    fireEvent.click(screen.getByRole("button", { name: "List" }));
    await waitFor(() => expect(rowIds()).toEqual(listed));
  });

  it("cards show subject, ID, customer, priority, assignee, Last answered age and linked work; Linked work only applies", async () => {
    await connectAndSync();
    renderFreshdesk();
    await openBoard();
    act(() => useTicketStore.setState({ linkedWork: new Map([["1002", { count: 2, done: 0 }]]) }));

    const card = within(screen.getByRole("article", { name: /^Ticket #1002/ }));
    expect(card.getByText("Fixture: export stuck")).toBeInTheDocument();
    expect(card.getByText("#1002")).toBeInTheDocument();
    expect(card.getByText("Fixture Customer Bo")).toBeInTheDocument();
    expect(card.getByTitle("Priority: Medium")).toBeInTheDocument();
    expect(card.getByText("Fixture Colleague")).toBeInTheDocument();
    expect(card.getByText(/Last answered|Never answered/)).toBeInTheDocument();
    expect(card.getByTitle("Linked ClickUp tasks: 2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Linked work only" }));
    await waitFor(() => expect(cardIds()).toEqual(["1002"]));
    // Columns stay, so the board never pretends the other statuses vanished
    expect(column("Open")).toBeInTheDocument();
  });
});
