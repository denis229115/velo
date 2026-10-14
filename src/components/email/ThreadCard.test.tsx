import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ThreadCard } from "./ThreadCard";
import type { Thread } from "@/stores/threadStore";

vi.mock("@dnd-kit/core", () => ({
  useDraggable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    isDragging: false,
  }),
}));

vi.mock("@/stores/threadStore", () => ({
  useThreadStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) =>
      selector({
        selectedThreadIds: new Set(),
        toggleThreadSelection: vi.fn(),
        selectThreadRange: vi.fn(),
      }),
    { getState: () => ({ selectedThreadIds: new Set() }) },
  ),
}));

vi.mock("@/stores/uiStore", () => ({
  useUIStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ emailDensity: "default" }),
}));

vi.mock("@/hooks/useRouteNavigation", () => ({
  useActiveLabel: () => "inbox",
}));

const actions = vi.hoisted(() => ({
  starThread: vi.fn(async () => ({ success: true })),
  archiveThread: vi.fn(async () => ({ success: true })),
  trashThread: vi.fn(async () => ({ success: true })),
  markThreadRead: vi.fn(async () => ({ success: true })),
}));
vi.mock("@/services/emailActions", () => actions);

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "t1",
    accountId: "a1",
    subject: "Test subject",
    snippet: "Test snippet",
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
    ...overrides,
  };
}

describe("ThreadCard", () => {
  const onClick = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders sender name and subject", () => {
    render(<ThreadCard thread={makeThread()} isSelected={false} onClick={onClick} />);
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Test subject")).toBeInTheDocument();
  });

  it("applies red background for spam threads", () => {
    const { container } = render(
      <ThreadCard
        thread={makeThread({ labelIds: ["SPAM"] })}
        isSelected={false}
        onClick={onClick}
      />,
    );
    const button = container.querySelector("button")!;
    expect(button.className).toContain("bg-red-500/8");
  });

  it("does not apply red background for non-spam threads", () => {
    const { container } = render(
      <ThreadCard
        thread={makeThread({ labelIds: ["INBOX"] })}
        isSelected={false}
        onClick={onClick}
      />,
    );
    const button = container.querySelector("button")!;
    expect(button.className).not.toContain("bg-red-500");
  });

  it("applies red background for spam even when thread has other labels", () => {
    const { container } = render(
      <ThreadCard
        thread={makeThread({ labelIds: ["INBOX", "SPAM", "IMPORTANT"] })}
        isSelected={false}
        onClick={onClick}
      />,
    );
    const button = container.querySelector("button")!;
    expect(button.className).toContain("bg-red-500/8");
  });

  it("stars a thread from the hover star without opening it", () => {
    render(<ThreadCard thread={makeThread({ isStarred: false })} isSelected={false} onClick={onClick} />);
    fireEvent.click(screen.getByRole("button", { name: "Star" }));
    expect(actions.starThread).toHaveBeenCalledWith("a1", "t1", [], true);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("archives, trashes and toggles read from the hover quick actions", () => {
    render(<ThreadCard thread={makeThread({ isRead: false })} isSelected={false} onClick={onClick} />);
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect(actions.archiveThread).toHaveBeenCalledWith("a1", "t1", []);
    fireEvent.click(screen.getByRole("button", { name: "Move to trash" }));
    expect(actions.trashThread).toHaveBeenCalledWith("a1", "t1", []);
    fireEvent.click(screen.getByRole("button", { name: "Mark as read" }));
    expect(actions.markThreadRead).toHaveBeenCalledWith("a1", "t1", [], true);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("opens the thread when its row is clicked", () => {
    const thread = makeThread();
    render(<ThreadCard thread={thread} isSelected={false} onClick={onClick} />);
    fireEvent.click(screen.getByRole("button", { name: /email from Alice/ }));
    expect(onClick).toHaveBeenCalledWith(thread);
  });
});
