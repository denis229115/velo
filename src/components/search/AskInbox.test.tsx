import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("@/services/ai/askInbox", () => ({ askMyInbox: vi.fn() }));
vi.mock("@/router/navigate", () => ({ navigateToLabel: vi.fn() }));

import { takePreviewRequest } from "@/services/ai/sendPreview";
import { AskInbox } from "./AskInbox";

describe("AskInbox", () => {
  it("names the provider and arms the send preview for the next question", () => {
    render(<AskInbox isOpen onClose={() => {}} />);

    expect(screen.getByText("Sends to Claude API (Anthropic)")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    expect(screen.getByText("The next request shows the preview first.")).toBeInTheDocument();
    expect(takePreviewRequest("ask_inbox")).toBe(true);
  });
});
