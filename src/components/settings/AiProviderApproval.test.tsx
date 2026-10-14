import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AiProviderApproval } from "./AiProviderApproval";

describe("AiProviderApproval", () => {
  it.each([
    ["openai", "OpenAI"],
    ["gemini", "Google Gemini"],
    ["ollama", "Ollama"],
    ["copilot", "GitHub Copilot"],
  ] as const)("explains that %s is refused for email content", (provider, label) => {
    render(<AiProviderApproval provider={provider} approved onApprovedChange={vi.fn()} />);

    expect(screen.getByRole("alert")).toHaveTextContent(`${label} is not approved`);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("asks the operator to approve the Claude API, which keeps AI off until ticked", () => {
    const onApprovedChange = vi.fn();
    render(<AiProviderApproval provider="claude" approved={false} onApprovedChange={onApprovedChange} />);

    const box = screen.getByRole("checkbox", { name: /approve the Claude API \(Anthropic\)/i });
    expect(box).not.toBeChecked();
    expect(screen.getByText(/AI stays off until you approve/i)).toBeInTheDocument();

    fireEvent.click(box);
    expect(onApprovedChange).toHaveBeenCalledWith(true);
  });

  it("shows an approved Claude API as ticked", () => {
    render(<AiProviderApproval provider="claude" approved onApprovedChange={vi.fn()} />);

    expect(screen.getByRole("checkbox")).toBeChecked();
  });
});
