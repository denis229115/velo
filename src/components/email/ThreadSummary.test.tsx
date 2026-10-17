import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import type { DbMessage } from "@/services/db/messages";

vi.mock("@/services/ai/gateway", () => ({ getAiReadiness: vi.fn() }));
const summarizeThread = vi.hoisted(() => vi.fn());
vi.mock("@/services/ai/aiService", () => ({
  summarizeThread,
  summarizeThreadStream: async function* (
    threadId: string,
    accountId: string,
    messages: unknown,
    options?: { refresh?: boolean },
  ) {
    yield await summarizeThread(threadId, accountId, messages, options);
  },
}));

import { getAiReadiness } from "@/services/ai/gateway";
import { summarizeThread as summarizeThreadExport } from "@/services/ai/aiService";
import { AiError } from "@/services/ai/errors";
import { takePreviewRequest } from "@/services/ai/sendPreview";
import { ThreadSummary } from "./ThreadSummary";

const messages = [
  { id: "m1", subject: "Invoice question", body_text: "Could you resend it?" },
  { id: "m2", subject: "Re: Invoice question", body_text: "Sure." },
] as DbMessage[];

function renderSummary() {
  return render(<ThreadSummary threadId="thread-1" accountId="acc-1" messages={messages} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("ThreadSummary", () => {
  it("shows why AI is refused for a non-approved provider, without asking it", async () => {
    vi.mocked(getAiReadiness).mockResolvedValue({
      status: "refused",
      provider: "openai",
      message: "OpenAI is not approved to receive email, ticket or task content.",
    });

    renderSummary();

    expect(await screen.findByText(/OpenAI is not approved/)).toBeInTheDocument();
    expect(summarizeThreadExport).not.toHaveBeenCalled();
  });

  it("tells the operator to approve the Claude API when approval is missing", async () => {
    vi.mocked(getAiReadiness).mockResolvedValue({
      status: "needs_approval",
      message: "AI is off until you approve the Claude API (Anthropic).",
    });

    renderSummary();

    expect(await screen.findByText(/approve the Claude API/)).toBeInTheDocument();
    expect(summarizeThreadExport).not.toHaveBeenCalled();
  });

  it("renders nothing when AI is not configured", async () => {
    vi.mocked(getAiReadiness).mockResolvedValue({ status: "off", message: "No AI provider" });

    const { container } = renderSummary();

    await waitFor(() => expect(getAiReadiness).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });

  it("makes no AI request when a thread opens, even with AI ready", async () => {
    vi.mocked(getAiReadiness).mockResolvedValue({ status: "ready", provider: "claude", model: "m" });

    renderSummary();

    expect(await screen.findByRole("button", { name: "Summarize" })).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(summarizeThreadExport).not.toHaveBeenCalled();
  });

  it("summarizes only when the operator clicks Summarize", async () => {
    vi.mocked(getAiReadiness).mockResolvedValue({ status: "ready", provider: "claude", model: "m" });
    vi.mocked(summarizeThread).mockResolvedValue("They want the invoice resent.");

    renderSummary();
    fireEvent.click(await screen.findByRole("button", { name: "Summarize" }));

    expect(await screen.findByText("They want the invoice resent.")).toBeInTheDocument();
    expect(summarizeThread).toHaveBeenCalledTimes(1);
    expect(summarizeThread).toHaveBeenCalledWith("thread-1", "acc-1", messages, { refresh: false });
  });

  it("keeps the thread readable when the AI request fails", async () => {
    vi.mocked(getAiReadiness).mockResolvedValue({ status: "ready", provider: "claude", model: "m" });
    vi.mocked(summarizeThread).mockRejectedValue(new AiError("NETWORK_ERROR", "offline"));

    renderSummary();

    fireEvent.click(await screen.findByRole("button", { name: "Summarize" }));
    expect(await screen.findByText("Summary unavailable right now.")).toBeInTheDocument();
  });

  it("shows the summary and refreshes past the cache", async () => {
    vi.mocked(getAiReadiness).mockResolvedValue({ status: "ready", provider: "claude", model: "m" });
    vi.mocked(summarizeThread).mockResolvedValueOnce("They want the invoice resent.");

    renderSummary();
    fireEvent.click(await screen.findByRole("button", { name: "Summarize" }));
    expect(await screen.findByText("They want the invoice resent.")).toBeInTheDocument();

    vi.mocked(summarizeThread).mockResolvedValueOnce("Updated summary.");
    fireEvent.click(screen.getByTitle("Refresh summary"));

    expect(await screen.findByText("Updated summary.")).toBeInTheDocument();
    expect(summarizeThread).toHaveBeenLastCalledWith("thread-1", "acc-1", messages, { refresh: true });
  });

  it("names the provider and reruns the summary through the send preview", async () => {
    vi.mocked(getAiReadiness).mockResolvedValue({ status: "ready", provider: "claude", model: "m" });
    vi.mocked(summarizeThread).mockResolvedValue("They want the invoice resent.");

    renderSummary();
    fireEvent.click(await screen.findByRole("button", { name: "Summarize" }));
    expect(await screen.findByText("They want the invoice resent.")).toBeInTheDocument();
    expect(screen.getByText("Sends to Claude API (Anthropic)")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    await waitFor(() =>
      expect(summarizeThread).toHaveBeenLastCalledWith("thread-1", "acc-1", messages, { refresh: true }),
    );
    expect(takePreviewRequest("thread_summary")).toBe(true);
  });

  it("says nothing was sent when the operator cancels the preview", async () => {
    vi.mocked(getAiReadiness).mockResolvedValue({ status: "ready", provider: "claude", model: "m" });
    vi.mocked(summarizeThread).mockRejectedValue(
      new AiError("CANCELLED", "Not sent: you cancelled the send preview."),
    );

    renderSummary();

    fireEvent.click(await screen.findByRole("button", { name: "Summarize" }));
    expect(await screen.findByText("Not sent: you cancelled the send preview.")).toBeInTheDocument();
    expect(screen.queryByText("Summary unavailable right now.")).not.toBeInTheDocument();
    expect(screen.getByText("Sends to Claude API (Anthropic)")).toBeInTheDocument();
  });
});
