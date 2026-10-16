import { act, render, screen } from "@testing-library/react";
import { StatusBar } from "./StatusBar";
import { useShortcutStore } from "@/stores/shortcutStore";
import { useUIStore } from "@/stores/uiStore";
import { getDefaultKeyMap } from "@/constants/shortcuts";

vi.mock("@/services/db/settings", () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
}));

describe("StatusBar", () => {
  beforeEach(() => {
    useShortcutStore.setState({ keyMap: getDefaultKeyMap() });
    useUIStore.setState({ isOnline: true });
  });

  it("shows the navigate, open and shortcuts hints from the shortcut registry", () => {
    render(<StatusBar />);
    const hints = screen.getByRole("list", { name: "Keyboard hints" });
    expect(hints).toHaveTextContent("JKNavigate");
    expect(hints).toHaveTextContent("↵Open");
    expect(hints).toHaveTextContent("?Shortcuts");
  });

  it("updates the hints when a shortcut is rebound", () => {
    render(<StatusBar />);
    act(() => useShortcutStore.getState().setKey("nav.next", "n"));
    act(() => useShortcutStore.getState().setKey("nav.open", "Enter"));
    const hints = screen.getByRole("list", { name: "Keyboard hints" });
    expect(hints).toHaveTextContent("NKNavigate");
    expect(hints).toHaveTextContent("↵Open");
  });

  it("shows the connection state", () => {
    render(<StatusBar />);
    expect(screen.getByRole("status")).toHaveTextContent("Connected");
    act(() => useUIStore.setState({ isOnline: false }));
    expect(screen.getByRole("status")).toHaveTextContent("Offline");
  });

  it("shows sync progress and failures in place of the connection state", () => {
    const { rerender } = render(<StatusBar syncStatus="Syncing: 10/50 messages" />);
    expect(screen.getByRole("status")).toHaveTextContent("Syncing: 10/50 messages");
    rerender(<StatusBar syncStatus="Sync failed: timeout" />);
    expect(screen.getByRole("status")).toHaveTextContent("Sync failed: timeout");
    expect(screen.getByRole("status").querySelector("[data-tone]")).toHaveAttribute("data-tone", "error");
  });

  it("can show other hints for other lists", () => {
    render(<StatusBar hints={[{ ids: ["action.archive"], label: "Archive" }]} />);
    expect(screen.getByRole("list", { name: "Keyboard hints" })).toHaveTextContent("EArchive");
  });
});
