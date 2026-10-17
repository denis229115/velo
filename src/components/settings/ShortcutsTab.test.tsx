import { fireEvent, render, screen, within } from "@testing-library/react";

vi.mock("@/services/db/settings", () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  getSecureSetting: vi.fn(async () => null),
  setSecureSetting: vi.fn(async () => {}),
}));
vi.mock("@/services/globalShortcut", () => ({
  registerComposeShortcut: vi.fn(async () => {}),
  getCurrentShortcut: vi.fn(() => null),
  DEFAULT_SHORTCUT: "CmdOrCtrl+Shift+M",
}));

import { ShortcutsTab } from "./SettingsPage";
import { useShortcutStore } from "@/stores/shortcutStore";
import { getDefaultKeyMap } from "@/constants/shortcuts";
import { pretendPlatform, restoreUserAgent } from "@/test/platform";

/** The settings row for an action, found by its description. */
function row(desc: string): HTMLElement {
  return screen.getByText(desc, { selector: "span" }).closest("[data-shortcut-row]") as HTMLElement;
}

function rebind(desc: string, init: KeyboardEventInit) {
  const button = within(row(desc)).getAllByRole("button")[0]!;
  fireEvent.click(button);
  fireEvent.keyDown(button, init);
}

afterEach(restoreUserAgent);

beforeEach(() => {
  useShortcutStore.setState({ keyMap: getDefaultKeyMap() });
});

describe("Shortcuts settings", () => {
  it("shows no conflict warnings for the default bindings", () => {
    render(<ShortcutsTab />);
    expect(screen.queryByText(/also used by/i)).not.toBeInTheDocument();
  });

  it("warns on both actions when a key is assigned that another action already uses", () => {
    render(<ShortcutsTab />);

    rebind("Archive", { key: "s" });

    expect(within(row("Archive")).getByText(/also used by star \/ unstar/i)).toBeInTheDocument();
    expect(within(row("Star / Unstar")).getByText(/also used by archive/i)).toBeInTheDocument();
  });

  it("treats Cmd and Ctrl as the same key when checking send-later against send-now", () => {
    render(<ShortcutsTab />);

    rebind("Send later", { key: "Enter", metaKey: true });

    expect(within(row("Send later")).getByText(/also used by send now/i)).toBeInTheDocument();
  });

  it("clears the warning once the clash is resolved", () => {
    render(<ShortcutsTab />);
    rebind("Archive", { key: "s" });

    rebind("Archive", { key: "y" });

    expect(screen.queryByText(/also used by/i)).not.toBeInTheDocument();
  });
});

describe("Shortcuts settings labels", () => {
  it("shows Cmd/Option wording on macOS, including the global shortcut and reset hint", () => {
    pretendPlatform("mac");
    useShortcutStore.setState({ keyMap: { ...getDefaultKeyMap(), "app.send": "Alt+Shift+K" } });
    render(<ShortcutsTab />);

    expect(within(row("Send later")).getByRole("button")).toHaveTextContent("Cmd+Shift+L");
    expect(within(row("Send now")).getByRole("button", { name: "Option+Shift+K" })).toBeInTheDocument();
    expect(within(row("Send now")).getByTitle("Reset to Cmd+Enter")).toBeInTheDocument();
    expect(screen.getByText("Cmd+Shift+M")).toBeInTheDocument();
    expect(screen.queryByText(/ctrl/i)).not.toBeInTheDocument();
  });

  it("keeps Ctrl wording on Windows", () => {
    pretendPlatform("windows");
    render(<ShortcutsTab />);

    expect(within(row("Send later")).getByRole("button")).toHaveTextContent("Ctrl+Shift+L");
  });
});


it("warns when a ticket shortcut duplicates an email shortcut, then clears on reset", () => {
  render(<ShortcutsTab />);
  rebind("Ticket: Internal note", { key: "r" });
  expect(within(row("Ticket: Internal note")).getByRole("alert")).toHaveTextContent("Also used by Reply");
  expect(within(row("Reply")).getByRole("alert")).toHaveTextContent("Also used by Ticket: Internal note");
  fireEvent.click(within(row("Ticket: Internal note")).getByTitle("Reset to n"));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});


it("lists ticket and shared defaults without assigning t to a Velo to-do", () => {
  render(<ShortcutsTab />);
  for (const [desc, key] of [
    ["Next thread / ticket", "j"], ["Previous thread / ticket", "k"], ["Open thread / ticket", "Enter"],
    ["Reply", "r"], ["Ticket: Internal note", "n"], ["Ticket: Summarize", "z"], ["Ticket: AI draft reply", "d"],
    ["Create / link ClickUp task", "t"], ["Create Velo to-do from email (AI)", "Shift+T"],
    ["Ticket: Change status", "s"], ["Ticket: Change priority", "p"],
    ["Ticket: Change assignee", "a"], ["Ticket: Switch list / board", "b"],
  ]) {
    expect(within(row(desc!)).getByRole("button", { name: key })).toBeVisible();
  }
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
