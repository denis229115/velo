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
  alphaTenantWithCcTickets,
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
import { saveTicketDraft, loadTicketDraft } from "@/services/freshdesk/ticketDrafts";
import { useTicketStore } from "@/stores/ticketStore";
import { useUIStore } from "@/stores/uiStore";
import { useShortcutStore } from "@/stores/shortcutStore";
import { getDefaultKeyMap } from "@/constants/shortcuts";
import { listScheduledReplies } from "@/services/freshdesk/scheduledReplies";
import { useComposerStore } from "@/stores/composerStore";
import { Composer } from "@/components/composer/Composer";
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
  useShortcutStore.setState({ keyMap: getDefaultKeyMap() });
  useComposerStore.setState(useComposerStore.getInitialState(), true);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXTURE_NOW);
  db = createSqliteTestDb();
  stub = createFreshdeskFetchStub({ [ALPHA_HOST]: { apiKey: ALPHA_KEY, tenant: alphaTenantWithCcTickets } });
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
    stub.respondOnce(ALPHA_HOST, "/api/v2/tickets/1001/reply", { method: "POST", status: 500, body: {} });

    fireEvent.click(reply.getByRole("button", { name: "Send reply" }));

    await reply.findByRole("alert", { name: "Not sent" });
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

describe("CC prefill from the ticket", () => {
  const ccField = (reply: ReturnType<typeof within>) => reply.getByRole("textbox", { name: "CC" }) as HTMLInputElement;
  /** What the operator typed into the editor (ProseMirror reads the DOM change) */
  async function typeBody(pane: ReturnType<typeof within>, text: string) {
    const editor = pane.getByRole("textbox", { name: "Reply text" });
    await act(async () => {
      editor.innerHTML = `<p>${text}</p>`;
      await Promise.resolve();
    });
    await pane.findByText(text);
  }

  it("starts the Reply with the ticket's CC and reply-CC addresses, once each, without the customer", async () => {
    await openTicket("1101");

    const reply = await openComposer("Reply");

    await waitFor(() => expect(ccField(reply).value).toBe("cc.one@example.test, Cc.Two@example.test, reply.only@example.test"));
    expect(reply.getByText(/Fixture Customer Ada/)).toBeInTheDocument();
  });

  it("starts with an empty CC for a ticket nobody is copied on", async () => {
    await openTicket("1102");

    const reply = await openComposer("Reply");

    expect(ccField(reply).value).toBe("");
  });

  it("lets the operator remove and add addresses, and sends exactly the final list", async () => {
    await openTicket("1101");
    const reply = await openComposer("Reply");
    await waitFor(() => expect(ccField(reply).value).not.toBe(""));

    fireEvent.change(ccField(reply), { target: { value: "cc.one@example.test, Cc.Two@example.test, new.person@example.test" } });
    await typeBody(reply, "Thanks all");
    fireEvent.click(reply.getByRole("button", { name: "Send reply" }));

    await screen.findByText("Reply sent.");
    expect(posts()[0]!.body).toMatchObject({ cc_emails: ["cc.one@example.test", "Cc.Two@example.test", "new.person@example.test"] });
  });

  it("sends the prefilled CC when the operator only writes the reply", async () => {
    await openTicket("1101");
    const reply = await openComposer("Reply");
    await waitFor(() => expect(ccField(reply).value).not.toBe(""));

    await typeBody(reply, "On it");
    fireEvent.click(reply.getByRole("button", { name: "Send reply" }));

    await screen.findByText("Reply sent.");
    expect(posts()[0]!.body).toMatchObject({ cc_emails: ["cc.one@example.test", "Cc.Two@example.test", "reply.only@example.test"] });
  });

  it("refuses an address that is not an email address and keeps Send disabled", async () => {
    await openTicket("1101");
    const reply = await openComposer("Reply");
    await waitFor(() => expect(ccField(reply).value).not.toBe(""));

    fireEvent.change(ccField(reply), { target: { value: "cc.one@example.test, not-an-address" } });
    await typeBody(reply, "On it");

    expect(reply.getByText("Not an email address: not-an-address")).toBeInTheDocument();
    expect(reply.getByRole("button", { name: "Send reply" })).toBeDisabled();
    // The autosave lands before the test ends, so the draft keeps what was typed
    await waitFor(async () => expect((await loadTicketDraft("1101", "reply"))?.ccEmails).toEqual(["cc.one@example.test", "not-an-address"]), { timeout: 3000 });
  });

  it("remembers that the operator removed everyone, even before any text is written", async () => {
    await openTicket("1101");
    const reply = await openComposer("Reply");
    await waitFor(() => expect(ccField(reply).value).not.toBe(""));

    fireEvent.change(ccField(reply), { target: { value: "" } });

    await waitFor(async () => expect(await loadTicketDraft("1101", "reply")).toMatchObject({ ccEmails: [] }), { timeout: 3000 });
  });

  it("keeps a restored draft's own CC instead of the ticket's", async () => {
    await openTicket("1101");
    await saveTicketDraft("1101", "reply", { bodyHtml: "<p>Half written</p>", ccEmails: ["mine.only@example.test"] });

    const reply = await openComposer("Reply");

    await reply.findByText("Half written");
    expect(ccField(reply).value).toBe("mine.only@example.test");
  });

  it("keeps a restored draft's empty CC when the operator had removed everyone", async () => {
    await openTicket("1101");
    await saveTicketDraft("1101", "reply", { bodyHtml: "<p>Half written</p>", ccEmails: [] });

    const reply = await openComposer("Reply");

    await reply.findByText("Half written");
    expect(ccField(reply).value).toBe("");
  });

  it("gives an internal note no CC at all", async () => {
    await openTicket("1101");
    await saveTicketDraft("1101", "note", { bodyHtml: "<p>Checked the logs</p>" });

    const note = await openComposer("Internal note");

    await note.findByText("Checked the logs");
    expect(note.queryByRole("textbox", { name: "CC" })).not.toBeInTheDocument();
    fireEvent.click(note.getByRole("button", { name: "Add internal note" }));
    await screen.findByText("Internal note added.");
    expect(posts()[0]!.body).toEqual({ body: "<p>Checked the logs</p>", private: true });
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


describe("ticket send shortcut", () => {
  it.each([
    ["reply", "Reply", "Reply text", "Reply sent."],
    ["note", "Internal note", "Note text", "Internal note added."],
  ] as const)("sends a %s with the rebound composer key while typing", async (mode, button, textbox, result) => {
    await openTicket();
    await draft(mode, "<p>Keyboard message</p>");
    const composer = await openComposer(button);
    await composer.findByText("Keyboard message");
    const editor = composer.getByRole("textbox", { name: textbox });
    act(() => useShortcutStore.getState().setKey("app.send", "Ctrl+J"));
    fireEvent.keyDown(editor, { key: "Enter", metaKey: true });
    expect(posts()).toEqual([]);
    fireEvent.keyDown(editor, { key: "j", metaKey: true });
    expect(await screen.findByText(result)).toBeVisible();
    expect(posts()).toHaveLength(1);
  });
});


it("uses a rebound send-later shortcut from the ticket reply editor", async () => {
  await openTicket();
  await draft("reply", "<p>Send this later</p>");
  const reply = await openComposer("Reply");
  await reply.findByText("Send this later");
  act(() => useShortcutStore.getState().setKey("app.sendLater", "Alt+K"));
  const editor = reply.getByRole("textbox", { name: "Reply text" });
  fireEvent.keyDown(editor, { key: "L", metaKey: true, shiftKey: true });
  expect(screen.queryByRole("group", { name: "Schedule reply" })).not.toBeInTheDocument();
  fireEvent.keyDown(editor, { key: "k", altKey: true });
  expect(await screen.findByRole("group", { name: "Schedule reply" })).toBeVisible();
  expect(writes()).toEqual([]);
});


it("gives the full email composer precedence over a ticket reply for send keys", async () => {
  await openTicket();
  await draft("reply", "<p>Ticket reply stays here</p>");
  const reply = await openComposer("Reply");
  await reply.findByText("Ticket reply stays here");
  act(() => useComposerStore.getState().openComposer());
  render(<Composer />);
  expect(await screen.findByText("New Message")).toBeVisible();
  await act(async () => {
    fireEvent.keyDown(window, { key: "Enter", metaKey: true });
    fireEvent.keyDown(window, { key: "L", metaKey: true, shiftKey: true });
  });
  expect(writes()).toEqual([]);
  expect(screen.queryByRole("group", { name: "Schedule reply" })).not.toBeInTheDocument();
  expect(reply.getByText("Ticket reply stays here")).toBeVisible();
  act(() => useComposerStore.getState().closeComposer());
});
