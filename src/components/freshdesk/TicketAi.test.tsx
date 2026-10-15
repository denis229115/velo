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
import { FIXTURE_NOW } from "@/services/freshdesk/__fixtures__/freshdeskTicketFixtures";
import { alphaTenantWithHistory } from "@/services/freshdesk/__fixtures__/freshdeskConversationFixtures";
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
// Reads can be made to fail while a test plays a helpdesk that stopped answering
const net = vi.hoisted(() => ({ failReads: false }));
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (input: string, init?: RequestInit) =>
    net.failReads && (init?.method ?? "GET") === "GET"
      ? Promise.reject(new TypeError("fixture: no answer"))
      : stub.fetch(input, init),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

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
import { saveTicketDraft, loadTicketDraft } from "@/services/freshdesk/ticketDrafts";
import { setSetting } from "@/services/db/settings";
import { clearProviderClients } from "@/services/ai/providerManager";
import { AiSendPreviewHost } from "@/components/ai/AiSendPreview";
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
      <AiSendPreviewHost />
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

const writes = () => stub.requests.filter((r) => r.method !== "GET");
const posts = () => stub.requests.filter((r) => r.method === "POST");
const reader = () => within(screen.getByRole("region", { name: "Ticket reader" }));

async function openTicket(ticketId = "1001") {
  await connectAndSync();
  renderFreshdesk(`/freshdesk/ticket/${ticketId}`);
  await within(await screen.findByRole("region", { name: "Ticket reader" })).findByRole("heading", { level: 2 });
}
async function openComposer(button: "Reply" | "Internal note") {
  fireEvent.click(await reader().findByRole("button", { name: button }));
  return within(await screen.findByRole("region", { name: button === "Reply" ? "Reply to customer" : "Internal note" }));
}
/** The draft as the operator left it (typing is the editor's business; the stored draft is the contract) */
export async function draft(mode: "reply" | "note", bodyHtml: string, ticketId = "1001") {
  await saveTicketDraft(ticketId, mode, { bodyHtml });
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXTURE_NOW);
  db = createSqliteTestDb();
  stub = createFreshdeskFetchStub({ [ALPHA_HOST]: { apiKey: ALPHA_KEY, tenant: alphaTenantWithHistory } });
  await runMigrations();
  useTicketStore.setState(useTicketStore.getInitialState(), true);
  useUIStore.setState({ isOnline: true });
  net.failReads = false;
  ai.captured.length = 0;
  ai.respond = () => Promise.resolve(SUMMARY_JSON);
  clearProviderClients();
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

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

const SUMMARY_JSON = JSON.stringify({
  issue: [{ text: "The customer cannot sign in.", sources: [1] }],
  facts: [{ text: "The same error appears after a session reset.", sources: [3] }],
  work_done: [{ text: "The agent reset the session.", sources: [2] }],
  blocker: [{ text: "Sign-in still fails.", sources: [3] }],
  open_questions: [{ text: "Which error message does the customer see?", sources: [3] }],
  next_action: [{ text: "Ask for the exact error text.", sources: [3] }],
});

async function approveClaude() {
  await setSetting("ai_provider", "claude");
  await setSetting("claude_api_key", "enc:fake-claude-key");
  await setSetting("ai_approved_provider", "claude");
}

/** Approve the first send in the preview, which names the provider */
async function confirmPreview() {
  fireEvent.click(await screen.findByRole("button", { name: "Send to Claude API (Anthropic)" }));
}
/** Cancel the send preview (not the card's own Cancel) */
async function cancelPreview() {
  await screen.findByRole("button", { name: "Send to Claude API (Anthropic)" });
  const card = screen.getByRole("region", { name: "AI summary" });
  fireEvent.click(screen.getAllByRole("button", { name: "Cancel" }).find((b) => !card.contains(b))!);
}

Element.prototype.scrollIntoView = vi.fn();

describe("the ticket summary", () => {
  it("summarises on request after the send preview, with six sections citing the conversations, and writes nothing to Freshdesk", async () => {
    await approveClaude();
    await openTicket();

    const card = within(await reader().findByRole("region", { name: "AI summary" }));
    fireEvent.click(card.getByRole("button", { name: "Summarize" }));
    await confirmPreview();

    for (const heading of ["Issue", "Relevant facts", "Work done", "Current blocker", "Unanswered questions", "Next action"]) {
      expect(await card.findByRole("heading", { name: heading })).toBeInTheDocument();
    }
    expect(card.getByText("The agent reset the session.")).toBeInTheDocument();
    expect(card.getByText(/Kept in Velo only/)).toBeInTheDocument();
    // A reference leads to its conversation in the history
    fireEvent.click(card.getAllByRole("button", { name: /Go to message 2/ })[0]!);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    expect(writes()).toEqual([]);

    // Internal notes and attachments never leave Velo (A23)
    const sent = JSON.stringify(ai.captured);
    expect(ai.captured).toHaveLength(1);
    expect(sent).toContain("I have reset your session");
    expect(sent).not.toContain("SSO provider had an outage");
    expect(sent).not.toContain("steps.pdf");
    expect(sent).not.toContain("attachments.example.test");
  });

  it("says when AI is off, and reading and replying work as usual (A12)", async () => {
    await openTicket();

    expect(await reader().findByText(/AI summary is off/)).toBeInTheDocument();
    expect(reader().queryByRole("button", { name: "Summarize" })).not.toBeInTheDocument();
    expect(reader().getByRole("list", { name: "Conversation history" })).toBeInTheDocument();
    await draft("reply", "<p>Could you send a screenshot?</p>");
    const reply = await openComposer("Reply");
    await reply.findByText("Could you send a screenshot?");
    expect(reply.queryByRole("button", { name: "Draft reply" })).not.toBeInTheDocument();
    fireEvent.click(reply.getByRole("button", { name: "Send reply" }));
    await screen.findByText("Reply sent.");
    expect(ai.captured).toEqual([]);
  });

  it("reports a failing provider without blocking the reader (A12)", async () => {
    await approveClaude();
    ai.respond = () => Promise.reject(new Error("fetch failed"));
    await openTicket();

    const card = within(await reader().findByRole("region", { name: "AI summary" }));
    fireEvent.click(card.getByRole("button", { name: "Summarize" }));
    await confirmPreview();

    expect(await card.findByText(/Summary unavailable/)).toBeInTheDocument();
    expect(card.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(reader().getByRole("button", { name: "Reply" })).toBeEnabled();
  });

  it("sends nothing when the preview is cancelled", async () => {
    await approveClaude();
    await openTicket();

    const card = within(await reader().findByRole("region", { name: "AI summary" }));
    fireEvent.click(card.getByRole("button", { name: "Summarize" }));
    await cancelPreview();

    expect(await card.findByText(/Not sent/)).toBeInTheDocument();
    expect(ai.captured).toEqual([]);
  });
});
