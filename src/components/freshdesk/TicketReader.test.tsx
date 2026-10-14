import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import { FIXTURE_NOW } from "@/services/freshdesk/__fixtures__/freshdeskTicketFixtures";
import { alphaTenantWithHistory } from "@/services/freshdesk/__fixtures__/freshdeskConversationFixtures";

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
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
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
import { useUIStore } from "@/stores/uiStore";
import { useTicketStore } from "@/stores/ticketStore";
import { FreshdeskPage } from "./FreshdeskPage";

vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

const HOUR = 3_600_000;

function renderFreshdesk(path = "/freshdesk") {
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

async function connectAndSync() {
  await connectHelpdesk({ host: ALPHA_HOST, apiKey: ALPHA_KEY });
  for (const [id, cls] of [["2", "open"], ["3", "waiting"], ["4", "done"], ["5", "done"], ["6", "open"]] as const) {
    await classifyStatus(id, cls);
  }
  await syncTickets({ trigger: "manual" });
}

const reader = () => within(screen.getByRole("region", { name: "Ticket reader" }));
const entries = () => within(reader().getByRole("list", { name: "Conversation history" })).getAllByRole("article");
const metric = (label: string) => reader().getByRole("definition", { name: label }).textContent?.replace(/\s+/g, " ").trim();

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXTURE_NOW);
  db = createSqliteTestDb();
  stub = createFreshdeskFetchStub({ [ALPHA_HOST]: { apiKey: ALPHA_KEY, tenant: alphaTenantWithHistory } });
  await runMigrations();
  resetHydrationState();
  useTicketStore.setState(useTicketStore.getInitialState(), true);
  useUIStore.setState({ timeZoneOverride: "Europe/London", extraTimeZones: ["Europe/Berlin"] });
});

afterEach(async () => {
  await hydrateTicketHistories().catch(() => {});
  vi.useRealTimers();
  db.close();
  delete (window as { __pwned?: boolean }).__pwned;
});

describe("ticket reader", () => {
  it("shows the request and every conversation in order with badge, author and time", async () => {
    await connectAndSync();
    renderFreshdesk("/freshdesk/ticket/1001");

    await waitFor(() => expect(entries()).toHaveLength(4));
    const [request, reply, note, customer] = entries().map((e) => within(e));
    expect(request!.getByText("Original request")).toBeInTheDocument();
    expect(request!.getByText("Fixture Customer Ada")).toBeInTheDocument();
    expect(reply!.getByText("Public reply")).toBeInTheDocument();
    expect(reply!.getByText("Fixture Operator")).toBeInTheDocument();
    expect(reply!.getByText("1 d ago")).toBeInTheDocument();
    expect(note!.getByText("Internal note")).toBeInTheDocument();
    expect(note!.getByText("Fixture Colleague")).toBeInTheDocument();
    expect(note!.getByText("1 d ago")).toBeInTheDocument();
    expect(customer!.getByText("Customer")).toBeInTheDocument();
    expect(customer!.getByText("Fixture Customer Ada")).toBeInTheDocument();
  });

  it("badges automated replies, public notes and logged phone calls, none of which answer the ticket", async () => {
    await connectAndSync();
    renderFreshdesk("/freshdesk/ticket/1002");

    await waitFor(() => expect(entries()).toHaveLength(5));
    expect(entries().map((e) => within(e).getByTestId("entry-kind").textContent)).toEqual([
      "Original request",
      "Automated reply",
      "Public note",
      "Logged interaction",
      "Internal note",
    ]);
    expect(metric("Last answered")).toBe("Never answered");
    expect(metric("Needs reply")).toBe("Yes");
  });

  it("shows Last answered, Last customer message and Last internal note, each with the zones on hover (A05)", async () => {
    await connectAndSync();
    renderFreshdesk("/freshdesk/ticket/1001");

    await waitFor(() => expect(metric("Last answered")).toBe("1 d ago"));
    expect(metric("Last customer message")).toBe("1 d ago");
    expect(metric("Last internal note")).toBe("1 d ago");
    expect(metric("Needs reply")).toBe("Yes");

    // Last answered: 44 h before 2026-10-14 12:00Z is 12 Oct 16:00Z: 17:00 in London, 18:00 in Berlin
    fireEvent.mouseEnter(within(reader().getByRole("definition", { name: "Last answered" })).getByText("1 d ago"));
    const rows = within(screen.getByRole("tooltip")).getAllByRole("row").map((r) => r.textContent ?? "");
    expect(rows[0]).toMatch(/Europe\/London/);
    expect(rows[0]).toMatch(/17:00|5:00\sPM/);
    expect(rows[1]).toMatch(/Europe\/Berlin/);
    expect(rows[1]).toMatch(/18:00|6:00\sPM/);
  });

  it("shows Unknown, not Never answered, while the history is only partly loaded (A06)", async () => {
    await connectAndSync();
    stub.respondOnce(ALPHA_HOST, "/api/v2/tickets/1007/conversations", {
      page: 2,
      status: 429,
      body: { message: "slow down" },
      headers: { "Retry-After": "60" },
    });
    renderFreshdesk("/freshdesk/ticket/1007");

    await waitFor(() => expect(reader().getByText(/History partly loaded/)).toBeInTheDocument());
    expect(metric("Last answered")).toBe("Unknown");
    expect(metric("Last customer message")).toBe("Unknown");
    expect(metric("Needs reply")).toBe("Unknown");
    expect(reader().queryByText("Never answered")).not.toBeInTheDocument();

    // The 100 loaded conversations: the request and the latest 20 show, earlier ones on request
    expect(entries()).toHaveLength(21);
    fireEvent.click(reader().getByRole("button", { name: "Show 80 earlier conversations" }));
    expect(entries()).toHaveLength(101);
    // Rendering 101 sandboxed frames in jsdom is slow under a loaded test run
  }, 20_000);

  it("shows Loading for a ticket whose history has not been read yet", async () => {
    await connectAndSync();
    // Hold every history request so the reader stays in its loading state
    stub.respondOnce(ALPHA_HOST, "/api/v2/tickets/1001", { status: 429, body: {}, headers: { "Retry-After": "60" } });
    renderFreshdesk("/freshdesk/ticket/1001");

    await waitFor(() => expect(reader().getByText(/Loading conversation history/)).toBeInTheDocument());
    expect(metric("Last answered")).toBe("Loading…");
  });

  it("renders hostile ticket HTML without running script or loading remote content", async () => {
    await connectAndSync();
    renderFreshdesk("/freshdesk/ticket/1001");

    await waitFor(() => expect(entries()).toHaveLength(4));
    const frame = within(entries()[0]!).getByTitle("Email content") as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("allow-same-origin");
    const html = frame.contentDocument!.body.innerHTML;
    expect(html).toContain("I cannot sign in since this morning.");
    expect(html).not.toMatch(/<script|<iframe|<link|<form|onerror|javascript:/i);
    expect(html).not.toMatch(/(?<![-\w])src="(https?:)?\/\/|url\(\s*["']?(https?:)?\/\//i);
    expect((window as { __pwned?: boolean }).__pwned).toBeUndefined();

    // An attachment's hostile name is shown as text, never as markup
    const attachment = within(entries()[1]!).getByRole("button", { name: /steps\.pdf/ });
    expect(attachment.querySelector("img")).toBeNull();
  });
});

describe("ticket list activity columns", () => {
  it("shows Last answered and Last customer message once a history is loaded, Loading before", async () => {
    await connectAndSync();
    stub.respondOnce(ALPHA_HOST, "/api/v2/tickets/1001", { status: 429, body: {}, headers: { "Retry-After": "30" } });
    renderFreshdesk();
    const row = () => screen.getByRole("button", { name: /^Ticket #1001/ });
    await waitFor(() => expect(row()).toHaveAccessibleName(expect.stringMatching(/last answered loading/i)));
    expect(within(row()).getAllByText("Loading…")).toHaveLength(2);

    vi.setSystemTime(FIXTURE_NOW + 31_000);
    await act(async () => {
      await hydrateTicketHistories({ openedId: "1001" });
    });
    await waitFor(() =>
      expect(row()).toHaveAccessibleName(
        expect.stringMatching(/last answered 1 d ago, last customer message 1 d ago, needs reply/i),
      ),
    );
    expect(within(row()).getByText("Answered")).toBeInTheDocument();
    expect(within(row()).getByText("Needs reply")).toBeInTheDocument();
  });
});
