import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { Editor } from "@tiptap/react";

vi.mock("@/services/ai/gateway", () => ({ getAiReadiness: vi.fn() }));
vi.mock("@/services/ai/aiService", () => ({
  composeFromPrompt: vi.fn(),
  generateReply: vi.fn(),
  transformText: vi.fn(),
}));

import { getAiReadiness } from "@/services/ai/gateway";
import { composeFromPrompt } from "@/services/ai/aiService";
import { AiError } from "@/services/ai/errors";
import { AiAssistPanel } from "./AiAssistPanel";

function fakeEditor() {
  const setContent = vi.fn();
  const chain = { focus: () => chain, setContent: (html: string) => { setContent(html); return chain; }, run: vi.fn() };
  return {
    editor: { chain: () => chain, getHTML: () => "<p>My own draft</p>" } as unknown as Editor,
    setContent,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AiAssistPanel", () => {
  it("shows why AI is refused instead of the AI controls", async () => {
    vi.mocked(getAiReadiness).mockResolvedValue({
      status: "refused",
      provider: "gemini",
      message: "Google Gemini is not approved to receive email, ticket or task content.",
    });

    render(<AiAssistPanel editor={fakeEditor().editor} isReplyMode={false} />);

    expect(await screen.findByText(/Google Gemini is not approved/)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Describe what to write...")).not.toBeInTheDocument();
  });

  it("leaves the draft untouched and explains when the AI request fails", async () => {
    vi.mocked(getAiReadiness).mockResolvedValue({ status: "ready", provider: "claude", model: "m" });
    vi.mocked(composeFromPrompt).mockRejectedValue(new AiError("NETWORK_ERROR", "Network unavailable"));
    const { editor, setContent } = fakeEditor();

    render(<AiAssistPanel editor={editor} isReplyMode={false} />);
    const input = await screen.findByPlaceholderText("Describe what to write...");
    fireEvent.change(input, { target: { value: "Ask for the invoice" } });
    fireEvent.click(screen.getByText("Generate"));

    expect(await screen.findByText("Network unavailable")).toBeInTheDocument();
    expect(setContent).not.toHaveBeenCalled();
  });

  it("names the provider at the point of sending", async () => {
    vi.mocked(getAiReadiness).mockResolvedValue({ status: "ready", provider: "claude", model: "m" });
    const { editor } = fakeEditor();

    render(<AiAssistPanel editor={editor} isReplyMode={false} />);

    expect(await screen.findByText("Sends to Claude API (Anthropic)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview" })).toBeInTheDocument();
  });
});
