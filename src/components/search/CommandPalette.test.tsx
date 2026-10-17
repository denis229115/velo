import { render, screen, fireEvent, within } from "@testing-library/react";
import { useShortcutStore } from "@/stores/shortcutStore";
import { getDefaultKeyMap } from "@/constants/shortcuts";
import { useLabelStore } from "@/stores/labelStore";
import { CommandPalette } from "./CommandPalette";
import { pretendPlatform, restoreUserAgent } from "@/test/platform";
import { searchMessages, type SearchResult } from "@/services/db/search";
import { navigateToThread, navigateToLabel, getActiveLabel, getSelectedThreadId } from "@/router/navigate";
import { useThreadStore } from "@/stores/threadStore";
import { useSmartFolderStore } from "@/stores/smartFolderStore";
import { useAccountStore } from "@/stores/accountStore";
import { useUIStore } from "@/stores/uiStore";
import { getEmailProvider } from "@/services/email/providerFactory";
import { enqueuePendingOperation } from "@/services/db/pendingOperations";

vi.mock("@/router/navigate", () => ({
  navigateToLabel: vi.fn(),
  navigateToThread: vi.fn(),
  navigateBack: vi.fn(),
  getActiveLabel: vi.fn(() => "inbox"),
  getSelectedThreadId: vi.fn(() => null),
}));
vi.mock("@/services/db/search", () => ({ searchMessages: vi.fn(async () => []) }));
const route = vi.hoisted(() => ({ label: "inbox" }));
vi.mock("@/hooks/useRouteNavigation", () => ({ useActiveLabel: () => route.label }));
vi.mock("@/services/db/templates", () => ({ getTemplatesForAccount: vi.fn(async () => []) }));
// The provider boundary (Gmail API / IMAP) and the local database are faked; emailActions runs for real.
vi.mock("@/services/email/providerFactory", () => ({ getEmailProvider: vi.fn() }));
vi.mock("@/services/db/pendingOperations", () => ({ enqueuePendingOperation: vi.fn(async () => "op-1") }));
const paletteDb = vi.hoisted(() => ({ execute: vi.fn(async () => ({ rowsAffected: 1 })), select: vi.fn(async () => []) }));
vi.mock("@/services/db/connection", () => ({
  getDb: vi.fn(async () => paletteDb),
  withTransaction: async (fn: (db: unknown) => Promise<void>) => fn(await (await import("@/services/db/connection")).getDb()),
  withReadSnapshot: <T,>(fn: () => Promise<T>) => fn(),
}));

afterEach(restoreUserAgent);

describe("Command palette shortcut hints", () => {
  it("shows Cmd wording on macOS", () => {
    pretendPlatform("mac");
    render(<CommandPalette isOpen onClose={() => {}} />);

    expect(screen.getByText("Cmd+Shift+E")).toBeInTheDocument();
  });

  it("keeps Ctrl wording on Windows", () => {
    pretendPlatform("windows");
    render(<CommandPalette isOpen onClose={() => {}} />);

    expect(screen.getByText("Ctrl+Shift+E")).toBeInTheDocument();
  });
});

function hit(threadId: string, subject: string, fromName: string): SearchResult {
  return {
    message_id: `m-${threadId}`,
    account_id: "acc-1",
    thread_id: threadId,
    subject,
    from_name: fromName,
    from_address: `${fromName.toLowerCase()}@example.com`,
    snippet: null,
    date: 1_700_000_000_000,
    rank: 0,
  };
}

function typeQuery(value: string) {
  const input = screen.getByRole("combobox");
  fireEvent.change(input, { target: { value } });
  return input;
}

describe("Command palette email search", () => {
  beforeEach(() => {
    vi.mocked(searchMessages).mockReset();
    vi.mocked(searchMessages).mockResolvedValue([]);
    useAccountStore.setState({ activeAccountId: "acc-1" });
  });

  it("shows matching commands and threads in separate groups", async () => {
    vi.mocked(searchMessages).mockResolvedValue([
      hit("t1", "Inbox zero tips", "Alice"),
      hit("t1", "Re: Inbox zero tips", "Bob"),
      hit("t2", "Weekly inbox report", "Carol"),
    ]);
    render(<CommandPalette isOpen onClose={() => {}} />);

    typeQuery("inbox");

    await screen.findByRole("option", { name: /Inbox zero tips/ });
    const threads = screen.getByRole("group", { name: "Threads" });
    expect(within(threads).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Inbox zero tipsAlice",
      "Weekly inbox reportCarol",
      "Show all results for “inbox”",
    ]);
    const commands = screen.getByRole("group", { name: "Commands" });
    expect(within(commands).getByRole("option", { name: /Go to Inbox/ })).toBeInTheDocument();
    expect(searchMessages).toHaveBeenCalledWith("inbox", "acc-1", expect.any(Number));
  });

  it("opens a thread with the arrow keys and Enter", async () => {
    vi.mocked(searchMessages).mockResolvedValue([hit("t9", "Quarterly numbers", "Dana")]);
    const onClose = vi.fn();
    render(<CommandPalette isOpen onClose={onClose} />);

    const input = typeQuery("quarterly");
    await screen.findByRole("option", { name: /Quarterly numbers/ });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent("Quarterly numbers");
    fireEvent.keyDown(input, { key: "Enter" });

    expect(navigateToThread).toHaveBeenCalledWith("t9");
    expect(onClose).toHaveBeenCalled();
  });

  it("opens the full results list with Enter on an operator query", async () => {
    useThreadStore.setState({ searchQuery: "", searchThreadIds: null });
    vi.mocked(getActiveLabel).mockReturnValue("settings");
    const onClose = vi.fn();
    render(<CommandPalette isOpen onClose={onClose} />);

    const input = typeQuery("from:alice has:attachment");
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent(
      "Show all results for “from:alice has:attachment”",
    );
    fireEvent.keyDown(input, { key: "Enter" });

    expect(useThreadStore.getState().searchQuery).toBe("from:alice has:attachment");
    expect(navigateToLabel).toHaveBeenCalledWith("inbox");
    expect(onClose).toHaveBeenCalled();
  });

  it("closes with Escape and does not search for a single character", () => {
    const onClose = vi.fn();
    render(<CommandPalette isOpen onClose={onClose} />);

    const input = typeQuery("a");
    fireEvent.keyDown(input, { key: "Escape" });

    expect(onClose).toHaveBeenCalled();
    expect(searchMessages).not.toHaveBeenCalled();
  });

  it("lists smart folders so saved searches stay reachable", () => {
    useSmartFolderStore.setState({
      folders: [{ id: "sf-1", accountId: null, name: "Receipts", query: "subject:receipt", icon: "Search", color: null, sortOrder: 0, isDefault: false }],
    });
    render(<CommandPalette isOpen onClose={() => {}} />);

    typeQuery("receipts");
    fireEvent.click(screen.getByRole("option", { name: "Open Receipts" }));

    expect(navigateToLabel).toHaveBeenCalledWith("smart-folder:sf-1");
  });
});

describe("Command palette spam action", () => {
  const providers = { gmail: { spam: vi.fn(async () => {}) }, imap: { spam: vi.fn(async () => {}) } };

  async function runSpamCommand(name: RegExp) {
    render(<CommandPalette isOpen onClose={() => {}} />);
    typeQuery("spam");
    fireEvent.click(screen.getByRole("option", { name }));
    await vi.waitFor(() => expect(paletteDb.execute.mock.calls.length).toBeGreaterThan(0));
  }

  beforeEach(() => {
    route.label = "inbox";
    paletteDb.execute.mockClear();
    providers.gmail.spam.mockClear();
    providers.imap.spam.mockClear();
    vi.mocked(enqueuePendingOperation).mockClear();
    vi.mocked(getSelectedThreadId).mockReturnValue("t1");
    vi.mocked(getEmailProvider).mockImplementation(async (accountId) =>
      (accountId === "imap-acc" ? providers.imap : providers.gmail) as never,
    );
    useUIStore.setState({ isOnline: true });
    useThreadStore.setState({ threads: [] });
  });

  afterEach(() => {
    vi.mocked(getSelectedThreadId).mockReturnValue(null);
  });

  it.each([
    ["gmail", "gmail-acc"],
    ["imap", "imap-acc"],
  ] as const)("reports the open thread as spam through the %s provider", async (kind, accountId) => {
    useAccountStore.setState({ activeAccountId: accountId });

    await runSpamCommand(/^Report Spam/);

    expect(providers[kind].spam).not.toHaveBeenCalled();
    expect(paletteDb.execute).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO pending_operations"), expect.arrayContaining([accountId, "spam", "t1", expect.stringContaining('"isSpam":true')]));
  });

  it("marks the thread as not spam when viewing the spam folder", async () => {
    route.label = "spam";
    useAccountStore.setState({ activeAccountId: "imap-acc" });

    await runSpamCommand(/^Not Spam/);

    expect(paletteDb.execute).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO pending_operations"), expect.arrayContaining(["imap-acc", "spam", "t1", expect.stringContaining('"isSpam":false')]));
  });

  it("queues the report when offline instead of calling the provider", async () => {
    useAccountStore.setState({ activeAccountId: "gmail-acc" });
    useUIStore.setState({ isOnline: false });

    await runSpamCommand(/^Report Spam/);

    expect(providers.gmail.spam).not.toHaveBeenCalled();
    expect(paletteDb.execute).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO pending_operations"), expect.arrayContaining(["gmail-acc", "spam", "t1"]));
  });
});


it("shows current ClickUp and Velo to-do shortcut hints after rebinding", () => {
  pretendPlatform("windows");
  useShortcutStore.setState({ keyMap: { ...getDefaultKeyMap(), "action.clickupTask": "Alt+T", "action.createTaskFromEmail": "Shift+Y" } });
  render(<CommandPalette isOpen onClose={() => {}} />);
  expect(screen.getByText("Create / link ClickUp task").closest('[role="option"]')).toHaveTextContent("Alt+T");
  expect(screen.getByText("Create Velo to-do from email (AI)").closest('[role="option"]')).toHaveTextContent("Shift+Y");
});

describe("palette subpages", () => {
  it("filters move choices and queues a move instead of adding a label", async () => {
    paletteDb.execute.mockClear();
    vi.mocked(getSelectedThreadId).mockReturnValue("t1");
    useAccountStore.setState({ activeAccountId: "imap-acc" });
    useLabelStore.setState({ labels: [{ id: "Work", name: "Work" }, { id: "Family", name: "Family" }] as never });
    render(<CommandPalette isOpen onClose={() => {}} />);
    fireEvent.click(screen.getByRole("option", { name: /Move to/ }));
    typeQuery("Work");
    expect(screen.queryByRole("option", { name: "Family" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: "Work" }));
    await vi.waitFor(() => expect(paletteDb.execute).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO pending_operations"), expect.arrayContaining(["imap-acc", "moveToFolder", "t1", expect.stringContaining('"folderPath":"Work"')])));
    vi.mocked(getSelectedThreadId).mockReturnValue(null);
  });

  it("filters snooze presets using the subpage search", () => {
    vi.mocked(getSelectedThreadId).mockReturnValue("t1");
    render(<CommandPalette isOpen onClose={() => {}} />);
    fireEvent.click(screen.getByRole("option", { name: "Snooze", exact: true }));
    typeQuery("zzzzzzzz");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    vi.mocked(getSelectedThreadId).mockReturnValue(null);
  });
});
