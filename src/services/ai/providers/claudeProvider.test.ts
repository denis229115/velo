import { describe, it, expect, beforeEach, vi } from "vitest";

const mockCreate = vi.fn();

vi.mock("@anthropic-ai/sdk", () => {
  const MockAnthropic = vi.fn(function () {
    return { messages: { create: mockCreate } };
  });
  return { default: MockAnthropic };
});

import { createClaudeProvider, clearClaudeProvider } from "./claudeProvider";

describe("claudeProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearClaudeProvider();
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "Hello!" }] });
  });

  it("sends the system prompt and one user message, with no tool definitions", async () => {
    const provider = createClaudeProvider("sk-ant-fake", "claude-haiku-4-5-20251001");

    const result = await provider.complete({
      systemPrompt: "Summarize.",
      userContent: '<source_item id="1">\nHello\n</source_item>',
    });

    expect(result).toBe("Hello!");
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const params = mockCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(params).toEqual({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: "Summarize.",
      messages: [{ role: "user", content: '<source_item id="1">\nHello\n</source_item>' }],
    });
    expect(params).not.toHaveProperty("tools");
    expect(params).not.toHaveProperty("tool_choice");
  });

  it("returns only text, ignoring any non-text block", async () => {
    mockCreate.mockResolvedValue({
      content: [
        { type: "tool_use", id: "x", name: "send_email", input: {} },
        { type: "text", text: "Just text." },
      ],
    });
    const provider = createClaudeProvider("sk-ant-fake", "claude-haiku-4-5-20251001");

    expect(await provider.complete({ systemPrompt: "s", userContent: "u" })).toBe("Just text.");
  });
});
