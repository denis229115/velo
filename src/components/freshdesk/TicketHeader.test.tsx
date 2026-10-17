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
import { ALPHA_HOST, type FixtureConversation, type FreshdeskFixtureTenant } from "@/services/freshdesk/__fixtures__/freshdeskFixtures";
import { FIXTURE_NOW, ME_ID } from "@/services/freshdesk/__fixtures__/freshdeskTicketFixtures";
import { alphaTenantWithHistory } from "@/services/freshdesk/__fixtures__/freshdeskConversationFixtures";
import { ALPHA_TOKEN, alphaExportBugDone, clickupTokens } from "@/services/clickup/__fixtures__/clickupFixtures";

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
import { linkTask, refreshRelatedTasks } from "@/services/clickup/links";
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

/** 1006 with an agent reply after the customer's request: an outstanding ticket that is answered */
function tenantWithAnswered1006(): FreshdeskFixtureTenant {
  const at = new Date(FIXTURE_NOW - 2 * HOUR).toISOString().replace(/\.\d{3}Z$/, "Z");
  const reply: FixtureConversation = {
    id: 7000000900,
    body: "<p>Fixed on our side.</p>",
    body_text: "Fixed on our side.",
    incoming: false,
    private: false,
    source: 0,
    ticket_id: 1006,
    user_id: ME_ID,
    support_email: null,
    from_email: null,
    to_emails: [],
    cc_emails: [],
    bcc_emails: [],
    attachments: [],
    automation_id: null,
    automation_type_id: null,
    created_at: at,
    updated_at: at,
  };
  return { ...alphaTenantWithHistory, conversations: { ...alphaTenantWithHistory.conversations, 1006: [reply] } };
}

async function connectAndSync(tenant: FreshdeskFixtureTenant = alphaTenantWithHistory) {
  freshdesk = createFreshdeskFetchStub({ [ALPHA_HOST]: { apiKey: ALPHA_KEY, tenant } });
  await connectHelpdesk({ host: ALPHA_HOST, apiKey: ALPHA_KEY });
  for (const [id, cls] of [["2", "open"], ["3", "waiting"], ["4", "done"], ["5", "done"], ["6", "open"]] as const) {
    await classifyStatus(id, cls);
  }
  await syncTickets({ trigger: "manual" });
}

const reader = () => within(screen.getByRole("region", { name: "Ticket reader" }));
const header = () => within(reader().getByRole("group", { name: "Ticket header" }));
const attention = () => reader().queryByRole("note", { name: "Attention" });
const text = (el: HTMLElement | null) => el?.textContent?.replace(/\s+/g, " ").trim();
const metric = (label: string) => text(reader().getByRole("definition", { name: label }));
const opened1001 = async () => {
  renderFreshdesk("/freshdesk/ticket/1001");
  await waitFor(() => expect(header().getByRole("heading", { level: 2 })).toBeInTheDocument());
};

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXTURE_NOW);
  db = createSqliteTestDb();
  freshdesk = createFreshdeskFetchStub({ [ALPHA_HOST]: { apiKey: ALPHA_KEY, tenant: alphaTenantWithHistory } });
  clickup = createClickUpFetchStub(clickupTokens);
  opened.urls.length = 0;
  await runMigrations();
  resetHydrationState();
  useTicketStore.setState(useTicketStore.getInitialState(), true);
  useUIStore.setState({ isOnline: true, timeZoneOverride: "Europe/London", extraTimeZones: ["Europe/Berlin"] });
});

afterEach(async () => {
  await hydrateTicketHistories().catch(() => {});
  resetHydrationState();
  vi.useRealTimers();
  db.close();
});

describe("ticket header: identity and actions", () => {
  it("shows the breadcrumb, the ticket ID and the subject as the page title", async () => {
    await connectAndSync();
    renderFreshdesk("/freshdesk/ticket/1001");

    await waitFor(() => expect(header().getByRole("heading", { level: 2 })).toHaveTextContent("Fixture: cannot sign in"));
    expect(text(header().getByRole("navigation", { name: "Breadcrumb" }))).toBe("Freshdesk › Tickets");
    expect(header().getByText("#1001")).toBeInTheDocument();
    expect(header().queryByText("Sample")).not.toBeInTheDocument();
  });

  it("opens the composer in Reply to customer or Internal note mode, without writing to Freshdesk", async () => {
    await connectAndSync();
    await opened1001();

    for (const [name, region] of [["Reply", "Reply to customer"], ["Internal note", "Internal note"]] as const) {
      const button = await header().findByRole("button", { name });
      expect(button).not.toHaveAttribute("aria-disabled");
      freshdesk.requests.length = 0;
      fireEvent.click(button);
      expect(await screen.findByRole("region", { name: region })).toBeInTheDocument();
      expect(freshdesk.requests.filter((r) => r.method !== "GET")).toEqual([]);
    }
  });

  it("opens the ticket in Freshdesk and copies its link from the more menu", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await connectAndSync();
    await opened1001();

    fireEvent.click(await header().findByRole("button", { name: "More actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Open in Freshdesk" }));
    await waitFor(() => expect(opened.urls).toEqual([`https://${ALPHA_HOST}/a/tickets/1001`]));

    fireEvent.click(header().getByRole("button", { name: "More actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy ticket link" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`https://${ALPHA_HOST}/a/tickets/1001`));
  });
});

describe("ticket header: attention line", () => {
  it("needs reply: one amber line with when the customer wrote and when it was last answered", async () => {
    await connectAndSync();
    renderFreshdesk("/freshdesk/ticket/1001");

    await waitFor(() => expect(text(attention())).toBe("Needs reply · Customer wrote 1 d ago · Last answered 1 d ago"));
    expect(attention()!.className).toMatch(/status-warning/);
  });

  it("names a ticket that was never answered once its history is complete", async () => {
    await connectAndSync();
    renderFreshdesk("/freshdesk/ticket/1002");

    await waitFor(() => expect(text(attention())).toMatch(/^Needs reply · Customer wrote .+ · Never answered$/));
  });

  it("answered: a quiet line with when it was answered", async () => {
    await connectAndSync(tenantWithAnswered1006());
    renderFreshdesk("/freshdesk/ticket/1006");

    await waitFor(() => expect(text(attention())).toBe("Answered 2 h ago"));
    expect(attention()!.className).not.toMatch(/status-warning/);
  });

  it("history loading: says Loading, never Never answered", async () => {
    await connectAndSync();
    freshdesk.respondOnce(ALPHA_HOST, "/api/v2/tickets/1001", { status: 429, body: {}, headers: { "Retry-After": "60" } });
    renderFreshdesk("/freshdesk/ticket/1001");

    await waitFor(() => expect(reader().getByText(/Loading conversation history/)).toBeInTheDocument());
    expect(text(attention())).toBe("Needs reply: Loading…");
    expect(reader().queryByText(/Never answered/)).not.toBeInTheDocument();
  });

  it("history partly loaded: says Unknown, never Never answered", async () => {
    await connectAndSync();
    freshdesk.respondOnce(ALPHA_HOST, "/api/v2/tickets/1007/conversations", {
      page: 2,
      status: 429,
      body: { message: "slow down" },
      headers: { "Retry-After": "60" },
    });
    renderFreshdesk("/freshdesk/ticket/1007");

    await waitFor(() => expect(reader().getByText(/History partly loaded/)).toBeInTheDocument());
    expect(text(attention())).toBe("Needs reply: Unknown");
    expect(reader().queryByText(/Never answered/)).not.toBeInTheDocument();
  }, 20_000);

  it("done: no attention line", async () => {
    await connectAndSync();
    renderFreshdesk("/freshdesk/ticket/1004");

    await waitFor(() => expect(header().getByRole("heading", { level: 2 })).toHaveTextContent("Fixture: refund issued"));
    await waitFor(() => expect(metric("Last answered")).not.toBe("Loading…"));
    expect(attention()).not.toBeInTheDocument();
  });
});

describe("ticket header: state pills", () => {
  it("shows status, priority and assignee as pills on the edit controls, with the group as a chip", async () => {
    await connectAndSync();
    await opened1001();

    const state = within(await reader().findByRole("group", { name: "Ticket state" }));
    await waitFor(() => expect(state.getByRole("button", { name: "Priority" })).toBeEnabled());
    // The status pill carries Freshdesk's exact label as text, not colour alone
    expect(state.getByTitle(/^Status: Open/)).toHaveTextContent("Open");
    expect(state.getByTitle("Priority: High")).toHaveTextContent("High");
    expect(state.getByTitle(/^Assignee: /)).toHaveTextContent("Fixture Operator");
    expect(state.getByTitle("Group: Fixture Billing")).toHaveTextContent("Fixture Billing");
    for (const name of ["Status", "Priority"]) expect(state.getByRole("button", { name })).toBeInTheDocument();
    expect(state.getByRole("combobox", { name: "Assignee" })).toBeInTheDocument();
  });

  it("sample ticket: Sample badge, pills that explain why they cannot change, no Freshdesk link", async () => {
    renderFreshdesk("/freshdesk/ticket/sample-1");

    await waitFor(() => expect(header().getByRole("heading", { level: 2 })).toHaveTextContent("Sample ticket: cannot sign in"));
    expect(header().getByText("Sample")).toBeInTheDocument();
    const state = within(reader().getByRole("group", { name: "Ticket state" }));
    for (const name of ["Status", "Priority"]) expect(state.getByRole("button", { name })).toBeDisabled();
    expect(state.getByRole("combobox", { name: "Assignee" })).toBeDisabled();

    fireEvent.click(header().getByRole("button", { name: "More actions" }));
    expect(await screen.findByRole("menuitem", { name: "Open in Freshdesk" })).toHaveAttribute("aria-disabled", "true");
  });
});

describe("ticket header: people and timing", () => {
  it("shows the customer with initials, email, channel and created time, then the three-part timeline", async () => {
    await connectAndSync();
    await opened1001();

    const people = within(await reader().findByRole("group", { name: "Customer" }));
    expect(people.getByText("FA")).toBeInTheDocument();
    expect(people.getByText("Fixture Customer Ada")).toBeInTheDocument();
    await waitFor(() => expect(people.getByText("ada.fixture@example.test")).toBeInTheDocument());
    await waitFor(() => expect(people.getByText("Email")).toBeInTheDocument());
    expect(people.getByText(/Created/)).toBeInTheDocument();

    await waitFor(() => expect(metric("Last answered")).toBe("1 d ago"));
    expect(metric("Customer wrote")).toBe("1 d ago");
    expect(metric("Updated")).toBe("1 d ago");
  });

  it("keeps Last internal note and Last activity behind a keyboard-operable Details disclosure", async () => {
    await connectAndSync();
    await opened1001();

    const details = await reader().findByRole("button", { name: "Details" });
    expect(details).toHaveAttribute("aria-expanded", "false");
    expect(reader().queryByRole("definition", { name: "Last internal note" })).not.toBeInTheDocument();
    expect(reader().queryByRole("definition", { name: "Last activity" })).not.toBeInTheDocument();

    details.focus();
    expect(details).toHaveFocus();
    fireEvent.click(details);
    expect(details).toHaveAttribute("aria-expanded", "true");
    await waitFor(() => expect(metric("Last internal note")).toBe("1 d ago"));
    expect(metric("Last activity")).toBe("1 d ago");
    expect(document.getElementById(details.getAttribute("aria-controls") ?? "")).toBeInTheDocument();
  });

  it("keeps the exact time and the extra time zones on hover", async () => {
    await connectAndSync();
    renderFreshdesk("/freshdesk/ticket/1001");

    await waitFor(() => expect(metric("Last answered")).toBe("1 d ago"));
    // Last answered: 44 h before 2026-10-14 12:00Z is 12 Oct 16:00Z: 17:00 in London, 18:00 in Berlin
    fireEvent.mouseEnter(within(reader().getByRole("definition", { name: "Last answered" })).getByText("1 d ago"));
    const rows = within(screen.getByRole("tooltip")).getAllByRole("row").map((r) => r.textContent ?? "");
    expect(rows[0]).toMatch(/Europe\/London/);
    expect(rows[1]).toMatch(/Europe\/Berlin/);
  });
});

describe("ticket header: linked work", () => {
  const linked = () => within(reader().getByRole("region", { name: "Linked work" }));

  it("without a connected workspace: a one-line Connect ClickUp hint", async () => {
    await connectAndSync();
    renderFreshdesk("/freshdesk/ticket/1002");

    await waitFor(() => expect(linked().getByRole("button", { name: "Connect ClickUp" })).toBeInTheDocument());
    expect(reader().queryByRole("region", { name: "Related tasks" })).not.toBeInTheDocument();
  });

  it("with a workspace and no linked tasks: says so and offers Link task", async () => {
    await connectAndSync();
    await connectWorkspace({ token: ALPHA_TOKEN });
    renderFreshdesk("/freshdesk/ticket/1002");

    await waitFor(() => expect(linked().getByText("No linked tasks")).toBeInTheDocument());
    fireEvent.click(linked().getByRole("button", { name: "Link task" }));
    expect(await screen.findByRole("dialog", { name: "Link a ClickUp task" })).toBeInTheDocument();
  });

  it("with linked tasks: counts them and opens the full Related tasks list", async () => {
    await connectAndSync();
    await connectWorkspace({ token: ALPHA_TOKEN });
    await linkTask({ kind: "ticket", ticketId: "1002" }, "86a0exp01");
    renderFreshdesk("/freshdesk/ticket/1002");

    await waitFor(() => expect(text(linked().getByTestId("linked-work-count"))).toBe("1 task · 0 done"));
    expect(reader().queryByRole("region", { name: "Related tasks" })).not.toBeInTheDocument();

    const toggle = linked().getByRole("button", { name: "Show tasks" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    const panel = within(await reader().findByRole("region", { name: "Related tasks" }));
    expect(await panel.findByText("Fixture: export fails for large accounts")).toBeInTheDocument();
    expect(linked().getByRole("button", { name: "Hide tasks" })).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps the Follow-up cue in view when a linked task is done, with the list closed", async () => {
    await connectAndSync();
    await connectWorkspace({ token: ALPHA_TOKEN });
    const item = { kind: "ticket" as const, ticketId: "1002" };
    await linkTask(item, "86a0exp01");
    // The backlinks are written; what follows must change nothing in the helpdesk
    freshdesk.requests.length = 0;
    clickup.replaceTask(alphaExportBugDone);
    await refreshRelatedTasks(item, { trigger: "manual" });
    renderFreshdesk("/freshdesk/ticket/1002");

    await waitFor(() => expect(text(linked().getByTestId("linked-work-count"))).toBe("1 task · 1 done"));
    expect(linked().getByText("Follow up with customer")).toBeInTheDocument();
    expect(freshdesk.requests.filter((r) => r.method !== "GET")).toHaveLength(0);
  });
});
