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
  alphaTenantWithTickets,
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
import { attachToTicketDraft, saveTicketDraft, loadTicketDraft } from "@/services/freshdesk/ticketDrafts";
import { useTicketStore } from "@/stores/ticketStore";
import { useUIStore } from "@/stores/uiStore";
import { listScheduledReplies } from "@/services/freshdesk/scheduledReplies";
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

const writes = () => stub.requests.filter((r) => r.method !== "GET");
const posts = () => stub.requests.filter((r) => r.method === "POST");
const reader = () => within(screen.getByRole("region", { name: "Ticket reader" }));
const later = (ms: number) => vi.setSystemTime(Date.now() + ms);

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
async function draft(mode: "reply" | "note", bodyHtml: string, ticketId = "1001") {
  await saveTicketDraft(ticketId, mode, { bodyHtml });
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXTURE_NOW);
  db = createSqliteTestDb();
  stub = createFreshdeskFetchStub({ [ALPHA_HOST]: { apiKey: ALPHA_KEY, tenant: alphaTenantWithTickets } });
  await runMigrations();
  useTicketStore.setState(useTicketStore.getInitialState(), true);
  useUIStore.setState({ isOnline: true });
  net.failReads = false;
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

describe("the ticket composer", () => {
  it("keeps Reply to customer and Internal note as two distinct modes", async () => {
    await openTicket();

    const reply = await openComposer("Reply");
    expect(reply.getByRole("tab", { name: "Reply to customer" })).toHaveAttribute("aria-selected", "true");
    expect(reply.getByText(/The customer receives this/)).toBeInTheDocument();
    expect(reply.getByRole("button", { name: "Send reply" })).toBeInTheDocument();

    fireEvent.click(reply.getByRole("tab", { name: "Internal note" }));
    const note = within(await screen.findByRole("region", { name: "Internal note" }));
    expect(screen.queryByRole("region", { name: "Reply to customer" })).not.toBeInTheDocument();
    expect(note.getByText(/Only agents can see this/)).toBeInTheDocument();
    expect(note.getByRole("button", { name: "Add internal note" })).toBeInTheDocument();
    expect(note.queryByRole("button", { name: "Send reply" })).not.toBeInTheDocument();
    expect(note.queryByText("To")).not.toBeInTheDocument();
  });

  it("posts an internal note as a private note, never as a reply (A09)", async () => {
    await openTicket();
    await draft("note", "<p>Checked the logs</p>");
    const note = await openComposer("Internal note");
    await note.findByText("Checked the logs");

    fireEvent.click(note.getByRole("button", { name: "Add internal note" }));

    await screen.findByText("Internal note added.");
    expect(posts().map((r) => [new URL(r.url).pathname, r.body])).toEqual([
      ["/api/v2/tickets/1001/notes", { body: "<p>Checked the logs</p>", private: true }],
    ]);
  });

  it("shows sender, recipients, CC and attachments before sending", async () => {
    await openTicket();
    const reply = await openComposer("Reply");

    const summary = within(reply.getByRole("group", { name: "Before sending" }));
    expect(await summary.findByText(/Fixture Operator/)).toBeInTheDocument();
    expect(summary.getByText(/Fixture Customer Ada/)).toBeInTheDocument();
    expect(summary.getByRole("textbox", { name: "CC" })).toBeInTheDocument();
    expect(summary.getByText("No attachments")).toBeInTheDocument();
    expect(summary.getByText(/Your Freshdesk signature is added/)).toBeInTheDocument();
  });

  it("warns before sending when a colleague replied since the draft started, and sends only on request (A11)", async () => {
    await openTicket();
    await draft("reply", "<p>Here is the fix</p>");
    later(60_000);
    stub.addConversation(ALPHA_HOST, 1001, { user_id: COLLEAGUE_ID, body: "<p>I'm on it</p>" });
    const reply = await openComposer("Reply");
    await reply.findByText("Here is the fix");

    fireEvent.click(reply.getByRole("button", { name: "Send reply" }));

    const warning = within(await reply.findByRole("alert", { name: "The ticket changed" }));
    expect(warning.getByText("Fixture Colleague replied.")).toBeInTheDocument();
    expect(writes()).toEqual([]);

    fireEvent.click(warning.getByRole("button", { name: "Send anyway" }));
    await screen.findByText("Reply sent.");
    expect(posts()).toHaveLength(1);
  });

  it("shows an Unconfirmed send and reconciles it by reading the conversation, never posting twice (A10)", async () => {
    await openTicket();
    await draft("reply", "<p>Here is the fix</p>");
    const reply = await openComposer("Reply");
    await reply.findByText("Here is the fix");
    stub.respondOnce(ALPHA_HOST, "/api/v2/tickets/1001/reply", { method: "POST", networkError: true, apply: true });
    const realFetch = stub.fetch;
    stub.fetch = async (input, init) => {
      const response = await realFetch(input, init);
      if (init?.method === "POST") net.failReads = true;
      return response;
    };

    fireEvent.click(reply.getByRole("button", { name: "Send reply" }));

    const state = await reply.findByRole("status", { name: "Unconfirmed" });
    expect(state).toHaveTextContent(/can't tell yet whether this went out/);
    expect(reply.queryByRole("button", { name: "Send reply" })).not.toBeInTheDocument();

    net.failReads = false;
    fireEvent.click(reply.getByRole("button", { name: "Check Freshdesk" }));
    await screen.findByText("Reply sent.");
    expect(posts()).toHaveLength(1);
    expect(await loadTicketDraft("1001", "reply")).toBeNull();
  });

  it("reports reply sent, status failed for reply and set status", async () => {
    await openTicket();
    await draft("reply", "<p>Done</p>");
    const reply = await openComposer("Reply");
    await reply.findByText("Done");
    stub.respondOnce(ALPHA_HOST, "/api/v2/tickets/1001", {
      method: "PUT",
      status: 400,
      body: { description: "Validation failed", errors: [{ field: "status", message: "Status is locked", code: "invalid_value" }] },
    });

    fireEvent.change(await reply.findByRole("combobox", { name: "Then set status" }), { target: { value: "4" } });
    fireEvent.click(reply.getByRole("button", { name: "Send and set Resolved" }));

    const alert = await screen.findByRole("alert", { name: "Partly done" });
    expect(alert).toHaveTextContent("Reply sent. The status was not changed:");
    expect(alert).toHaveTextContent("Status is locked");
  });

  it("keeps the draft after a failed send", async () => {
    await openTicket();
    await draft("reply", "<p>Keep me</p>");
    const reply = await openComposer("Reply");
    await reply.findByText("Keep me");
    stub.respondOnce(ALPHA_HOST, "/api/v2/tickets/1001/reply", { method: "POST", status: 429, body: {}, headers: { "Retry-After": "120" } });

    fireEvent.click(reply.getByRole("button", { name: "Send reply" }));

    expect(await reply.findByRole("alert", { name: "Not sent" })).toHaveTextContent("Try again in 2 minutes");
    expect(reply.getByText("Keep me")).toBeInTheDocument();
    expect((await loadTicketDraft("1001", "reply"))?.bodyHtml).toBe("<p>Keep me</p>");
  });

  it("disables sending offline with the reason, and the draft stays editable", async () => {
    await openTicket();
    await draft("reply", "<p>On the train</p>");
    const reply = await openComposer("Reply");
    await reply.findByText("On the train");

    act(() => useUIStore.setState({ isOnline: false }));

    const send = reply.getByRole("button", { name: "Send reply" });
    expect(send).toBeDisabled();
    expect(send).toHaveAccessibleDescription("Needs a connection to Freshdesk");
    expect(reply.getByRole("combobox", { name: "Then set status" })).toBeDisabled();
    expect(reply.getByRole("textbox", { name: "Reply text" })).toHaveAttribute("contenteditable", "true");
    fireEvent.click(send);
    expect(writes()).toEqual([]);
  });
});

describe("attachments in the ticket composer (#34)", () => {
  const pick = (input: HTMLElement, ...files: File[]) => fireEvent.change(input, { target: { files } });
  const sentFiles = () => posts().map((r) => (r.body as { attachments?: { name: string }[] }).attachments?.map((a) => a.name));

  it.each(["reply", "note"] as const)("locks an Unconfirmed %s and its files after HTTP 503, then checks Freshdesk without resending", async (mode) => {
    await openTicket();
    await draft(mode, "<p>Logs attached</p>");
    await attachToTicketDraft("1001", mode, { name: "server.log", contentType: "text/plain", dataBase64: btoa("hello") });
    const composer = await openComposer(mode === "reply" ? "Reply" : "Internal note");
    await composer.findByText("Logs attached");
    stub.respondOnce(ALPHA_HOST, `/api/v2/tickets/1001/${mode === "reply" ? "reply" : "notes"}`, {
      method: "POST", status: 503, body: {}, apply: true,
    });

    const sendName = mode === "reply" ? "Send reply" : "Add internal note";
    fireEvent.click(composer.getByRole("button", { name: sendName }));

    expect(await composer.findByRole("status", { name: "Unconfirmed" })).toHaveTextContent("HTTP 503");
    expect(composer.queryByRole("button", { name: sendName })).toBeNull();
    expect(composer.getByLabelText("Attach files")).toBeDisabled();
    expect(composer.queryByRole("button", { name: "Remove server.log" })).toBeNull();
    expect(composer.getByRole("textbox", { name: mode === "reply" ? "Reply text" : "Note text" })).toHaveAttribute("contenteditable", "false");
    expect((await loadTicketDraft("1001", mode))?.attachments).toMatchObject([{ name: "server.log" }]);

    fireEvent.click(composer.getByRole("button", { name: "Check Freshdesk" }));
    await screen.findByText(mode === "reply" ? "Reply sent." : "Internal note added.");
    expect(posts()).toHaveLength(1);
    expect(await loadTicketDraft("1001", mode)).toBeNull();
  });

  it("attaches, lists and removes files in the Reply composer, shows them before sending, and sends the rest", async () => {
    await openTicket();
    await draft("reply", "<p>Logs attached</p>");
    const reply = await openComposer("Reply");
    await reply.findByText("Logs attached");

    pick(reply.getByLabelText("Attach files"), new File(["hello"], "server.log", { type: "text/plain" }), new File(["boom"], "trace.txt", { type: "text/plain" }));

    const files = within(await reply.findByRole("list", { name: "Attached files" }));
    expect(await files.findByText("trace.txt")).toBeInTheDocument();
    const summary = within(reply.getByRole("group", { name: "Before sending" }));
    expect(summary.getByText("server.log")).toBeInTheDocument();
    expect(summary.getByText("trace.txt")).toBeInTheDocument();
    expect(summary.queryByText("No attachments")).toBeNull();

    fireEvent.click(files.getByRole("button", { name: "Remove trace.txt" }));
    await waitFor(() => expect(summary.queryByText("trace.txt")).toBeNull());

    fireEvent.click(reply.getByRole("button", { name: "Send reply" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(sentFiles()).toEqual([["server.log"]]);
  });

  it("attaches files to an internal note too", async () => {
    await openTicket();
    await draft("note", "<p>Dump</p>");
    const note = await openComposer("Internal note");
    await note.findByText("Dump");

    pick(note.getByLabelText("Attach files"), new File(["x"], "dump.bin", { type: "application/octet-stream" }));
    expect(await within(await note.findByRole("list", { name: "Attached files" })).findByText("dump.bin")).toBeInTheDocument();

    fireEvent.click(note.getByRole("button", { name: "Add internal note" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(sentFiles()).toEqual([["dump.bin"]]);
  });

  it("shows Freshdesk's 20 MB limit and a clear error for a file over it, and keeps what was attached", async () => {
    await openTicket();
    await draft("reply", "<p>Video</p>");
    const reply = await openComposer("Reply");
    await reply.findByText("Video");
    expect(reply.getByText(/up to 20\.0 MB in total/)).toBeInTheDocument();
    expect(reply.getByText(/Sprout and trial plans allow 15 MB/)).toBeInTheDocument();

    pick(reply.getByLabelText("Attach files"), new File([new Uint8Array(21 * 1024 * 1024)], "huge.mp4", { type: "video/mp4" }));

    expect(await reply.findByRole("alert")).toHaveTextContent(/huge\.mp4 was not attached.*21\.0 MB.*20\.0 MB.*Sprout and trial plans allow 15 MB/);
    expect(reply.queryByRole("list", { name: "Attached files" })).toBeNull();
  });

  it("keeps a draft's files across a restart and shows them with an untrusted name as plain text", async () => {
    await openTicket();
    await draft("reply", "<p>Steps</p>");
    await attachToTicketDraft("1001", "reply", { name: '<img src=x onerror="window.__pwned=true">steps.pdf', contentType: "application/pdf", dataBase64: btoa("pdf") });
    const reply = await openComposer("Reply");

    const files = within(await reply.findByRole("list", { name: "Attached files" }));
    expect(await files.findByText('<img src=x onerror="window.__pwned=true">steps.pdf')).toBeInTheDocument();
    expect(document.querySelector("img[src=x]")).toBeNull();
  });

  it("lets files be added and removed offline while sending stays disabled", async () => {
    await openTicket();
    await draft("reply", "<p>On the train</p>");
    const reply = await openComposer("Reply");
    await reply.findByText("On the train");
    act(() => useUIStore.setState({ isOnline: false }));

    const attach = reply.getByLabelText("Attach files");
    expect(attach).toBeEnabled();
    pick(attach, new File(["p"], "photo.txt", { type: "text/plain" }));

    expect(await within(await reply.findByRole("list", { name: "Attached files" })).findByText("photo.txt")).toBeInTheDocument();
    expect(reply.getByRole("button", { name: "Send reply" })).toBeDisabled();
    expect(writes()).toEqual([]);
  });

  it("has no Image button in the editor toolbar until images go through this path", async () => {
    await openTicket();
    const reply = await openComposer("Reply");
    await reply.findByRole("textbox", { name: "Reply text" });

    expect(reply.queryByRole("button", { name: "Image" })).toBeNull();
    expect(reply.queryByTitle("Insert image")).toBeNull();
  });
});

describe("scheduling a reply", () => {
  const pressSendLater = () => fireEvent.keyDown(window, { key: "L", metaKey: true, shiftKey: true });

  it("opens the schedule picker on Cmd+Shift+L, says it sends only while Velo runs, and schedules with the chosen status (A26)", async () => {
    await openTicket();
    await draft("reply", "<p>Later then</p>");
    const reply = await openComposer("Reply");
    await reply.findByText("Later then");
    stub.requests.length = 0;

    pressSendLater();

    const picker = within(await screen.findByRole("group", { name: "Schedule reply" }));
    expect(picker.getByText(/sends through Freshdesk when Velo is next open/)).toBeInTheDocument();
    expect(picker.getByText(/not while your Mac sleeps or Velo is closed/)).toBe(picker.getByText(/next open/));
    fireEvent.change(picker.getByLabelText("Then set status"), { target: { value: "4" } });
    fireEvent.click(picker.getByRole("button", { name: /Tomorrow morning/ }));

    expect(await reply.findByText(/Reply scheduled for/)).toBeInTheDocument();
    const [scheduled] = await listScheduledReplies();
    expect(scheduled).toMatchObject({ ticketId: "1001", state: "pending", thenStatusId: "4", bodyHtml: "<p>Later then</p>" });
    expect(await loadTicketDraft("1001", "reply")).toBeNull();
    expect(writes()).toEqual([]);
  });

  it("offers Send later only for a reply, and not while offline: nothing is queued", async () => {
    await openTicket();
    await draft("reply", "<p>Later then</p>");
    const reply = await openComposer("Reply");
    await reply.findByText("Later then");
    expect(reply.getByRole("button", { name: "Send later" })).toBeEnabled();

    act(() => useUIStore.setState({ isOnline: false }));
    expect(reply.getByRole("button", { name: "Send later" })).toBeDisabled();
    pressSendLater();

    expect(screen.queryByRole("group", { name: "Schedule reply" })).not.toBeInTheDocument();
    expect(await listScheduledReplies()).toEqual([]);
  });
});
