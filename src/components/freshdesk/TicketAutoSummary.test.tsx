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
import type { FixtureConversation, FreshdeskFixtureTenant } from "@/services/freshdesk/__fixtures__/freshdeskFixtures";
import { FIXTURE_NOW } from "@/services/freshdesk/__fixtures__/freshdeskTicketFixtures";
import { ADA, alphaTenantWithHistory } from "@/services/freshdesk/__fixtures__/freshdeskConversationFixtures";
import type { AiCompletionRequest } from "@/services/ai/types";

// ── A fake Claude client at the provider-client interface: nothing leaves the machine ──
const ai = vi.hoisted(() => ({
  captured: [] as AiCompletionRequest[],
  respond: (_req: AiCompletionRequest): Promise<string> => Promise.resolve(""),
}));
vi.mock("@/services/ai/providers/claudeProvider", () => ({
  createClaudeProvider: vi.fn(() => ({
    complete: (request: AiCompletionRequest) => {
      ai.captured.push(request);
      return ai.respond(request);
    },
    testConnection: async () => true,
  })),
  clearClaudeProvider: vi.fn(),
}));

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
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

// The app router, swapped for one holding just the Freshdesk routes on a memory history
const testRouter = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/router", () => ({
  get router() {
    return testRouter.current;
  },
}));

import { AUTO_SUMMARY_DEBOUNCE_MS, AUTO_SUMMARY_MIN_INTERVAL_MS } from "@/services/freshdesk/ticketAutoSummary";
import { runMigrations } from "@/services/db/migrations";
import { classifyStatus, connectHelpdesk } from "@/services/freshdesk/connection";
import { syncTickets } from "@/services/freshdesk/ticketSync";
import { hydrateTicketHistories, resetHydrationState } from "@/services/freshdesk/ticketHistory";
import { setSetting } from "@/services/db/settings";
import { listAiAuditLog } from "@/services/db/aiAuditLog";
import { clearProviderClients } from "@/services/ai/providerManager";
import { AiSendPreviewHost } from "@/components/ai/AiSendPreview";
import { useTicketStore } from "@/stores/ticketStore";
import { useUIStore } from "@/stores/uiStore";
import { FreshdeskPage } from "./FreshdeskPage";

vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});

function Shell() {
  return (
    <>
      <Outlet />
      <AiSendPreviewHost />
    </>
  );
}

function renderFreshdesk(path: string) {
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

// The helpdesk of this test: a copy, so new messages never reach other tests
let tenant: FreshdeskFixtureTenant;
let messageNo = 0;

/** Messages arrive on ticket 1001 at the helpdesk; Velo's sync reads them together */
async function arrives(kind: "customer" | "note", ...texts: string[]) {
  let at = "";
  for (const text of texts) {
    at = new Date(FIXTURE_NOW + (++messageNo + 1) * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const message: FixtureConversation = {
      id: 7_100_000_000 + messageNo,
      body: `<p>${text}</p>`,
      body_text: text,
      incoming: kind === "customer",
      private: kind === "note",
      user_id: kind === "customer" ? ADA : 5000000009,
      source: kind === "note" ? 2 : 0,
      ticket_id: 1001,
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
    tenant.conversations![1001] = [...tenant.conversations![1001]!, message];
  }
  tenant.tickets = tenant.tickets.map((t) => (t.id === 1001 ? { ...t, updated_at: at } : t));
  await act(async () => {
    await syncTickets({ trigger: "manual" });
    await hydrateTicketHistories();
  });
}

const reader = () => within(screen.getByRole("region", { name: "Ticket reader" }));
const card = () => within(reader().getByRole("region", { name: "AI summary" }));
const SUMMARY_A = JSON.stringify({ issue: [{ text: "Summary A: the customer cannot sign in.", sources: [1] }], next_action: [{ text: "Ask for the error.", sources: [1] }] });
const SUMMARY_B = JSON.stringify({ issue: [{ text: "Summary B: the customer reports a new problem.", sources: [1] }], next_action: [{ text: "Check the logs.", sources: [1] }] });

async function approveClaude() {
  await setSetting("ai_provider", "claude");
  await setSetting("claude_api_key", "enc:fake-claude-key");
  await setSetting("ai_approved_provider", "claude");
}

/** Open ticket 1001 and take the operator's own first summary (preview confirmed) */
async function openWithSummary() {
  await connectHelpdesk({ host: ALPHA_HOST, apiKey: ALPHA_KEY });
  for (const [id, cls] of [["2", "open"], ["3", "waiting"], ["4", "done"], ["5", "done"], ["6", "open"]] as const) {
    await classifyStatus(id, cls);
  }
  await syncTickets({ trigger: "manual" });
  renderFreshdesk("/freshdesk/ticket/1001");
  await within(await screen.findByRole("region", { name: "Ticket reader" })).findByRole("heading", { level: 2 });
  await waitFor(() => expect(card().getByRole("button", { name: "Summarize" })).toBeEnabled());
  fireEvent.click(card().getByRole("button", { name: "Summarize" }));
  fireEvent.click(await screen.findByRole("button", { name: "Send to Claude API (Anthropic)" }));
  await card().findByText(/Summary A/);
  expect(ai.captured).toHaveLength(1);
}

const settle = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(async () => {
  vi.useFakeTimers();
  // Testing Library detects timer control through the Jest-compatible clock API.
  // Only system time is replaced; the shipped scheduler and intervals run unchanged.
  vi.stubGlobal("jest", { advanceTimersByTime: vi.advanceTimersByTime.bind(vi) });
  vi.setSystemTime(FIXTURE_NOW);
  db = createSqliteTestDb();
  tenant = {
    ...alphaTenantWithHistory,
    tickets: alphaTenantWithHistory.tickets.map((t) => ({ ...t })),
    conversations: { ...alphaTenantWithHistory.conversations },
  };
  stub = createFreshdeskFetchStub({ [ALPHA_HOST]: { apiKey: ALPHA_KEY, tenant } });
  await runMigrations();
  useTicketStore.setState(useTicketStore.getInitialState(), true);
  useUIStore.setState({ isOnline: true });
  ai.captured.length = 0;
  ai.respond = () => Promise.resolve(SUMMARY_A);
  messageNo = 0;
  clearProviderClients();
  await approveClaude();
});

afterEach(async () => {
  await hydrateTicketHistories().catch(() => {});
  cleanup();
  await useTicketStore.getState().loadViews().catch(() => {});
  resetHydrationState();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  db.close();
});

globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView = vi.fn();

describe("a summary that updates when new activity arrives", () => {
  it("refreshes through the gateway after a new customer message, labelled Updating with the old summary kept until the new one is ready", async () => {
    await openWithSummary();
    let release: (text: string) => void = () => undefined;
    ai.respond = () => new Promise<string>((resolve) => (release = resolve));

    await arrives("customer", "Now it fails with error 500.");

    // The old summary stays, labelled, while the request is out
    expect(await card().findByText(/Updating/)).toBeInTheDocument();
    expect(card().getByText(/Summary A/)).toBeInTheDocument();
    expect(card().queryByText(/Out of date/)).not.toBeInTheDocument();
    await settle(AUTO_SUMMARY_DEBOUNCE_MS);
    await waitFor(() => expect(ai.captured).toHaveLength(2));
    expect(JSON.stringify(ai.captured[1])).toContain("Now it fails with error 500.");
    expect(JSON.stringify(ai.captured[1])).toContain("From: customer");

    release(SUMMARY_B);
    expect(await card().findByText(/Summary B/)).toBeInTheDocument();
    expect(card().queryByText(/Summary A/)).not.toBeInTheDocument();
    expect(card().queryByText(/Updating/)).not.toBeInTheDocument();
    // Same audit trail as a manual summary
    expect(await listAiAuditLog()).toHaveLength(2);
    expect(card().getByText(/Sends to Claude API \(Anthropic\)/)).toBeInTheDocument();
  });

  it("is not triggered by an internal note, and the summary is not marked out of date", async () => {
    await openWithSummary();

    await arrives("note", "Internal: check the SSO logs.");
    await settle(AUTO_SUMMARY_DEBOUNCE_MS);

    expect(ai.captured).toHaveLength(1);
    expect(card().getByText(/Summary A/)).toBeInTheDocument();
    expect(card().queryByText(/Out of date|Updating/)).not.toBeInTheDocument();
  });

  it("gathers quick messages into one refresh", async () => {
    await openWithSummary();
    ai.respond = () => Promise.resolve(SUMMARY_B);

    await arrives("customer", "First follow-up.", "Second follow-up.");
    await settle(AUTO_SUMMARY_DEBOUNCE_MS);
    expect(await card().findByText(/Summary B/)).toBeInTheDocument();
    await settle(AUTO_SUMMARY_DEBOUNCE_MS);

    expect(ai.captured).toHaveLength(2);
    expect(JSON.stringify(ai.captured[1])).toContain("Second follow-up.");
  });

  it("waits for the interval before a second automatic refresh", async () => {
    await openWithSummary();
    ai.respond = () => Promise.resolve(SUMMARY_B);
    await arrives("customer", "First follow-up.");
    await settle(AUTO_SUMMARY_DEBOUNCE_MS);
    expect(await card().findByText(/Summary B/)).toBeInTheDocument();

    await arrives("customer", "Another follow-up.");
    await settle(AUTO_SUMMARY_DEBOUNCE_MS);
    expect(ai.captured).toHaveLength(2);
    expect(await card().findByText(/Out of date/)).toBeInTheDocument();

    await settle(AUTO_SUMMARY_MIN_INTERVAL_MS - AUTO_SUMMARY_DEBOUNCE_MS);
    await waitFor(() => expect(ai.captured).toHaveLength(3));
  });

  it("does not send offline, marks the summary out of date, and refreshes once back online", async () => {
    await openWithSummary();
    act(() => useUIStore.setState({ isOnline: false }));

    await arrives("customer", "Are you there?");
    await settle(AUTO_SUMMARY_DEBOUNCE_MS);
    expect(ai.captured).toHaveLength(1);
    expect(await card().findByText(/Out of date/)).toBeInTheDocument();
    expect(card().getByText(/Summary A/)).toBeInTheDocument();

    ai.respond = () => Promise.resolve(SUMMARY_B);
    act(() => useUIStore.setState({ isOnline: true }));
    await settle(AUTO_SUMMARY_DEBOUNCE_MS);
    expect(await card().findByText(/Summary B/)).toBeInTheDocument();
    expect(ai.captured).toHaveLength(2);
  });

  it("does not send what needs a send preview until the operator asks, and keeps contact details out (A23)", async () => {
    await openWithSummary();

    await arrives("customer", "Please call +44 20 7946 0999 or mail ada.fixture@example.test about card 4111 1111 1111 1111.");
    await settle(AUTO_SUMMARY_DEBOUNCE_MS);

    // No dialog opened, nothing sent, the old summary says it is out of date
    expect(screen.queryByRole("button", { name: "Send to Claude API (Anthropic)" })).not.toBeInTheDocument();
    expect(ai.captured).toHaveLength(1);
    expect(await card().findByText(/Out of date/)).toBeInTheDocument();

    // The operator's own request shows the preview first, then goes out with placeholders
    ai.respond = () => Promise.resolve(SUMMARY_B);
    fireEvent.click(card().getByRole("button", { name: "Update summary" }));
    fireEvent.click(await screen.findByRole("button", { name: "Send to Claude API (Anthropic)" }));
    expect(await card().findByText(/Summary B/)).toBeInTheDocument();
    const sent = JSON.stringify(ai.captured);
    expect(sent).not.toContain("7946");
    expect(sent).not.toContain("ada.fixture@example.test");
    expect(sent).not.toContain("4111");
  });

  it("stops after a failure: the old summary stays marked out of date and nothing is retried by itself", async () => {
    await openWithSummary();
    ai.respond = () => Promise.reject(new Error("fetch failed"));

    await arrives("customer", "Any update?");
    await settle(AUTO_SUMMARY_DEBOUNCE_MS);
    expect(await card().findByText(/Out of date/)).toBeInTheDocument();
    expect(card().getByText(/Summary A/)).toBeInTheDocument();
    expect(ai.captured).toHaveLength(2);

    await arrives("customer", "Hello again?");
    await settle(AUTO_SUMMARY_MIN_INTERVAL_MS * 2);
    expect(ai.captured).toHaveLength(2);

    // The operator can still summarize by hand
    ai.respond = () => Promise.resolve(SUMMARY_B);
    fireEvent.click(card().getByRole("button", { name: "Update summary" }));
    expect(await card().findByText(/Summary B/)).toBeInTheDocument();
    expect(card().queryByText(/Out of date/)).not.toBeInTheDocument();
  });

  it("does nothing by itself when the switch is off, and the manual button still works", async () => {
    await setSetting("ticket_summary_auto_update", "false");
    await openWithSummary();

    await arrives("customer", "Any news?");
    await settle(AUTO_SUMMARY_DEBOUNCE_MS);
    expect(ai.captured).toHaveLength(1);
    expect(await card().findByText(/Out of date/)).toBeInTheDocument();

    ai.respond = () => Promise.resolve(SUMMARY_B);
    fireEvent.click(card().getByRole("button", { name: "Summarize again" }));
    expect(await card().findByText(/Summary B/)).toBeInTheDocument();
    expect(ai.captured).toHaveLength(2);
  });
});
