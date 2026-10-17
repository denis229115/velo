import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
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

function draftEvent(text: string) {
  act(() => { window.dispatchEvent(new CustomEvent("velo-insert-reply-draft", { detail: { text } })); });
}

it.each(["Replace", "Insert", "Discard"])("preserves a typed reply until the operator chooses %s", async (choice) => {
  vi.mocked(isAutoDraftEnabled).mockResolvedValue(false);
  const { container } = renderReply();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Reply" })); });
  const dom = container.querySelector(".tiptap") as HTMLElement & { editor: Editor };
  act(() => { dom.editor.commands.setContent("<p>My reply</p>"); });
  draftEvent("AI <draft> & details");
  expect(dom.editor.getHTML()).toBe("<p>My reply</p>");
  expect(screen.getByRole("region", { name: "Proposed reply draft" })).toHaveTextContent("AI <draft> & details");
  // Edits made while the choice is visible must also survive Insert/Discard.
  act(() => { dom.editor.commands.setContent("<p>My edited reply</p>"); });
  fireEvent.click(screen.getByRole("button", { name: choice, exact: true }));
  const generated = "<p>AI &lt;draft&gt; &amp; details</p>";
  expect(dom.editor.getHTML()).toBe(choice === "Replace" ? generated : "<p>My edited reply</p>" + (choice === "Insert" ? generated : ""));
  expect(screen.queryByRole("region", { name: "Proposed reply draft" })).not.toBeInTheDocument();
});

it("inserts an escaped proposal into an empty reply without sending", async () => {
  vi.mocked(isAutoDraftEnabled).mockResolvedValue(false);
  const { container } = renderReply();
  await act(async () => { draftEvent("Hello <script>alert(1)</script>"); });
  const dom = container.querySelector(".tiptap") as HTMLElement & { editor: Editor };
  expect(dom.editor.getText()).toBe("Hello <script>alert(1)</script>");
  expect(dom.querySelector("script")).toBeNull();
  expect(screen.getByText("Review this draft before sending.")).toBeInTheDocument();
});
