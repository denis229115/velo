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

/** The settings row for an action, found by its description. */
function row(desc: string): HTMLElement {
  return screen.getByText(desc, { selector: "span" }).closest("[data-shortcut-row]") as HTMLElement;
}

function rebind(desc: string, init: KeyboardEventInit) {
  const button = within(row(desc)).getAllByRole("button")[0]!;
  fireEvent.click(button);
  fireEvent.keyDown(button, init);
}

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
