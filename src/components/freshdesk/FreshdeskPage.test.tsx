import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
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
import { FreshdeskPage } from "./FreshdeskPage";

vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});

function Shell() {
  useKeyboardShortcuts();
  return <Outlet />;
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

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXTURE_NOW);
  db = createSqliteTestDb();
  stub = createFreshdeskFetchStub({ [ALPHA_HOST]: { apiKey: ALPHA_KEY, tenant: alphaTenantWithTickets } });
  await runMigrations();
  useTicketStore.setState(useTicketStore.getInitialState(), true);
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

    expect(await screen.findByRole("heading", { name: "Tickets" })).toBeInTheDocument();
    await screen.findByText("Fixture: export stuck");
    // Done ticket 1004 is downloaded but not outstanding
    expect(rowIds()).toEqual(["1003", "1001", "1002", "1007", "1008", "1006"]);

    const row = within(screen.getByRole("button", { name: /^Ticket #1002/ }));
    expect(row.getByText("#1002")).toBeInTheDocument();
    expect(row.getByText("Fixture: export stuck")).toBeInTheDocument();
    expect(row.getByText("Fixture Customer Bo")).toBeInTheDocument();
    expect(row.getByText("Fixture: With engineering")).toBeInTheDocument();
    expect(row.getByText("Medium")).toBeInTheDocument();
    expect(row.getByText("Fixture Colleague")).toBeInTheDocument();
    // The row's own time (last updated) comes after the activity times
    expect(Array.from(screen.getByRole("button", { name: /^Ticket #1002/ }).querySelectorAll("time")).pop()).toHaveAttribute("dateTime", new Date(FIXTURE_NOW - 3 * 86_400_000).toISOString());

    // The unknown status is labelled, not hidden; an unassigned ticket says so
    expect(within(screen.getByRole("button", { name: /^Ticket #1003/ })).getByText("Unknown status")).toBeInTheDocument();
    expect(within(screen.getByRole("button", { name: /^Ticket #1008/ })).getByText("Unassigned")).toBeInTheDocument();

    expect(within(reader()).getByText("Select a ticket to read")).toBeInTheDocument();
  });

  it("filters to My open tickets: the verified me in open-classified statuses", async () => {
    await connectAndSync();
    renderFreshdesk();
    await screen.findByText("Fixture: export stuck");

    fireEvent.click(screen.getByRole("tab", { name: "My open tickets" }));

    // Not 1003 (mine, unknown status), 1006 (mine, waiting), 1007 (a namesake's)
    expect(rowIds()).toEqual(["1001"]);
  });

  it("moves through the list with j/k and opens with Enter, in the reader on the right", async () => {
    await connectAndSync();
    const router = renderFreshdesk();
    await screen.findByText("Fixture: export stuck");

    press("Enter");
    expect(await within(reader()).findByRole("heading", { name: "Fixture: status Velo does not know" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Ticket #1003/ })).toHaveAttribute("aria-selected", "true");

    press("j");
    expect(await within(reader()).findByRole("heading", { name: "Fixture: cannot sign in" })).toBeInTheDocument();
    press("j");
    expect(await within(reader()).findByRole("heading", { name: "Fixture: export stuck" })).toBeInTheDocument();
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
