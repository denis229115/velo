import { render, screen } from "@testing-library/react";
import { ShortcutsHelp } from "./ShortcutsHelp";
import { useShortcutStore } from "@/stores/shortcutStore";
import { getDefaultKeyMap } from "@/constants/shortcuts";
import { pretendPlatform, restoreUserAgent } from "@/test/platform";

beforeEach(() => {
  useShortcutStore.setState({ keyMap: getDefaultKeyMap() });
});
afterEach(restoreUserAgent);

describe("Shortcuts help", () => {
  it("shows Cmd/Shift wording on macOS", () => {
    pretendPlatform("mac");
    render(<ShortcutsHelp isOpen onClose={() => {}} />);

    expect(screen.getByText("Cmd+Shift+L")).toBeInTheDocument();
    expect(screen.getByText("Cmd+Enter")).toBeInTheDocument();
    expect(screen.queryByText(/ctrl/i)).not.toBeInTheDocument();
  });

  it("keeps Ctrl wording on Windows", () => {
    pretendPlatform("windows");
    render(<ShortcutsHelp isOpen onClose={() => {}} />);

    expect(screen.getByText("Ctrl+Shift+L")).toBeInTheDocument();
    expect(screen.queryByText(/cmd/i)).not.toBeInTheDocument();
  });

  it("shows a rebound key with Option on macOS", () => {
    pretendPlatform("mac");
    useShortcutStore.setState({ keyMap: { ...getDefaultKeyMap(), "app.sendLater": "Alt+Shift+K" } });
    render(<ShortcutsHelp isOpen onClose={() => {}} />);

    expect(screen.getByText("Option+Shift+K")).toBeInTheDocument();
  });

  it("lists search with Cmd+K on macOS", () => {
    pretendPlatform("mac");
    render(<ShortcutsHelp isOpen onClose={() => {}} />);

    const row = screen.getByText("Search mail, tickets and commands").closest("[data-shortcut-row]")!;
    expect(row).toHaveTextContent("Cmd+K");
  });
});


it("shows ticket defaults and warns when a rebound ticket action conflicts", () => {
  useShortcutStore.setState({ keyMap: { ...getDefaultKeyMap(), "ticket.note": "r" } });
  render(<ShortcutsHelp isOpen onClose={() => {}} />);
  for (const [desc, key] of [
    ["Open thread / ticket", "Enter"], ["Ticket: Summarize", "z"], ["Ticket: AI draft reply", "d"],
    ["Create / link ClickUp task", "t"], ["Create Velo to-do from email (AI)", "Shift+T"],
    ["Ticket: Change status", "Shift+S"], ["Ticket: Change priority", "Shift+P"],
    ["Ticket: Change assignee", "Shift+A"], ["Ticket: Switch list / board", "b"],
  ]) {
    expect(screen.getByText(desc!).closest("[data-shortcut-row]")).toHaveTextContent(key!);
  }
  expect(screen.getByText("Ticket: Internal note").closest("[data-shortcut-row]")).toHaveTextContent("Also used by Reply");
});
