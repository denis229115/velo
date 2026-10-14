import { fireEvent, render } from "@testing-library/react";
import { Archive, Trash2 } from "lucide-react";
import { ContextMenu } from "./ContextMenu";
import { Modal } from "./Modal";
import { ThreadCard } from "@/components/email/ThreadCard";
import type { Thread } from "@/stores/threadStore";
import { injectThemeCss } from "@/test/themeTestUtils";

vi.mock("@/hooks/useClickOutside", () => ({ useClickOutside: vi.fn() }));

vi.mock("@/stores/contextMenuStore", () => ({
  useContextMenuStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) =>
      selector({ menuType: null, position: { x: 0, y: 0 }, data: {}, openMenu: vi.fn(), closeMenu: vi.fn() }),
    { getState: () => ({ menuType: null, closeMenu: vi.fn() }) },
  ),
}));

vi.mock("@dnd-kit/core", () => ({
  useDraggable: () => ({ attributes: {}, listeners: {}, setNodeRef: vi.fn(), isDragging: false }),
}));

vi.mock("@/stores/threadStore", () => ({
  useThreadStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) =>
      selector({ selectedThreadIds: new Set(), toggleThreadSelection: vi.fn(), selectThreadRange: vi.fn() }),
    { getState: () => ({ selectedThreadIds: new Set() }) },
  ),
}));

vi.mock("@/stores/uiStore", () => ({
  useUIStore: (selector: (s: Record<string, unknown>) => unknown) => selector({ emailDensity: "compact" }),
}));

vi.mock("@/hooks/useRouteNavigation", () => ({ useActiveLabel: () => "inbox" }));

const thread: Thread = {
  id: "t1",
  accountId: "a1",
  subject: "Quarterly report",
  snippet: "Numbers attached",
  lastMessageAt: Date.now(),
  messageCount: 1,
  isRead: false,
  isStarred: false,
  isPinned: false,
  isMuted: false,
  hasAttachments: false,
  labelIds: ["INBOX"],
  fromName: "Alice",
  fromAddress: "alice@example.com",
};

// Tab-reachable elements; tabindex="-1" controls (e.g. hover-only row actions) are exempt, as in theme.css
const FOCUSABLE =
  'button:not([tabindex="-1"]), a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

function expectVisibleFocusRing(el: HTMLElement) {
  // Move focus the way a keyboard user does (Tab), so :focus-visible applies
  (document.activeElement as HTMLElement | null)?.blur();
  fireEvent.keyDown(document.body, { key: "Tab" });
  el.focus();
  expect(document.activeElement).toBe(el);
  const style = getComputedStyle(el);
  expect(style.outlineStyle, el.outerHTML.slice(0, 80)).toBe("solid");
  expect(style.outlineColor).toBe("var(--state-focus)");
}

describe("keyboard focus is visible", () => {
  beforeAll(() => {
    // Stands in for Tailwind's `outline-none` utility (layered, so ordered before
    // the unlayered theme). The ring must survive it.
    const utilities = document.createElement("style");
    utilities.textContent = ".outline-none { outline-style: none; }";
    document.head.appendChild(utilities);
    injectThemeCss();
  });

  describe.each(["light", "dark"] as const)("in the %s theme", (theme) => {
    beforeEach(() => {
      document.documentElement.classList.toggle("dark", theme === "dark");
    });

    it("on email list rows", () => {
      const { container } = render(<ThreadCard thread={thread} isSelected={false} onClick={vi.fn()} />);
      const focusables = container.querySelectorAll<HTMLElement>(FOCUSABLE);
      expect(focusables.length).toBeGreaterThan(0);
      focusables.forEach(expectVisibleFocusRing);
    });

    it("on menu items reached with the arrow keys", () => {
      const { getByText } = render(
        <ContextMenu
          items={[
            { id: "archive", label: "Archive", icon: Archive, action: vi.fn() },
            { id: "sep", label: "", separator: true },
            { id: "delete", label: "Delete", icon: Trash2, danger: true, action: vi.fn() },
          ]}
          position={{ x: 10, y: 10 }}
          onClose={vi.fn()}
        />,
      );
      const archive = getByText("Archive").closest("button")!;
      const del = getByText("Delete").closest("button")!;

      // Arrow keys move real focus, not just a hover tint
      fireEvent.keyDown(window, { key: "ArrowDown" });
      expect(document.activeElement).toBe(archive);
      fireEvent.keyDown(window, { key: "ArrowDown" });
      expect(document.activeElement).toBe(del);

      // ...and a focused item carries the ring (jsdom can't model keyboard-driven
      // programmatic focus for :focus-visible, so check each item via Tab)
      [archive, del].forEach(expectVisibleFocusRing);
    });

    it("on dialog controls, including inputs styled with outline-none", () => {
      render(
        <Modal isOpen onClose={vi.fn()} title="Rename label">
          <input className="outline-none" aria-label="Label name" />
          <button>Save</button>
        </Modal>,
      );
      document.body.querySelectorAll<HTMLElement>(FOCUSABLE).forEach(expectVisibleFocusRing);
    });
  });
});
