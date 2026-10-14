import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { SendPreview, SendPreviewHandler } from "@/services/ai/sendPreview";

let registered: SendPreviewHandler | null = null;
const previewNextRequest = vi.fn();
vi.mock("@/services/ai/sendPreview", () => ({
  APPROVED_PROVIDER_LABEL: "Claude API (Anthropic)",
  setSendPreviewHandler: (handler: SendPreviewHandler | null) => {
    registered = handler;
  },
  previewNextRequest: (features: string[]) => previewNextRequest(features),
}));

import { AiSendPreviewHost, AiSendNote } from "./AiSendPreview";

const preview: SendPreview = {
  feature: "ai_reply",
  reason: "new_data_kind",
  providerLabel: "Claude API (Anthropic)",
  model: "claude-haiku-4-5-20251001",
  systemPrompt: "You draft replies.",
  userContent: '<source_item id="1">\nPlease call [PHONE_1] about [CARD_1]\n</source_item>',
  newKinds: ["card"],
  flagCounts: { secret: 1, payment: 1, contact: 1 },
};

async function open(p: SendPreview = preview): Promise<{ answer: Promise<boolean> }> {
  let answer!: Promise<boolean>;
  await act(async () => {
    answer = registered!(p);
  });
  return { answer };
}

describe("Send preview", () => {
  beforeEach(() => {
    registered = null;
    previewNextRequest.mockClear();
  });

  it("shows exactly what will be sent, to which provider, and why", async () => {
    render(<AiSendPreviewHost />);

    await open();

    expect(screen.getByText(/Claude API \(Anthropic\)/, { selector: "p" })).toBeInTheDocument();
    expect(screen.getByText(/claude-haiku-4-5-20251001/)).toBeInTheDocument();
    expect(screen.getByText("You draft replies.")).toBeInTheDocument();
    expect(screen.getByText(/Please call \[PHONE_1\] about \[CARD_1\]/)).toBeInTheDocument();
    expect(screen.getByText(/card number/i)).toBeInTheDocument();
    expect(screen.getByText(/1 secret removed/i)).toBeInTheDocument();
  });

  it("sends only when the operator confirms", async () => {
    render(<AiSendPreviewHost />);
    const { answer } = await open();

    fireEvent.click(screen.getByRole("button", { name: "Send to Claude API (Anthropic)" }));

    await expect(answer).resolves.toBe(true);
  });

  it("can be cancelled without sending", async () => {
    render(<AiSendPreviewHost />);
    const { answer } = await open();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await expect(answer).resolves.toBe(false);
  });

  it("stops accepting previews when it closes, so requests fail closed", () => {
    const { unmount } = render(<AiSendPreviewHost />);
    expect(registered).not.toBeNull();

    unmount();

    expect(registered).toBeNull();
  });
});

describe("Provider note at the point of sending", () => {
  it("names the provider and offers the preview in one click", () => {
    const onPreview = vi.fn();
    render(<AiSendNote features={["ai_reply"]} onPreview={onPreview} />);

    expect(screen.getByText("Sends to Claude API (Anthropic)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    expect(previewNextRequest).toHaveBeenCalledWith(["ai_reply"]);
    expect(onPreview).toHaveBeenCalled();
  });
});
