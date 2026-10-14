import { render, screen, fireEvent, within } from "@testing-library/react";
import { CommandPalette } from "./CommandPalette";
import { pretendPlatform, restoreUserAgent } from "@/test/platform";
import { searchMessages, type SearchResult } from "@/services/db/search";
import { navigateToThread, navigateToLabel, getActiveLabel } from "@/router/navigate";
import { useThreadStore } from "@/stores/threadStore";
import { useSmartFolderStore } from "@/stores/smartFolderStore";
import { useAccountStore } from "@/stores/accountStore";

vi.mock("@/router/navigate", () => ({
  navigateToLabel: vi.fn(),
  navigateToThread: vi.fn(),
  navigateBack: vi.fn(),
  getActiveLabel: vi.fn(() => "inbox"),
  getSelectedThreadId: vi.fn(() => null),
}));
vi.mock("@/services/db/search", () => ({ searchMessages: vi.fn(async () => []) }));
vi.mock("@/hooks/useRouteNavigation", () => ({ useActiveLabel: () => "inbox" }));
vi.mock("@/services/db/templates", () => ({ getTemplatesForAccount: vi.fn(async () => []) }));
vi.mock("@/services/gmail/tokenManager", () => ({ getGmailClient: vi.fn() }));

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

    await screen.findByText("Inbox zero tips");
    const threads = screen.getByRole("group", { name: "Threads" });
    expect(within(threads).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Inbox zero tipsAlice",
      "Weekly inbox reportCarol",
      "Show all results for “inbox”",
    ]);
    const commands = screen.getByRole("group", { name: "Commands" });
    expect(within(commands).getByText("Go to Inbox")).toBeInTheDocument();
    expect(searchMessages).toHaveBeenCalledWith("inbox", "acc-1", expect.any(Number));
  });

  it("opens a thread with the arrow keys and Enter", async () => {
    vi.mocked(searchMessages).mockResolvedValue([hit("t9", "Quarterly numbers", "Dana")]);
    const onClose = vi.fn();
    render(<CommandPalette isOpen onClose={onClose} />);

    const input = typeQuery("quarterly");
    await screen.findByText("Quarterly numbers");
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
