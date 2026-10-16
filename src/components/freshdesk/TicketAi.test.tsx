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
import { createClickUpFetchStub } from "@/test/clickupFetchStub";
import { ALPHA_TOKEN, clickupTokens, alphaExportBugWithNotes } from "@/services/clickup/__fixtures__/clickupFixtures";
import { connectWorkspace } from "@/services/clickup/connection";
import { linkTask } from "@/services/clickup/links";
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
let clickup: ReturnType<typeof createClickUpFetchStub>;
// Reads can be made to fail while a test plays a helpdesk that stopped answering
const net = vi.hoisted(() => ({ failReads: false }));
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (input: string, init?: RequestInit) =>
    net.failReads && (init?.method ?? "GET") === "GET"
      ? Promise.reject(new TypeError("fixture: no answer"))
      : String(input).startsWith("https://api.clickup.com/") ? clickup.fetch(input, init) : stub.fetch(input, init),
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
import { useShortcutStore } from "@/stores/shortcutStore";
import { getDefaultKeyMap } from "@/constants/shortcuts";
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
  useShortcutStore.setState({ keyMap: getDefaultKeyMap() });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXTURE_NOW);
  db = createSqliteTestDb();
  clickup = createClickUpFetchStub(clickupTokens);
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
// jsdom has no layout; the editor measures the cursor when it scrolls to it
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();

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

const AI_DRAFT = "<p>Thanks for trying again. Which error message do you see?</p>";
const replyText = (reply: ReturnType<typeof within>) => reply.getByRole("textbox", { name: "Reply text" }).textContent;

describe("AI drafts in the composer", () => {
  beforeEach(async () => {
    await approveClaude();
    ai.respond = () => Promise.resolve(AI_DRAFT);
  });

  it("puts a draft into an empty reply only when the operator takes it, and keeps it as the ticket draft", async () => {
    await openTicket();
    const reply = await openComposer("Reply");

    expect(reply.getByRole("combobox", { name: "Tone" })).toHaveValue("friendly_professional");
    fireEvent.click(reply.getByRole("button", { name: "Draft reply" }));
    await confirmPreview();

    const proposal = within(await reply.findByRole("region", { name: "AI draft" }));
    expect(proposal.getByText("Thanks for trying again. Which error message do you see?")).toBeInTheDocument();
    expect(replyText(reply)).toBe("");
    fireEvent.click(proposal.getByRole("button", { name: "Use draft" }));

    expect(replyText(reply)).toContain("Which error message do you see?");
    expect(reply.queryByRole("region", { name: "AI draft" })).not.toBeInTheDocument();
    await waitFor(async () => expect((await loadTicketDraft("1001", "reply"))?.bodyHtml).toContain("Which error message"));
    expect(writes()).toEqual([]);
  });

  it("never overwrites the operator's text without a Replace or Insert choice", async () => {
    await openTicket();
    await draft("reply", "<p>My own words.</p>");
    const reply = await openComposer("Reply");
    await reply.findByText("My own words.");

    fireEvent.click(reply.getByRole("button", { name: "Draft reply" }));
    await confirmPreview();
    const proposal = within(await reply.findByRole("region", { name: "AI draft" }));
    expect(replyText(reply)).toBe("My own words.");

    fireEvent.click(proposal.getByRole("button", { name: "Insert" }));
    expect(replyText(reply)).toContain("My own words.");
    expect(replyText(reply)).toContain("Which error message do you see?");

    fireEvent.click(reply.getByRole("button", { name: "Draft reply" }));
    fireEvent.click(within(await reply.findByRole("region", { name: "AI draft" })).getByRole("button", { name: "Replace" }));
    expect(replyText(reply)).not.toContain("My own words.");
    expect(replyText(reply)).toContain("Which error message do you see?");
    await waitFor(async () => expect((await loadTicketDraft("1001", "reply"))?.bodyHtml).not.toContain("My own words"));
  });

  it("follows the tone switch and rewrites the operator's own draft", async () => {
    await openTicket();
    await draft("reply", "<p>We looked into it.</p>");
    const reply = await openComposer("Reply");
    await reply.findByText("We looked into it.");

    fireEvent.change(reply.getByRole("combobox", { name: "Tone" }), { target: { value: "formal" } });
    fireEvent.click(reply.getByRole("button", { name: "Rewrite" }));
    await confirmPreview();
    await reply.findByRole("region", { name: "AI draft" });

    expect(ai.captured[0]!.userContent).toMatch(/Tone: formal/);
    expect(ai.captured[0]!.userContent).toContain("We looked into it.");
    expect(ai.captured[0]!.userContent).not.toContain("SSO provider had an outage");
  });

  it("can be cancelled, and the reply stays as it was and can still be sent (A12)", async () => {
    let finish: (text: string) => void = () => {};
    ai.respond = () => new Promise((resolve) => (finish = resolve));
    await openTicket();
    await draft("reply", "<p>My own words.</p>");
    const reply = await openComposer("Reply");
    await reply.findByText("My own words.");

    fireEvent.click(reply.getByRole("button", { name: "Draft reply" }));
    await confirmPreview();
    fireEvent.click(await reply.findByRole("button", { name: "Cancel" }));
    await act(async () => finish(AI_DRAFT));

    expect(reply.queryByRole("region", { name: "AI draft" })).not.toBeInTheDocument();
    expect(replyText(reply)).toBe("My own words.");
    fireEvent.click(reply.getByRole("button", { name: "Send reply" }));
    await screen.findByText("Reply sent.");
  });

  it("says when drafting failed and keeps the operator's text (A12)", async () => {
    ai.respond = () => Promise.reject(new Error("fetch failed"));
    await openTicket();
    await draft("reply", "<p>My own words.</p>");
    const reply = await openComposer("Reply");
    await reply.findByText("My own words.");

    fireEvent.click(reply.getByRole("button", { name: "Draft reply" }));
    await confirmPreview();

    expect(await reply.findByText(/AI draft unavailable/)).toBeInTheDocument();
    expect(replyText(reply)).toBe("My own words.");
    expect(reply.getByRole("button", { name: "Send reply" })).toBeEnabled();
  });

  it("offers no AI draft on internal notes", async () => {
    await openTicket();
    const note = await openComposer("Internal note");
    expect(note.queryByRole("button", { name: "Draft reply" })).not.toBeInTheDocument();
  });
});


it("drafts a ticket reply from a linked non-done task and keeps sending manual", async () => {
  await approveClaude();
  await connectWorkspace({ token: ALPHA_TOKEN });
  await openTicket();
  await linkTask({ kind: "ticket", ticketId: "1001" }, alphaExportBugWithNotes.id);
  clickup.replaceTask(alphaExportBugWithNotes);
  stub.requests.length = 0;
  await draft("reply", "<p>My progress update.</p>");
  const reply = await openComposer("Reply");
  await reply.findByText("My progress update.");
  ai.respond = async () => "<p>The export fix is in review; it is not deployed yet.</p>";
  fireEvent.click(await reply.findByRole("button", { name: "Draft from task" }));
  await confirmPreview();
  const proposal = within(await reply.findByRole("region", { name: "Task reply draft" }));
  expect(ai.captured[0]!.userContent).toContain("Task status: fixture in progress (not done)");
  expect(ai.captured[0]!.userContent).toContain("Fix is in review, not deployed yet");
  expect(replyText(reply)).toBe("My progress update.");
  expect(posts()).toHaveLength(0);
  fireEvent.click(proposal.getByRole("button", { name: "Insert" }));
  expect(replyText(reply)).toContain("My progress update.");
  expect(replyText(reply)).toContain("not deployed yet");
  await waitFor(async () => expect((await loadTicketDraft("1001", "reply"))?.bodyHtml).toContain("not deployed yet"));
  expect(posts()).toHaveLength(0);
});


it("summarizes the selected ticket with z through the existing send preview", async () => {
  await approveClaude();
  await openTicket();
  const card = within(await reader().findByRole("region", { name: "AI summary" }));
  await card.findByRole("button", { name: "Summarize" });
  fireEvent.keyDown(window, { key: "z" });
  await confirmPreview();
  expect(await card.findByText("The customer cannot sign in.")).toBeVisible();
  expect(writes()).toEqual([]);
});


it("opens a reply and proposes an AI draft with d without changing the operator's text", async () => {
  await approveClaude();
  ai.respond = () => Promise.resolve(AI_DRAFT);
  await openTicket();
  await draft("reply", "<p>My own words</p>");
  fireEvent.keyDown(window, { key: "d" });
  const reply = within(await screen.findByRole("region", { name: "Reply to customer" }));
  await confirmPreview();
  const proposal = within(await reply.findByRole("region", { name: "AI draft" }));
  expect(proposal.getByText("Thanks for trying again. Which error message do you see?")).toBeVisible();
  expect(replyText(reply)).toBe("My own words");
  expect(proposal.getByRole("button", { name: "Replace" })).toBeVisible();
  expect(writes()).toEqual([]);
});
