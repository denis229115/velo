import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { createSqliteTestDb, type SqliteTestDb } from "@/test/sqliteTestDb";
import { createFreshdeskFetchStub } from "@/test/freshdeskFetchStub";
import { createClickUpFetchStub } from "@/test/clickupFetchStub";
import { ALPHA_HOST } from "@/services/freshdesk/__fixtures__/freshdeskFixtures";
import { FIXTURE_NOW, alphaTenantWithTickets } from "@/services/freshdesk/__fixtures__/freshdeskTicketFixtures";
import { ALPHA_TOKEN, BETA_TOKEN, ALPHA_BACKLOG_LIST_ID, clickupTokens } from "@/services/clickup/__fixtures__/clickupFixtures";

const ai = vi.hoisted(() => ({ requests: [] as { userContent: string }[], response: "" }));
vi.mock("@/services/ai/providers/claudeProvider", () => ({
  createClaudeProvider: () => ({ complete: async (request: { userContent: string }) => { ai.requests.push(request); return ai.response; }, testConnection: async () => true }),
  clearClaudeProvider: vi.fn(),
}));
const testRouter = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/router", () => ({ get router() { return testRouter.current; } }));

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
const HELPDESK_KEY = "fixture-key-alpha-0001";
let freshdesk: ReturnType<typeof createFreshdeskFetchStub>;
let clickup: ReturnType<typeof createClickUpFetchStub>;
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (input: string, init?: RequestInit) =>
    String(input).startsWith("https://api.clickup.com/") ? clickup.fetch(input, init) : freshdesk.fetch(input, init),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(async () => {}),
}));

import { setSetting } from "@/services/db/settings";
import { clearProviderClients } from "@/services/ai/providerManager";
import { setSendPreviewHandler } from "@/services/ai/gateway";
import { alphaTenantWithHistory } from "@/services/freshdesk/__fixtures__/freshdeskConversationFixtures";
import { runMigrations } from "@/services/db/migrations";
import { connectHelpdesk } from "@/services/freshdesk/connection";
import { syncTickets } from "@/services/freshdesk/ticketSync";
import { connectWorkspace, setTicketIdField } from "@/services/clickup/connection";
import { linkTask, type LinkedItem } from "@/services/clickup/links";
import { useUIStore } from "@/stores/uiStore";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useShortcutStore } from "@/stores/shortcutStore";
import { useAccountStore } from "@/stores/accountStore";
import { getDefaultKeyMap } from "@/constants/shortcuts";
import { RelatedTasksPanel } from "./RelatedTasksPanel";
import { LinkedWorkRow } from "./LinkedWorkRow";
import { disconnectWorkspace } from "@/services/clickup/connection";

vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});

const TICKET: LinkedItem = { kind: "ticket", ticketId: "1002" };
const EMAIL: LinkedItem = {
  kind: "email",
  accountId: "acct-1",
  threadId: "thread-secret-77",
};
const FOLLOW_UPS = "li_a_follow";

const writes = () =>
  [...clickup.requests, ...freshdesk.requests]
    .filter((r) => r.method !== "GET")
    .map((r) => `${r.method} ${new URL(r.url).pathname.replace(/^\/api\/v2/, "")}`);

const panel = () => screen.findByRole("region", { name: "Related tasks" });

async function openCreate(item: LinkedItem) {
  render(<RelatedTasksPanel item={item} />);
  fireEvent.click(await within(await panel()).findByRole("button", { name: "Create task" }));
  const dialog = await screen.findByRole("dialog", { name: "Create a ClickUp task" });
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "Refresh lists" })).not.toBeDisabled());
  return dialog;
}

async function chooseDestination(dialog: HTMLElement, id: string) {
  const names: Record<string, string> = {
    li_a_follow: "Fixture follow-ups (Fixture space)",
    li_a_bugs: "Fixture bugs (Fixture space / Fixture folder)",
    li_a_backlog: "Fixture backlog (Fixture space)",
  };
  fireEvent.click(within(dialog).getByRole("combobox", { name: "List" }));
  fireEvent.click(await within(dialog).findByRole("option", { name: names[id] }));
  await within(dialog).findByRole("button", { name: "Choose assignees" });
}

beforeEach(async () => {
  useShortcutStore.setState({ keyMap: getDefaultKeyMap() });
  useAccountStore.setState({ activeAccountId: "acct-1" });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXTURE_NOW);
  db = createSqliteTestDb();
  freshdesk = createFreshdeskFetchStub({
    [ALPHA_HOST]: { apiKey: HELPDESK_KEY, tenant: alphaTenantWithTickets },
  });
  clickup = createClickUpFetchStub(clickupTokens);
  useUIStore.setState({ isOnline: true });
  await runMigrations();
  await connectHelpdesk({ host: ALPHA_HOST, apiKey: HELPDESK_KEY });
  await syncTickets({ trigger: "manual" });
  await connectWorkspace({ token: ALPHA_TOKEN });
  await setTicketIdField("cf-alpha-ticket");
  clickup.requests.length = 0;
  freshdesk.requests.length = 0;
});

afterEach(() => {
  setSendPreviewHandler(null);
  vi.useRealTimers();
  db.close();
});

describe("live task drawer choices", () => {
  it("does not substitute another destination when a refreshed hierarchy omits the chosen list", async () => {
    const dialog = await openCreate(TICKET);
    await chooseDestination(dialog, FOLLOW_UPS);
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Keep this title" } });
    clickup.respondOnce("/space/sp_a_1/list", { body: { lists: [] } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Refresh lists" }));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Refresh lists" })).toBeEnabled());
    expect(within(dialog).getByRole("combobox", { name: "List" })).toHaveValue("");
    expect(within(dialog).getByRole("button", { name: "Create task" })).toBeDisabled();
    expect(within(dialog).getByLabelText("Title")).toHaveValue("Keep this title");
    expect(within(dialog).getByText(/previous destination.*Fixture follow-ups.*not returned/)).toBeInTheDocument();
  });

  it("waits for debounced results before Enter can select a destination", async () => {
    const dialog = await openCreate(TICKET);
    const list = within(dialog).getByRole("combobox", { name: "List" });
    fireEvent.change(list, { target: { value: "follow-ups" } });
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "Enter" });
    expect(within(dialog).getByText("Destination: Fixture bugs (Fixture space / Fixture folder)")).toBeInTheDocument();
    expect(list).toHaveValue("follow-ups");
    const choice = await within(dialog).findByRole("option", { name: "Fixture follow-ups (Fixture space)" });
    expect(choice).toBeVisible();
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "Enter" });
    expect(list).toHaveValue("Fixture follow-ups (Fixture space)");
    expect(writes()).toEqual([]);
    fireEvent.click(list);
    fireEvent.keyDown(list, { key: "Escape" });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).queryByRole("listbox", { name: "Lists" })).not.toBeInTheDocument();
  });

  it("removes old workspace choices after reconnecting while keeping the operator's text", async () => {
    const dialog = await openCreate(EMAIL);
    await chooseDestination(dialog, "li_a_bugs");
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Keep my draft" } });
    const { act } = await import("@testing-library/react");
    await act(async () => { await connectWorkspace({ token: BETA_TOKEN }); });
    expect(within(dialog).getByRole("combobox", { name: "List" })).toHaveValue("");
    expect(within(dialog).getByRole("button", { name: "Create task" })).toBeDisabled();
    expect(within(dialog).getByLabelText("Title")).toHaveValue("Keep my draft");
    expect(within(dialog).queryByText(/Destination: Fixture bugs/)).not.toBeInTheDocument();
    expect(within(dialog).getByText(/connection changed/)).toBeInTheDocument();
  });

  it.each([
    { status: 500, body: {}, message: /HTTP 500/ },
    { status: 429, body: {}, headers: { "retry-after": "60" }, message: /slow down.*Try again after/ },
    { status: 401, body: { ECODE: "OAUTH_025" }, message: /expired or been revoked.*Reconnect/ },
  ])("shows an honest discovery failure for HTTP $status and blocks creation", async (failure) => {
    clickup.respondOnce("/team/9010000001/space", failure);
    const dialog = await openCreate(TICKET);
    expect(await within(dialog).findByText(failure.message)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Create task" })).toBeDisabled();
    expect(within(dialog).getByRole("combobox", { name: "List" })).toHaveValue("Fixture bugs (Fixture space / Fixture folder)");
    expect(within(dialog).getByRole("button", { name: "Retry lists" })).toBeEnabled();
    expect(writes()).toEqual([]);
    if (failure.status === 500) {
      vi.setSystemTime(FIXTURE_NOW + 120_000);
      fireEvent.click(within(dialog).getByRole("button", { name: "Retry lists" }));
      await waitFor(() => expect(within(dialog).getByRole("button", { name: "Create task" })).toBeEnabled());
      expect(within(dialog).queryByText(/Cached destinations/)).not.toBeInTheDocument();
    }
  });

  it("pages a large discovered hierarchy and debounces search across every page", async () => {
    clickup.respondOnce("/folder/fo_a_1/list", { body: { lists: Array.from({ length: 65 }, (_, i) => ({ id: `many_${i}`, name: `Remote list ${String(i).padStart(2, "0")}` })) } });
    const dialog = await openCreate(EMAIL);
    const list = within(dialog).getByRole("combobox", { name: "List" });
    fireEvent.click(list);
    expect(within(within(dialog).getByRole("listbox", { name: "Lists" })).getAllByRole("option")).toHaveLength(30);
    expect(within(dialog).getByText("67 results · Page 1 of 3")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Next lists" }));
    expect(within(dialog).getByRole("option", { name: "Remote list 30 (Fixture space / Fixture folder)" })).toBeInTheDocument();
    fireEvent.change(list, { target: { value: "Remote list 64" } });
    expect(within(dialog).queryByRole("option", { name: "Remote list 64 (Fixture space / Fixture folder)" })).not.toBeInTheDocument();
    expect(await within(dialog).findByRole("option", { name: "Remote list 64 (Fixture space / Fixture folder)" })).toBeInTheDocument();
    expect(within(within(dialog).getByRole("listbox", { name: "Lists" })).getAllByRole("option")).toHaveLength(1);
    expect(within(dialog).getByText("1 results · Page 1 of 1")).toBeInTheDocument();
  });

  it("shows list-detail failures with retry and preserves edited text", async () => {
    clickup.respondOnce("/list/li_a_bugs/member", { status: 500, body: {} });
    const dialog = await openCreate(TICKET);
    await within(dialog).findByRole("button", { name: "Retry list details" });
    expect(within(dialog).getByRole("button", { name: "Create task" })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "My edit" } });
    vi.setSystemTime(FIXTURE_NOW + 120_000);
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry list details" }));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Create task" })).toBeEnabled());
    expect(within(dialog).getByLabelText("Title")).toHaveValue("My edit");
    fireEvent.click(within(dialog).getByRole("button", { name: "Choose assignees" }));
    const search = within(dialog).getByRole("textbox", { name: "Search assignees" });
    fireEvent.change(search, { target: { value: "Me" } });
    await waitFor(() => expect(within(dialog).queryByRole("checkbox", { name: "Fixture Colleague" })).not.toBeInTheDocument());
    expect(within(dialog).getByRole("checkbox", { name: "Fixture Operator (Me)" })).toBeInTheDocument();
  });

  it("blocks stale submission during list changes, retains eligible members and ignores late responses", async () => {
    const dialog = await openCreate(TICKET);
    await chooseDestination(dialog, "li_a_bugs");
    fireEvent.click(within(dialog).getByRole("button", { name: "Choose assignees" }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Fixture Operator (Me)" }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Fixture Colleague" }));
    const held = clickup.holdNext("/list/li_a_follow/member");
    fireEvent.click(within(dialog).getByRole("combobox", { name: "List" }));
    fireEvent.click(await within(dialog).findByRole("option", { name: "Fixture follow-ups (Fixture space)" }));
    await held.started;
    expect(within(dialog).getByRole("button", { name: "Create task" })).toBeDisabled();
    fireEvent.submit(within(dialog).getByLabelText("Title").closest("form")!);
    expect(writes()).toEqual([]);
    await chooseDestination(dialog, "li_a_bugs");
    held.release();
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Choose assignees" })).toHaveTextContent("Fixture Colleague"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Choose assignees" }));
    expect(within(dialog).getByRole("checkbox", { name: "Fixture Colleague" })).toBeChecked();
    await chooseDestination(dialog, FOLLOW_UPS);
    fireEvent.click(within(dialog).getByRole("button", { name: "Choose assignees" }));
    expect(within(dialog).queryByRole("checkbox", { name: "Fixture Colleague" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("checkbox", { name: "Fixture Operator (Me)" })).toBeChecked();
    expect(within(dialog).getByLabelText("Status")).toHaveTextContent("fixture waiting on vendor");
    fireEvent.click(within(dialog).getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(writes()).toContain(`POST /list/${FOLLOW_UPS}/task`));
    expect(clickup.requests.find((r) => r.method === "POST" && r.path === `/list/${FOLLOW_UPS}/task`)!.body!.assignees).toEqual([701]);
  });

  it("shows the remembered destination, refresh time, and searches hierarchical lists with the keyboard", async () => {
    const { setDefaultList } = await import("@/services/clickup/connection");
    await setDefaultList(FOLLOW_UPS);
    const dialog = await openCreate(EMAIL);
    await within(dialog).findByText(/Last refreshed/);
    const list = within(dialog).getByRole("combobox", { name: "List" });
    await waitFor(() => expect(list).toHaveValue("Fixture follow-ups (Fixture space)"));
    fireEvent.change(list, { target: { value: "bugs" } });
    await within(dialog).findByRole("option", { name: "Fixture bugs (Fixture space / Fixture folder)" });
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "Enter" });
    expect(list).toHaveValue("Fixture bugs (Fixture space / Fixture folder)");
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Keep this edit" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Refresh lists" }));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Refresh lists" })).not.toBeDisabled());
    expect(within(dialog).getByLabelText("Title")).toHaveValue("Keep this edit");
    expect(list).toHaveValue("Fixture bugs (Fixture space / Fixture folder)");
  });
});

describe("creating a task from a ticket", () => {
  it("prefills the ticket, shows the destination and the three backlinks, and creates the task with the chosen fields (A13)", async () => {
    const dialog = await openCreate(TICKET);

    expect(within(dialog).getByText(/From ticket #1002/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Title")).toHaveValue("Fixture: export stuck");
    const list = within(dialog).getByLabelText("List");
    expect(list).toBeVisible();
    const backlinks = within(dialog).getByRole("list", {
      name: "Backlinks Velo writes",
    });
    expect(
      within(backlinks)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["Ticket link in the task description", "Ticket-ID field", "Internal note on the ticket"]);

    await chooseDestination(dialog, FOLLOW_UPS);
    const status = within(dialog).getByLabelText("Status");
    await waitFor(() =>
      expect(
        within(status).getByRole("option", {
          name: "fixture waiting on vendor",
        }),
      ).toBeInTheDocument(),
    );
    fireEvent.change(status, {
      target: { value: "fixture waiting on vendor" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Choose assignees" }));
    fireEvent.click(await within(dialog).findByRole("checkbox", { name: "Fixture Operator (Me)" }));
    fireEvent.change(within(dialog).getByLabelText("Priority"), {
      target: { value: "2" },
    });
    fireEvent.change(within(dialog).getByLabelText("Due date"), {
      target: { value: "2026-10-20" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create task" }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Create a ClickUp task" })).not.toBeInTheDocument(),
    );
    const create = clickup.requests.find((r) => r.method === "POST" && r.path === `/list/${FOLLOW_UPS}/task`)!;
    expect(create.body).toMatchObject({
      name: "Fixture: export stuck",
      assignees: [701],
      priority: 2,
      status: "fixture waiting on vendor",
      due_date: Date.UTC(2026, 9, 20, 12),
    });
    const row = await within(await panel()).findByRole("listitem", {
      name: "Fixture: export stuck",
    });
    expect(within(row).queryByRole("button", { name: "Retry missing backlink" })).not.toBeInTheDocument();
  });
});

describe("what the dialog warns about and settles", () => {
  it("warns when the chosen list lacks the Ticket-ID field, without blocking the task", async () => {
    const dialog = await openCreate(TICKET);
    await waitFor(() => expect(within(dialog).getByLabelText("List")).not.toBeDisabled());
    await chooseDestination(dialog, ALPHA_BACKLOG_LIST_ID);
    expect(await within(dialog).findByText(/ticket link and the internal note are still written/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Create task" })).toBeEnabled();
  });

  it("leaves a failed backlink pending in the panel, and its retry writes only that backlink (A14)", async () => {
    freshdesk.respondOnce(ALPHA_HOST, "/api/v2/tickets/1002/notes", {
      method: "POST",
      status: 500,
      body: {},
    });
    const dialog = await openCreate(TICKET);
    await waitFor(() => expect(within(dialog).getByLabelText("List")).not.toBeDisabled());
    await chooseDestination(dialog, FOLLOW_UPS);
    fireEvent.click(within(dialog).getByRole("button", { name: "Create task" }));

    const row = await within(await panel()).findByRole("listitem", {
      name: "Fixture: export stuck",
    });
    const note = await within(row).findByRole("listitem", {
      name: "Internal note on the ticket",
    });
    expect(note).toHaveTextContent("Failed");
    expect(within(row).getByRole("listitem", { name: "Ticket-ID field" })).toHaveTextContent("Written");

    clickup.requests.length = 0;
    freshdesk.requests.length = 0;
    fireEvent.click(within(row).getByRole("button", { name: "Retry missing backlink" }));
    const details = await screen.findByRole("dialog", { name: "ClickUp operation details" });
    expect(writes()).toEqual([]);
    fireEvent.click(within(details).getByRole("button", { name: "Retry missing backlink" }));
    await waitFor(() =>
      expect(within(row).queryByRole("button", { name: "Retry missing backlink" })).not.toBeInTheDocument(),
    );
    expect(writes()).toEqual(["POST /tickets/1002/notes"]);
    expect(within(row).getByText("Backlinks written")).toBeInTheDocument();
  });

  it("offers Check ClickUp for a creation ClickUp never answered, and never creates it twice (A10-style)", async () => {
    clickup.respondOnce(`/list/${FOLLOW_UPS}/task`, {
      method: "POST",
      apply: true,
      networkError: true,
    });
    const dialog = await openCreate(TICKET);
    await waitFor(() => expect(within(dialog).getByLabelText("List")).not.toBeDisabled());
    await chooseDestination(dialog, FOLLOW_UPS);
    fireEvent.click(within(dialog).getByRole("button", { name: "Create task" }));

    expect(await within(dialog).findByText(/can't tell yet whether the task was created/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Create task" })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));

    const region = await panel();
    const pendingRow = await within(region).findByRole("listitem", {
      name: "Fixture: export stuck",
    });
    fireEvent.click(within(pendingRow).getByRole("button", { name: "Check ClickUp" }));
    const details = await screen.findByRole("dialog", { name: "ClickUp operation details" });
    fireEvent.click(within(details).getByRole("button", { name: "Check ClickUp" }));

    const linked = await within(await within(region).findByRole("list", { name: "Linked tasks" })).findByRole(
      "listitem",
      {
        name: "Fixture: export stuck",
      },
    );
    expect(linked).toBeInTheDocument();
    expect(within(region).queryByRole("button", { name: "Check ClickUp" })).not.toBeInTheDocument();
    expect(clickup.requests.filter((r) => r.method === "POST" && r.path === `/list/${FOLLOW_UPS}/task`)).toHaveLength(
      1,
    );
  });
});

describe("creating and linking from an email thread", () => {
  it("starts empty, says nothing leaves Velo, and sends only what the operator typed (A27)", async () => {
    const dialog = await openCreate(EMAIL);
    expect(within(dialog).getByText(/Nothing from this email is sent to ClickUp/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Title")).toHaveValue("");
    expect(within(dialog).queryByRole("list", { name: "Backlinks Velo writes" })).not.toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByLabelText("List")).not.toBeDisabled());
    await chooseDestination(dialog, FOLLOW_UPS);
    fireEvent.change(within(dialog).getByLabelText("Title"), {
      target: { value: "Fixture: call the customer" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create task" }));

    expect(
      await within(await panel()).findByRole("listitem", {
        name: "Fixture: call the customer",
      }),
    ).toBeInTheDocument();
    const sent = JSON.stringify(clickup.requests.find((r) => r.method === "POST")!.body);
    expect(sent).not.toContain("thread-secret-77");
    expect(sent).not.toContain("acct-1");
    expect(writes()).toEqual([`POST /list/${FOLLOW_UPS}/task`]);
  });

  it("links an existing task straight away, writing nothing anywhere", async () => {
    render(<RelatedTasksPanel item={EMAIL} />);
    fireEvent.click(await within(await panel()).findByRole("button", { name: "Link task" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Link a ClickUp task",
    });
    const field = within(dialog).getByLabelText("Search tasks or paste a task URL or ID");
    fireEvent.change(field, { target: { value: "86a0inv02" } });
    fireEvent.submit(field.closest("form")!);

    expect(
      await within(await panel()).findByRole("listitem", {
        name: "Fixture: resend invoice copy",
      }),
    ).toBeInTheDocument();
    expect(writes()).toEqual([]);
  });
});

describe("linked work on an email thread", () => {
  it("shows the email's tasks and opens its Related tasks panel; a ticket and the email share one task (A15)", async () => {
    await linkTask(TICKET, "86a0inv02");
    await linkTask(EMAIL, "86a0inv02");
    render(<LinkedWorkRow item={EMAIL} />);
    const row = within(await screen.findByRole("region", { name: "Linked work" }));
    expect(await row.findByText(/1 task/)).toBeInTheDocument();
    fireEvent.click(row.getByRole("button", { name: "Show tasks" }));

    const task = await within(await panel()).findByRole("listitem", { name: "Fixture: resend invoice copy" });
    // One-way: an email link has no backlinks to show
    expect(within(task).queryByText(/Backlinks/)).not.toBeInTheDocument();
    expect(within(task).getByRole("button", { name: /Unlink/ })).toHaveAttribute("title", expect.stringMatching(/this email/));
  });

  it("stays out of the way while no ClickUp workspace is connected", async () => {
    await disconnectWorkspace();
    const { container } = render(<LinkedWorkRow item={EMAIL} />);
    await waitFor(() => expect(clickup.requests).toEqual([]));
    await new Promise((r) => setTimeout(r, 50));
    expect(container).toBeEmptyDOMElement();
  });
});

describe("linking an existing task to a ticket", () => {
  it("asks to confirm the three backlinks before writing anything", async () => {
    render(<RelatedTasksPanel item={TICKET} />);
    fireEvent.click(await within(await panel()).findByRole("button", { name: "Link task" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Link a ClickUp task",
    });
    const field = within(dialog).getByLabelText("Search tasks or paste a task URL or ID");
    fireEvent.change(field, { target: { value: "86a0inv02" } });
    fireEvent.submit(field.closest("form")!);

    const confirm = await within(dialog).findByRole("group", {
      name: "Confirm the link",
    });
    expect(
      within(within(confirm).getByRole("list", { name: "Backlinks Velo writes" })).getAllByRole("listitem"),
    ).toHaveLength(3);
    expect(writes()).toEqual([]);

    fireEvent.click(within(confirm).getByRole("button", { name: "Link and write backlinks" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Link a ClickUp task" })).not.toBeInTheDocument());
    expect(writes()).toEqual([
      "PUT /task/86a0inv02",
      "POST /task/86a0inv02/field/cf-alpha-ticket",
      "POST /tickets/1002/notes",
    ]);
  });
});

describe("offline", () => {
  it.each([
    ["a ticket", TICKET, "Needs a connection to Freshdesk"],
    ["an email thread", EMAIL, "Needs a connection to ClickUp"],
  ])("disables create, link and retry on %s with the reason, queueing nothing", async (_name, item, reason) => {
    if (item.kind === "ticket") {
      freshdesk.respondOnce(ALPHA_HOST, "/api/v2/tickets/1002/notes", {
        method: "POST",
        status: 500,
        body: {},
      });
    }
    await linkTask(item, "86a0inv02");
    useUIStore.setState({ isOnline: false });
    clickup.requests.length = 0;
    freshdesk.requests.length = 0;
    render(<RelatedTasksPanel item={item} />);
    const region = await panel();

    for (const name of ["Create task", "Link task"]) {
      const button = await within(region).findByRole("button", { name });
      expect(button).toBeDisabled();
      expect(button).toHaveAccessibleDescription(reason);
    }
    if (item.kind === "ticket") {
      expect(
        within(region).getByRole("button", {
          name: "Retry missing backlink",
        }),
      ).toBeDisabled();
    }
    expect(writes()).toEqual([]);
  });
});


it("offers an editable AI proposal for a ticket without replacing ongoing edits or creating anything", async () => {
  freshdesk = createFreshdeskFetchStub({ [ALPHA_HOST]: { apiKey: HELPDESK_KEY, tenant: alphaTenantWithHistory } });
  await setSetting("ai_provider", "claude");
  await setSetting("claude_api_key", "fixture-key");
  await setSetting("ai_approved_provider", "claude");
  clearProviderClients();
  setSendPreviewHandler(async () => true);
  ai.requests.length = 0;
  ai.response = JSON.stringify({ title: "Investigate export", summary: "Export times out.", acceptance_criteria: ["Export finishes"] });
  const dialog = await openCreate(TICKET);
  const title = within(dialog).getByLabelText("Title");
  fireEvent.change(title, { target: { value: "My title" } });
  fireEvent.change(within(dialog).getByLabelText("Description"), { target: { value: "My description" } });
  fireEvent.click(await within(dialog).findByRole("button", { name: "Propose task text" }));
  const proposal = within(await within(dialog).findByRole("region", { name: "AI task proposal" }));
  expect(title).toHaveValue("My title");
  expect(within(dialog).getByLabelText("Description")).toHaveValue("My description");
  expect(writes()).toEqual([]);
  fireEvent.change(proposal.getByLabelText("Proposed title"), { target: { value: "Edited proposal" } });
  fireEvent.click(proposal.getByRole("button", { name: "Insert" }));
  expect(title).toHaveValue("My title — Edited proposal");
  expect(within(dialog).getByLabelText("Description")).toHaveValue("My description\n\nExport times out.\n\nAcceptance criteria:\n- Export finishes");
  expect(ai.requests).toHaveLength(1);
  expect(writes()).toEqual([]);
});


it("lets an email's AI proposal be edited and explicitly replace the chosen task text", async () => {
  await db.execute("INSERT INTO accounts (id, email) VALUES ('acct-1', 'operator@example.test')");
  await db.execute("INSERT INTO threads (id, account_id, subject) VALUES ('thread-secret-77', 'acct-1', 'Export fails')");
  await db.execute("INSERT INTO messages (id, account_id, thread_id, subject, body_text, from_address, date) VALUES ('m1', 'acct-1', 'thread-secret-77', 'Export fails', 'Export times out. Contact email.fake@example.test', 'header-only@example.test', 1760000000000)");
  await setSetting("ai_provider", "claude");
  await setSetting("claude_api_key", "fixture-key");
  await setSetting("ai_approved_provider", "claude");
  clearProviderClients();
  setSendPreviewHandler(async () => true);
  ai.requests.length = 0;
  ai.response = JSON.stringify({ title: "Investigate export", summary: "Export times out.", acceptance_criteria: ["Export finishes"] });
  const dialog = await openCreate(EMAIL);
  fireEvent.click(await within(dialog).findByRole("button", { name: "Propose task text" }));
  const proposal = within(await within(dialog).findByRole("region", { name: "AI task proposal" }));
  fireEvent.change(proposal.getByLabelText("Proposed description"), { target: { value: "My edited proposal" } });
  expect(within(dialog).getByLabelText("Title")).toHaveValue("");
  expect(writes()).toEqual([]);
  fireEvent.click(proposal.getByRole("button", { name: "Replace" }));
  expect(within(dialog).getByLabelText("Title")).toHaveValue("Investigate export");
  expect(within(dialog).getByLabelText("Description")).toHaveValue("My edited proposal");
  expect(ai.requests[0]!.userContent).toContain("Export times out");
  expect(ai.requests[0]!.userContent).not.toContain("email.fake@example.test");
  expect(ai.requests[0]!.userContent).not.toContain("header-only");
  expect(writes()).toEqual([]);
  fireEvent.click(within(dialog).getByRole("button", { name: "Create task" }));
  await waitFor(() => expect(writes()).toEqual(["POST /list/li_a_bugs/task"]));
  expect(clickup.requests.find((r) => r.method === "POST")!.body).toMatchObject({ name: "Investigate export", markdown_content: expect.stringContaining("My edited proposal") });
});


function ShortcutShell() {
  useKeyboardShortcuts();
  return <Outlet />;
}
function renderLinkedWork(path: string) {
  const root = createRootRoute({ component: ShortcutShell });
  const freshdesk = createRoute({ getParentRoute: () => root, path: "freshdesk", component: () => <LinkedWorkRow item={TICKET} /> });
  const ticket = createRoute({ getParentRoute: () => freshdesk, path: "ticket/$ticketId" });
  const mail = createRoute({ getParentRoute: () => root, path: "mail/$label", component: () => <LinkedWorkRow item={EMAIL} /> });
  const thread = createRoute({ getParentRoute: () => mail, path: "thread/$threadId" });
  const router = createRouter({ routeTree: root.addChildren([freshdesk.addChildren([ticket]), mail.addChildren([thread])]), history: createMemoryHistory({ initialEntries: [path] }) });
  testRouter.current = router;
  render(<RouterProvider router={router} />);
}

it.each([
  ["ticket", "/freshdesk/ticket/1002"],
  ["email", "/mail/inbox/thread/thread-secret-77"],
])("t opens existing ClickUp create/link controls from the %s", async (_kind, path) => {
  renderLinkedWork(path);
  const row = within(await screen.findByRole("region", { name: "Linked work" }));
  await row.findByRole("button", { name: "Create task" });
  fireEvent.keyDown(window, { key: "t" });
  const actions = within(await screen.findByRole("region", { name: "Related tasks" }));
  const create = await actions.findByRole("button", { name: "Create task" });
  expect(create).toHaveFocus();
  expect(actions.getByRole("button", { name: "Link task" })).toBeEnabled();
  fireEvent.click(create);
  expect(await screen.findByRole("dialog", { name: "Create a ClickUp task" })).toBeVisible();
  expect(writes()).toEqual([]);
});


it("rebinds the shared ClickUp shortcut and keeps the link dialog available", async () => {
  useShortcutStore.setState({ keyMap: { ...getDefaultKeyMap(), "action.clickupTask": "Alt+T" } });
  renderLinkedWork("/freshdesk/ticket/1002");
  const row = within(await screen.findByRole("region", { name: "Linked work" }));
  await row.findByRole("button", { name: "Create task" });
  fireEvent.keyDown(window, { key: "t" });
  expect(screen.queryByRole("region", { name: "Related tasks" })).not.toBeInTheDocument();
  fireEvent.keyDown(window, { key: "t", altKey: true });
  const actions = within(await screen.findByRole("region", { name: "Related tasks" }));
  fireEvent.click(await actions.findByRole("button", { name: "Link task" }));
  expect(await screen.findByRole("dialog", { name: "Link a ClickUp task" })).toBeVisible();
  expect(writes()).toEqual([]);
});
