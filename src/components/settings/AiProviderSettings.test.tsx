import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// In-memory settings table (fake data only).
const settings = new Map<string, string>();
const setSetting = vi.fn(async (key: string, value: string) => {
  settings.set(key, value);
});
vi.mock("@/services/db/settings", () => ({
  getSetting: vi.fn(async (key: string) => settings.get(key) ?? null),
  getSecureSetting: vi.fn(async (key: string) => settings.get(key) ?? null),
  setSetting: (key: string, value: string) => setSetting(key, value),
  setSecureSetting: (key: string, value: string) => setSetting(key, value),
}));
vi.mock("@/services/ai/providerManager", () => ({ clearProviderClients: vi.fn() }));

import { AiProviderSettings } from "./AiProviderSettings";

const OTHER_PROVIDER_SETTINGS: [string, string][] = [
  ["openai_api_key", "sk-fake-openai"],
  ["openai_model", "gpt-4o-mini"],
  ["gemini_api_key", "AI-fake-gemini"],
  ["ollama_server_url", "http://localhost:11434"],
  ["copilot_api_key", "ghp_fake"],
];

beforeEach(() => {
  settings.clear();
  setSetting.mockClear();
});

describe("AiProviderSettings", () => {
  it("offers only the approved Claude API as provider", async () => {
    settings.set("ai_provider", "claude");

    render(<AiProviderSettings />);

    expect(await screen.findByLabelText("Anthropic API Key")).toBeInTheDocument();
    expect(screen.getByText("Claude API (Anthropic)")).toBeInTheDocument();
    for (const other of [/OpenAI/, /Gemini/, /Ollama/, /Copilot/]) {
      expect(screen.queryByText(other)).not.toBeInTheDocument();
    }
    expect(screen.getByRole("checkbox", { name: /approve the Claude API/i })).toBeInTheDocument();
  });

  it("treats a fresh install as Claude", async () => {
    render(<AiProviderSettings />);

    expect(await screen.findByLabelText("Anthropic API Key")).toBeInTheDocument();
  });

  it.each([
    ["openai", "OpenAI"],
    ["gemini", "Google Gemini"],
    ["ollama", "Ollama"],
    ["copilot", "GitHub Copilot"],
  ])("explains a stored %s selection and offers to switch to Claude, touching nothing", async (provider, label) => {
    settings.set("ai_provider", provider);
    for (const [k, v] of OTHER_PROVIDER_SETTINGS) settings.set(k, v);

    render(<AiProviderSettings />);

    expect(await screen.findByRole("alert")).toHaveTextContent(`${label} is not approved`);
    expect(screen.queryByLabelText(/API Key|Access Token|Server URL/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(setSetting).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /switch to claude/i }));

    expect(await screen.findByLabelText("Anthropic API Key")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(setSetting.mock.calls).toEqual([["ai_provider", "claude"]]);
    for (const [k, v] of OTHER_PROVIDER_SETTINGS) expect(settings.get(k)).toBe(v);
  });

  it("saves the Claude API key and approval", async () => {
    render(<AiProviderSettings />);

    fireEvent.change(await screen.findByLabelText("Anthropic API Key"), {
      target: { value: "sk-ant-fake-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save key/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /approve the Claude API/i }));

    await waitFor(() => {
      expect(settings.get("claude_api_key")).toBe("sk-ant-fake-key");
      expect(settings.get("ai_approved_provider")).toBe("claude");
    });
  });
});
