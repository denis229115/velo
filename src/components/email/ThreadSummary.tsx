import { useState, useCallback, useRef, useEffect } from "react";
import { ChevronDown, ChevronUp, Copy, RefreshCw } from "lucide-react";
import { getAiReadiness, type AiReadiness } from "@/services/ai/gateway";
import { summarizeThreadStream } from "@/services/ai/aiService";
import { AiError } from "@/services/ai/errors";
import { useAiStream } from "@/components/ai/useAiStream";
import { AiSendNote } from "@/components/ai/AiSendPreview";
import { AiCard, AiFailure, AiSkeleton } from "@/components/ai/AiCard";
import { StreamingCaret } from "@/components/ai/InlineDiff";
import { AuraGlow, AuraShimmer } from "@/components/ui/AuraGlow";
import type { DbMessage } from "@/services/db/messages";

// The gateway refused or the operator cancelled: nothing left Velo, so say so
// rather than reporting a failure.
const NOT_SENT_CODES = new Set(["CANCELLED", "PREVIEW_REQUIRED", "SENSITIVE_DATA"]);

interface ThreadSummaryProps {
  threadId: string;
  accountId: string;
  messages: DbMessage[];
}

function bulletsOf(summary: string): string[] {
  const lines = summary
    .split(/\n+/)
    .map((line) => line.replace(/^[-*•]\s*/, "").trim())
    .filter(Boolean);
  const parts = lines.length >= 2 ? lines : summary.split(/(?<=[.!?])\s+/).map((line) => line.trim()).filter(Boolean);
  const bullets = (parts.length > 0 ? parts : [summary]).slice(0, 3);
  return bullets;
}

export function ThreadSummary({ threadId, accountId, messages }: ThreadSummaryProps) {
  const [summary, setSummary] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [readiness, setReadiness] = useState<AiReadiness | null>(null);
  const [failed, setFailed] = useState(false);
  const [notSent, setNotSent] = useState<string | null>(null);
  const checkedRef = useRef(false);
  const stream = useAiStream();

  useEffect(() => {
    if (checkedRef.current) return;
    checkedRef.current = true;
    if (messages.length < 2) return;
    getAiReadiness().then(setReadiness);
  }, [messages.length]);

  const loadSummary = useCallback(async (refresh = false) => {
    setFailed(false);
    setNotSent(null);
    if (refresh) setSummary("");
    try {
      const text = await stream.run(
        (signal) => summarizeThreadStream(threadId, accountId, messages, { refresh }, signal),
        (soFar) => setSummary(soFar),
      );
      if (text === null) return;
      setSummary(text);
    } catch (err) {
      console.error("Failed to summarize thread:", err);
      setSummary(null);
      setFailed(true);
      if (err instanceof AiError && NOT_SENT_CODES.has(err.code)) setNotSent(err.message);
    }
  }, [threadId, accountId, messages, stream.run]);

  const working = stream.phase === "working";

  const handleRefresh = useCallback(() => loadSummary(true), [loadSummary]);
  const copySummary = useCallback(() => {
    if (!summary) return;
    void navigator.clipboard?.writeText(summary).catch(() => {});
  }, [summary]);

  if (messages.length < 2 || !readiness || readiness.status === "off") return null;

  if (readiness.status === "refused" || readiness.status === "needs_approval") {
    return (
      <div className="mx-4 my-2 p-3 rounded-lg bg-bg-secondary border border-border-primary flex items-start gap-2">
        <p className="text-xs text-text-secondary">{readiness.message}</p>
      </div>
    );
  }

  const bullets = summary ? bulletsOf(summary) : [];

  const auraPhase = working ? "working" : failed ? "error" : stream.phase === "success" ? "success" : "idle";

  return (
    <AuraGlow
      palette="intelligence"
      phase={auraPhase}
      priority={30}
      shape="card"
      variant="plain"
      className="mx-4 my-2"
    >
      <AiCard
        title="Brief"
        footnote={summary ? "Claude · redacted" : undefined}
        actions={
          <>
            {summary && (
              <span
                role="button"
                tabIndex={0}
                onClick={handleRefresh}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleRefresh(); } }}
                className="p-0.5 text-text-tertiary hover:text-text-primary transition-colors cursor-pointer"
                title="Refresh summary"
              >
                <RefreshCw size={12} className={working ? "animate-spin" : ""} />
              </span>
            )}
            {summary && (
              <button type="button" title="Copy summary" onClick={copySummary} className="p-0.5 text-text-tertiary hover:text-text-primary">
                <Copy size={12} />
              </button>
            )}
            <button
              type="button"
              aria-expanded={!collapsed}
              aria-label={collapsed ? "Show brief" : "Hide brief"}
              onClick={() => setCollapsed((value) => !value)}
              className="p-0.5 text-text-tertiary hover:text-text-primary"
            >
              {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
            </button>
          </>
        }
      >
        {!collapsed && (
          <div className="text-sm text-text-secondary">
            {!summary && !working && (
              <button type="button" onClick={() => loadSummary()} className="text-xs text-text-secondary hover:text-text-primary">
                Summarize
              </button>
            )}
            {working && !summary && (
              <>
                <AuraShimmer>Summarising…</AuraShimmer>
                <AiSkeleton />
              </>
            )}
            {bullets.length > 0 && (
              <ul className="list-disc pl-4 space-y-1">
                {bullets.map((bullet) => (
                  <li key={bullet} className="text-xs leading-relaxed text-text-secondary">
                    {bullet}
                    {working && bullet === bullets[bullets.length - 1] && <StreamingCaret />}
                  </li>
                ))}
              </ul>
            )}
            {failed && !working && !summary && (
              <AiFailure message={notSent ?? "Summary unavailable right now."} onRetry={notSent ? undefined : () => loadSummary()} />
            )}
            <div className="mt-2">
              <AiSendNote features={["thread_summary"]} onPreview={handleRefresh} />
            </div>
          </div>
        )}
      </AiCard>
    </AuraGlow>
  );
}
