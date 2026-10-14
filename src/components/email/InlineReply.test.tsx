import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { DbMessage } from "@/services/db/messages";
import type { Thread } from "@/stores/threadStore";

vi.mock("@/services/emailActions", () => ({ sendEmail: vi.fn(), archiveThread: vi.fn() }));
vi.mock("@/services/db/contacts", () => ({ upsertContact: vi.fn() }));
vi.mock("@/services/db/settings", () => ({ getSetting: vi.fn(async () => null) }));
vi.mock("@/services/db/signatures", () => ({ getDefaultSignature: vi.fn(async () => null) }));
vi.mock("@/services/ai/writingStyleService", () => ({
  isAutoDraftEnabled: vi.fn(),
  generateAutoDraft: vi.fn(),
  regenerateAutoDraft: vi.fn(),
}));

import {
  isAutoDraftEnabled,
  generateAutoDraft,
  regenerateAutoDraft,
} from "@/services/ai/writingStyleService";
import { takePreviewRequest } from "@/services/ai/sendPreview";
import { InlineReply } from "./InlineReply";

const thread = { id: "thread-1", subject: "Lunch?" } as Thread;
const messages = [
  { id: "m1", thread_id: "thread-1", subject: "Lunch?", from_address: "sam@example.test" },
] as DbMessage[];

function renderReply() {
  return render(<InlineReply thread={thread} messages={messages} accountId="acc-1" onSent={() => {}} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom has no layout; TipTap measures when it focuses the editor.
  Element.prototype.scrollIntoView = vi.fn();
  const noRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  Element.prototype.getClientRects = noRects;
  Range.prototype.getClientRects = noRects;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});

describe("InlineReply auto-draft", () => {
  it("names the provider and regenerates the draft through the send preview", async () => {
    vi.mocked(isAutoDraftEnabled).mockResolvedValue(true);
    vi.mocked(generateAutoDraft).mockResolvedValue("<p>Sure, noon works.</p>");
    vi.mocked(regenerateAutoDraft).mockResolvedValue("<p>Noon is fine.</p>");

    renderReply();
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));

    expect(await screen.findByText("Sends to Claude API (Anthropic)")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    await waitFor(() =>
      expect(regenerateAutoDraft).toHaveBeenCalledWith("thread-1", "acc-1", messages, "reply"),
    );
    expect(takePreviewRequest("auto_draft")).toBe(true);
  });

  it("does not mention the provider when auto-draft is off", async () => {
    vi.mocked(isAutoDraftEnabled).mockResolvedValue(false);

    renderReply();
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));

    await waitFor(() => expect(isAutoDraftEnabled).toHaveBeenCalled());
    expect(screen.queryByText("Sends to Claude API (Anthropic)")).not.toBeInTheDocument();
    expect(generateAutoDraft).not.toHaveBeenCalled();
  });
});
