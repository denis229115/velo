import { render, screen, fireEvent } from "@testing-library/react";
import { SidebarHeaderActions } from "./SidebarHeaderActions";
import { useComposerStore } from "@/stores/composerStore";
import { useShortcutStore } from "@/stores/shortcutStore";
import { getDefaultKeyMap } from "@/constants/shortcuts";
import { pretendPlatform, restoreUserAgent } from "@/test/platform";

beforeEach(() => {
  useShortcutStore.setState({ keyMap: getDefaultKeyMap() });
  useComposerStore.setState({ isOpen: false });
});
afterEach(restoreUserAgent);

describe("Sidebar header actions", () => {
  it("composes from a pencil button whose tooltip names the shortcut", () => {
    render(<SidebarHeaderActions collapsed={false} />);

    const compose = screen.getByRole("button", { name: "Compose" });
    expect(compose).toHaveAttribute("title", "Compose (C)");
    fireEvent.click(compose);

    expect(useComposerStore.getState().isOpen).toBe(true);
  });

  it("follows a rebound compose key", () => {
    useShortcutStore.setState({ keyMap: { ...getDefaultKeyMap(), "action.compose": "n" } });
    render(<SidebarHeaderActions collapsed={false} />);

    expect(screen.getByRole("button", { name: "Compose" })).toHaveAttribute("title", "Compose (N)");
  });

  it("opens search from the search button, labelled for the platform", () => {
    pretendPlatform("mac");
    const listener = vi.fn();
    window.addEventListener("velo-toggle-command-palette", listener);
    render(<SidebarHeaderActions collapsed={false} />);

    const search = screen.getByRole("button", { name: "Search" });
    expect(search).toHaveAttribute("title", "Search (Cmd+K)");
    fireEvent.click(search);

    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener("velo-toggle-command-palette", listener);
  });

  it("keeps Ctrl wording on Windows", () => {
    pretendPlatform("windows");
    render(<SidebarHeaderActions collapsed={false} />);

    expect(screen.getByRole("button", { name: "Search" })).toHaveAttribute("title", "Search (Ctrl+K)");
  });

  it("shows both icons in the collapsed sidebar", () => {
    render(<SidebarHeaderActions collapsed />);

    expect(screen.getByRole("button", { name: "Compose" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Search" })).toBeInTheDocument();
  });
});
