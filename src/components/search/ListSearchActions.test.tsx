import { render, screen, fireEvent } from "@testing-library/react";
import { ListSearchActions } from "./ListSearchActions";
import { useThreadStore } from "@/stores/threadStore";
import { useSmartFolderStore } from "@/stores/smartFolderStore";
import { useShortcutStore } from "@/stores/shortcutStore";
import { getDefaultKeyMap } from "@/constants/shortcuts";
import { pretendPlatform, restoreUserAgent } from "@/test/platform";

beforeEach(() => {
  useShortcutStore.setState({ keyMap: getDefaultKeyMap() });
  useThreadStore.setState({ searchQuery: "", searchThreadIds: null });
});
afterEach(restoreUserAgent);

describe("List search actions", () => {
  it("offers a search button that opens the palette when no search is active", () => {
    pretendPlatform("windows");
    const listener = vi.fn();
    window.addEventListener("velo-toggle-command-palette", listener);
    render(<ListSearchActions />);

    const search = screen.getByRole("button", { name: "Search" });
    expect(search).toHaveAttribute("title", "Search (Ctrl+K)");
    fireEvent.click(search);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Clear search" })).not.toBeInTheDocument();
    window.removeEventListener("velo-toggle-command-palette", listener);
  });

  it("clears an active search", () => {
    useThreadStore.setState({ searchQuery: "from:alice" });
    render(<ListSearchActions />);

    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));

    expect(useThreadStore.getState().searchQuery).toBe("");
  });

  it("saves an active search as a smart folder", () => {
    const createFolder = vi.fn();
    useSmartFolderStore.setState({ createFolder });
    useThreadStore.setState({ searchQuery: "from:alice" });
    render(<ListSearchActions />);

    fireEvent.click(screen.getByRole("button", { name: "Save as Smart Folder" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(createFolder).toHaveBeenCalledWith("from:alice", "from:alice", undefined);
  });
});
