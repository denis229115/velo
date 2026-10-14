import { useEffect, useState } from "react";
import { getSetting, setSetting, getSecureSetting, setSecureSetting } from "@/services/db/settings";
import { PROVIDER_MODELS, type AiProvider } from "@/services/ai/types";
import { AI_APPROVAL_SETTING, APPROVED_PROVIDER, APPROVED_PROVIDER_LABEL } from "@/services/ai/gateway";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";
import { AiProviderApproval } from "./AiProviderApproval";

const KNOWN_PROVIDERS: readonly AiProvider[] = ["claude", "openai", "gemini", "ollama", "copilot"];

async function clearClients() {
  const { clearProviderClients } = await import("@/services/ai/providerManager");
  clearProviderClients();
}

/**
 * Settings → AI provider. Only the approved provider (the Claude API) is
 * offered and configurable. A provider selected before it was refused keeps
 * its stored settings untouched; the operator sees why it is refused and can
 * switch to Claude.
 */
export function AiProviderSettings() {
  const [loaded, setLoaded] = useState(false);
  const [provider, setProvider] = useState<AiProvider>(APPROVED_PROVIDER);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("claude-haiku-4-5-20251001");
  const [approved, setApproved] = useState(false);
  const [keySaved, setKeySaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<"success" | "fail" | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = await getSetting("ai_provider");
      const storedModel = await getSetting("claude_model");
      const storedKey = await getSecureSetting("claude_api_key");
      const storedApproval = await getSetting(AI_APPROVAL_SETTING);
      if (cancelled) return;
      if (stored && (KNOWN_PROVIDERS as readonly string[]).includes(stored)) setProvider(stored as AiProvider);
      if (storedModel) setModel(storedModel);
      setApiKey(storedKey ?? "");
      setApproved(storedApproval === APPROVED_PROVIDER);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!loaded) return null;

  if (provider !== APPROVED_PROVIDER) {
    return (
      <AiProviderApproval
        provider={provider}
        approved={false}
        onApprovedChange={() => {}}
        onSwitchToApproved={async () => {
          await setSetting("ai_provider", APPROVED_PROVIDER);
          await clearClients();
          setProvider(APPROVED_PROVIDER);
        }}
      />
    );
  }

  const testConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const { testConnection } = await import("@/services/ai/aiService");
      setTestResult((await testConnection()) ? "success" : "fail");
    } catch {
      setTestResult("fail");
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <div className="flex items-center justify-between">
        <span className="text-sm text-text-secondary">AI Provider</span>
        <span className="text-sm text-text-primary">{APPROVED_PROVIDER_LABEL}</span>
      </div>
      <p className="text-xs text-text-tertiary">
        Used for summarization, compose assistance and smart categorization. Uses{" "}
        {PROVIDER_MODELS.claude.find((m) => m.id === model)?.label ?? model}.
      </p>
      <AiProviderApproval
        provider={provider}
        approved={approved}
        onApprovedChange={async (value) => {
          setApproved(value);
          await setSetting(AI_APPROVAL_SETTING, value ? APPROVED_PROVIDER : "");
        }}
      />
      <TextField
        label="Anthropic API Key"
        size="md"
        type="password"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        placeholder="sk-ant-..."
      />
      <div className="flex items-center justify-between">
        <label htmlFor="ai-claude-model" className="text-sm text-text-secondary">Model</label>
        <select
          id="ai-claude-model"
          value={model}
          onChange={async (e) => {
            setModel(e.target.value);
            await setSetting("claude_model", e.target.value);
            await clearClients();
          }}
          className="w-48 bg-bg-tertiary text-text-primary text-sm px-3 py-1.5 rounded-md border border-border-primary focus:border-accent outline-none"
        >
          {PROVIDER_MODELS.claude.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="primary"
          size="md"
          onClick={async () => {
            await setSecureSetting("claude_api_key", apiKey.trim());
            await clearClients();
            setKeySaved(true);
            setTimeout(() => setKeySaved(false), 2000);
          }}
          disabled={!apiKey.trim()}
        >
          {keySaved ? "Saved!" : "Save Key"}
        </Button>
        <Button
          variant="secondary"
          size="md"
          onClick={testConnection}
          disabled={!apiKey.trim() || testing}
          className="bg-bg-tertiary text-text-primary border border-border-primary"
        >
          {testing ? "Testing..." : "Test Connection"}
        </Button>
        {testResult === "success" && <span className="text-xs text-success">Connected!</span>}
        {testResult === "fail" && <span className="text-xs text-danger">Connection failed</span>}
      </div>
    </>
  );
}
