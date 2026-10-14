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
  COLLEAGUE_ID,
  accessDenied,
  alphaTenantWithTickets,
  closureFieldMissing,
  invalidAssignee,
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
  // View writes queue behind the database mutex; one more read waits them out
  cleanup();
  await useTicketStore.getState().loadViews().catch(() => {});
  resetHydrationState();
  vi.useRealTimers();
  db.close();
});

describe("editing a ticket in the reader", () => {
  async function readerOn(ticketId: string) {
    await connectAndSync();
    renderFreshdesk(`/freshdesk/ticket/${ticketId}`);
    await waitFor(() => expect(within(reader()).getByRole("combobox", { name: "Priority" })).toBeEnabled());
    stub.requests.length = 0;
  }
  const control = (name: string) => within(reader()).getByRole("combobox", { name }) as HTMLSelectElement;

  it("changes priority and assignee inline; Freshdesk and the local copy both update", async () => {
    await readerOn("1001");
    expect(control("Priority").value).toBe("3");

    fireEvent.change(control("Priority"), { target: { value: "4" } });
    await waitFor(() => expect(writes()).toHaveLength(1));
    fireEvent.change(control("Assignee"), { target: { value: String(COLLEAGUE_ID) } });
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes().map((w) => w.body)).toEqual([{ priority: 4 }, { responder_id: COLLEAGUE_ID }]);

    // The local copy holds Freshdesk's answer, so it survives a restart
    await restart();
    const row = screen.getByRole("button", { name: /^Ticket #1001/ });
    expect(within(row).getByTitle("Priority: Urgent")).toBeInTheDocument();
    fireEvent.click(row);
    await waitFor(() => expect(control("Assignee").value).toBe(String(COLLEAGUE_ID)));
    expect(control("Priority").value).toBe("4");
  });

  it("changes the status inline with the same status write", async () => {
    await readerOn("1001");
    fireEvent.change(control("Status"), { target: { value: "6" } });
    await waitFor(() => expect(writes()).toEqual([expect.objectContaining({ body: { status: 6 } })]));
    await waitFor(() => expect(control("Status").value).toBe("6"));
  });

  it("a rejected change rolls back and shows Freshdesk's reason", async () => {
    await readerOn("1001");
    stub.respondOnce(ALPHA_HOST, "/api/v2/tickets/1001", invalidAssignee);
    fireEvent.change(control("Assignee"), { target: { value: String(COLLEAGUE_ID) } });

    expect(await within(reader()).findByRole("alert")).toHaveTextContent(
      "Assignee stays Fixture Operator. Freshdesk did not accept the change: There is no agent matching the given responder_id (responder_id)",
    );
    expect(control("Assignee").value).toBe("9000000002");

    stub.respondOnce(ALPHA_HOST, "/api/v2/tickets/1001", accessDenied);
    fireEvent.change(control("Priority"), { target: { value: "1" } });
    await waitFor(() => expect(within(reader()).getByRole("alert")).toHaveTextContent("Priority stays High."));
    expect(control("Priority").value).toBe("3");
  });

  it("offline, every edit control is disabled with the reason, nothing is sent, and they re-enable on reconnect", async () => {
    await readerOn("1001");
    const sent = stub.requests.length;
    act(() => useUIStore.setState({ isOnline: false }));

    for (const name of ["Status", "Priority", "Assignee"]) {
      expect(control(name)).toBeDisabled();
      expect(control(name)).toHaveAccessibleDescription("Needs a connection to Freshdesk");
    }
    expect(within(reader()).getByRole("status")).toHaveTextContent("Needs a connection to Freshdesk");
    fireEvent.change(control("Priority"), { target: { value: "1" } });
    expect(writes()).toEqual([]);
    expect(stub.requests.length).toBe(sent);

    act(() => useUIStore.setState({ isOnline: true }));
    for (const name of ["Status", "Priority", "Assignee"]) expect(control(name)).toBeEnabled();
    expect(within(reader()).queryByRole("status")).not.toBeInTheDocument();
  });

  it("disables the edit controls while the helpdesk connection is known to be unavailable", async () => {
    await readerOn("1001");
    act(() =>
      useTicketStore.setState((s) => ({ data: s.data && { ...s.data, sync: { ...s.data.sync, state: "error" as const } } })),
    );
    for (const name of ["Status", "Priority", "Assignee"]) expect(control(name)).toBeDisabled();
    expect(within(reader()).getByRole("status")).toHaveTextContent("Needs a connection to Freshdesk");
  });
});
