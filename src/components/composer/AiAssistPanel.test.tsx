import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";

vi.mock("@/services/ai/gateway", () => ({ getAiReadiness: vi.fn() }));
const { composeFromPrompt, transformText } = vi.hoisted(() => ({ composeFromPrompt: vi.fn(), transformText: vi.fn() }));
vi.mock("@/services/ai/aiService", () => ({
  composeFromPrompt,
  generateReply: vi.fn(),
  transformText,
  composeFromPromptStream: async function* (instructions: string) {
    yield await composeFromPrompt(instructions);
  },
  generateReplyStream: async function* () {
    yield "";
  },
  transformTextStream: async function* (html: string, type: string) {
    yield await transformText(html, type);
  },
}));

import { getAiReadiness } from "@/services/ai/gateway";
import { AiError } from "@/services/ai/errors";
import { AiAssistPanel } from "./AiAssistPanel";

const editors: Editor[] = [];
function fakeEditor() {
  const editor = new Editor({ extensions: [StarterKit], content: "<p>My own draft</p>" });
  editors.push(editor);
  return { editor, setContent: vi.spyOn(editor.commands, "setContent") };
}
afterEach(() => { editors.splice(0).forEach((editor) => editor.destroy()); });

beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
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

    expect(await screen.findByText("Couldn't reach the assistant. Check your connection and try again.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
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

it("rewrites only the captured selection, preserving edits elsewhere during the request", async () => {
  vi.mocked(getAiReadiness).mockResolvedValue({ status: "ready", provider: "claude", model: "m" });
  let finish!: (text: string) => void;
  transformText.mockImplementation(() => new Promise<string>((resolve) => { finish = resolve; }));
  const { editor } = fakeEditor();
  editor.commands.setContent("<p>Before selected after.</p><p>Keep me.</p>");
  editor.commands.setTextSelection({ from: 8, to: 16 });
  render(<AiAssistPanel editor={editor} isReplyMode={false} />);
  fireEvent.click(await screen.findByText("Selection"));
  fireEvent.click(screen.getByRole("menuitem", { name: "Rewrite" }));
  expect(transformText).toHaveBeenCalledWith("selected", "improve");
  act(() => { editor.commands.insertContentAt(1, "New "); });
  await act(async () => { finish("revised"); });
  fireEvent.click(await screen.findByRole("button", { name: "Accept" }));
  await waitFor(() => expect(editor.getHTML()).toBe("<p>New Before revised after.</p><p>Keep me.</p>"));
});

it("refuses a stale rewrite if the selected text was edited", async () => {
  vi.mocked(getAiReadiness).mockResolvedValue({ status: "ready", provider: "claude", model: "m" });
  transformText.mockResolvedValue("replacement");
  const { editor } = fakeEditor();
  editor.commands.setTextSelection({ from: 1, to: 3 });
  render(<AiAssistPanel editor={editor} isReplyMode={false} />);
  fireEvent.click(await screen.findByText("Selection"));
  fireEvent.click(screen.getByRole("menuitem", { name: "Rewrite" }));
  await screen.findByRole("button", { name: "Accept" });
  act(() => { editor.commands.insertContentAt({ from: 1, to: 3 }, "Edited"); });
  fireEvent.click(screen.getByRole("button", { name: "Accept" }));
  expect(await screen.findByText(/The original text changed/)).toBeInTheDocument();
  expect(editor.getText()).toBe("Edited own draft");
});
