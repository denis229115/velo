import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies needed for the hook to mount and dispatch events.
// The hook reads store state and calls navigate/emailActions — only mock
// what's needed for the three event-dispatch tests below.
vi.mock("@/stores/uiStore", () => ({
  useUIStore: { getState: () => ({ inboxViewMode: "unified", toggleSidebar: vi.fn() }) },
}));
vi.mock("@/stores/threadStore", () => ({
  useThreadStore: {
    getState: () => ({
      threads: [],
      selectedThreadIds: new Set(),
      removeThread: vi.fn(),
      removeThreads: vi.fn(),
      updateThread: vi.fn(),
      clearMultiSelect: vi.fn(),
      selectAll: vi.fn(),
      selectAllFromHere: vi.fn(),
    }),
  },
}));
vi.mock("@/stores/composerStore", () => ({
  useComposerStore: { getState: () => ({ isOpen: false, openComposer: vi.fn(), closeComposer: vi.fn() }) },
}));
vi.mock("@/stores/accountStore", () => ({
  useAccountStore: { getState: () => ({ activeAccountId: null }) },
}));
const DEFAULT_TEST_KEYMAP: Record<string, string> = {
  "app.askInbox": "i",
  "app.commandPalette": "/",
  "app.search": "Ctrl+K",
  "app.toggleSidebar": "Ctrl+Shift+E",
  "app.help": "?",
};
const shortcutState = vi.hoisted(() => ({ keyMap: {} as Record<string, string> }));
vi.mock("@/stores/shortcutStore", () => ({
  useShortcutStore: { getState: () => shortcutState },
}));
vi.mock("@/stores/contextMenuStore", () => ({
  useContextMenuStore: { getState: () => ({ menuType: null, closeMenu: vi.fn() }) },
}));
vi.mock("@/router/navigate", () => ({
  navigateToLabel: vi.fn(),
  navigateToThread: vi.fn(),
  navigateBack: vi.fn(),
  getActiveLabel: () => "inbox",
  getSelectedThreadId: () => null,
}));
vi.mock("@/services/emailActions", () => ({
  archiveThread: vi.fn(),
  trashThread: vi.fn(),
  permanentDeleteThread: vi.fn(),
  starThread: vi.fn(),
  spamThread: vi.fn(),
}));
vi.mock("@/services/db/threads", () => ({
  deleteThread: vi.fn(),
  pinThread: vi.fn(),
  unpinThread: vi.fn(),
  muteThread: vi.fn(),
  unmuteThread: vi.fn(),
}));
vi.mock("@/services/gmail/draftDeletion", () => ({ deleteDraftsForThread: vi.fn() }));
vi.mock("@/services/gmail/tokenManager", () => ({ getGmailClient: vi.fn() }));
vi.mock("@/services/db/messages", () => ({ getMessagesForThread: vi.fn() }));
vi.mock("@/components/email/MessageItem", () => ({ parseUnsubscribeUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@/services/gmail/syncManager", () => ({ triggerSync: vi.fn() }));

import { renderHook } from "@testing-library/react";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";

describe("useKeyboardShortcuts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shortcutState.keyMap = DEFAULT_TEST_KEYMAP;
  });

  it("lets mail shortcuts through the hidden-pane reader and blocks other dialogs", () => {
    renderHook(() => useKeyboardShortcuts());
    const listener = vi.fn();
    window.addEventListener("velo-toggle-ask-inbox", listener);
    const reader = document.createElement("div");
    const other = document.createElement("div");
    reader.setAttribute("role", "dialog");
    reader.setAttribute("data-mail-reader", "");
    other.setAttribute("role", "dialog");
    document.body.appendChild(reader);

    try {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "i", bubbles: true }));
      expect(listener).toHaveBeenCalledTimes(1);

      document.body.appendChild(other);
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "i", bubbles: true }));
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      reader.remove();
      other.remove();
      window.removeEventListener("velo-toggle-ask-inbox", listener);
    }
  });

  it("dispatches velo-toggle-ask-inbox when 'i' is pressed", () => {
    renderHook(() => useKeyboardShortcuts());

    const listener = vi.fn();
    window.addEventListener("velo-toggle-ask-inbox", listener);

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "i", bubbles: true }),
    );

    expect(listener).toHaveBeenCalledTimes(1);

    window.removeEventListener("velo-toggle-ask-inbox", listener);
  });

  it("dispatches velo-toggle-command-palette when '/' is pressed", () => {
    renderHook(() => useKeyboardShortcuts());

    const listener = vi.fn();
    window.addEventListener("velo-toggle-command-palette", listener);

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "/", bubbles: true }),
    );

    expect(listener).toHaveBeenCalledTimes(1);

    window.removeEventListener("velo-toggle-command-palette", listener);
  });

  it("dispatches velo-toggle-shortcuts-help when '?' is pressed", () => {
    renderHook(() => useKeyboardShortcuts());

    const listener = vi.fn();
    window.addEventListener("velo-toggle-shortcuts-help", listener);

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "?", shiftKey: true, bubbles: true }),
    );

    expect(listener).toHaveBeenCalledTimes(1);

    window.removeEventListener("velo-toggle-shortcuts-help", listener);
  });

  describe("search (Cmd+K)", () => {
    function pressInInput(init: KeyboardEventInit) {
      const input = document.createElement("input");
      document.body.appendChild(input);
      input.focus();
      input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
      input.remove();
    }

    it("opens the palette with Cmd+K even while typing in a field", () => {
      renderHook(() => useKeyboardShortcuts());
      const listener = vi.fn();
      window.addEventListener("velo-toggle-command-palette", listener);

      pressInInput({ key: "k", metaKey: true });
      pressInInput({ key: "k", ctrlKey: true });

      expect(listener).toHaveBeenCalledTimes(2);
      window.removeEventListener("velo-toggle-command-palette", listener);
    });

    it("follows a rebound search shortcut", () => {
      shortcutState.keyMap = { ...DEFAULT_TEST_KEYMAP, "app.search": "Ctrl+J" };
      renderHook(() => useKeyboardShortcuts());
      const listener = vi.fn();
      window.addEventListener("velo-toggle-command-palette", listener);

      pressInInput({ key: "k", metaKey: true });
      expect(listener).not.toHaveBeenCalled();

      pressInInput({ key: "j", metaKey: true });
      expect(listener).toHaveBeenCalledTimes(1);
      window.removeEventListener("velo-toggle-command-palette", listener);
    });
  });
});
