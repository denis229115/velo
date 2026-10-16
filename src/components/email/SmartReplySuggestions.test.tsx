import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { DbMessage } from "@/services/db/messages";

vi.mock("@/services/ai/gateway", () => ({ isAiAvailable: vi.fn() }));
vi.mock("@/services/ai/aiService", () => ({ generateSmartReplies: vi.fn() }));

import { isAiAvailable } from "@/services/ai/gateway";
import { generateSmartReplies } from "@/services/ai/aiService";
import { takePreviewRequest } from "@/services/ai/sendPreview";
import { SmartReplySuggestions } from "./SmartReplySuggestions";

const messages = [
  { id: "m1", thread_id: "thread-1", subject: "Lunch?", from_address: "sam@example.test" },
] as DbMessage[];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SmartReplySuggestions", () => {
  it("waits for the operator to generate replies when an email opens", async () => {
    vi.mocked(isAiAvailable).mockResolvedValue(true);
    vi.mocked(generateSmartReplies).mockResolvedValue(["Sounds good"]);

    render(<SmartReplySuggestions threadId="thread-1" accountId="acc-1" messages={messages} />);

    const generate = await screen.findByRole("button", { name: "Generate replies" });
    expect(generateSmartReplies).not.toHaveBeenCalled();

    fireEvent.click(generate);

    expect(await screen.findByRole("button", { name: "Sounds good" })).toBeInTheDocument();
    expect(generateSmartReplies).toHaveBeenCalledTimes(1);
  });

  it("names the provider and reruns the suggestions through the send preview", async () => {
    vi.mocked(isAiAvailable).mockResolvedValue(true);
    vi.mocked(generateSmartReplies).mockResolvedValue(["Sounds good"]);

    render(<SmartReplySuggestions threadId="thread-1" accountId="acc-1" messages={messages} />);

    fireEvent.click(await screen.findByRole("button", { name: "Generate replies" }));
    expect(await screen.findByText("Sounds good")).toBeInTheDocument();
    expect(screen.getByText("Sends to Claude API (Anthropic)")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    await waitFor(() =>
      expect(generateSmartReplies).toHaveBeenLastCalledWith("thread-1", "acc-1", messages, { refresh: true }),
    );
    expect(takePreviewRequest("smart_replies")).toBe(true);
  });
});
