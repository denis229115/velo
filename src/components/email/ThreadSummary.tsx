import { useState, useCallback, useRef, useEffect } from "react";
import { Sparkles, ChevronDown, ChevronUp, RefreshCw } from "lucide-react";
import { getAiReadiness, type AiReadiness } from "@/services/ai/gateway";
import { summarizeThread } from "@/services/ai/aiService";
import { AiError } from "@/services/ai/errors";
import { AiSendNote } from "@/components/ai/AiSendPreview";
import type { DbMessage } from "@/services/db/messages";

// The gateway refused or the operator cancelled: nothing left Velo, so say so
// rather than reporting a failure.
const NOT_SENT_CODES = new Set(["CANCELLED", "PREVIEW_REQUIRED", "SENSITIVE_DATA"]);

interface ThreadSummaryProps {
  threadId: string;
  accountId: string;
  messages: DbMessage[];
}

export function ThreadSummary({ threadId, accountId, messages }: ThreadSummaryProps) {
  const [summary, setSummary] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [readiness, setReadiness] = useState<AiReadiness | null>(null);
  const [failed, setFailed] = useState(false);
  const [notSent, setNotSent] = useState<string | null>(null);
  const checkedRef = useRef(false);
  const available = readiness?.status === "ready";

  useEffect(() => {
    if (checkedRef.current) return;
    checkedRef.current = true;
    if (messages.length < 2) return;
    getAiReadiness().then(setReadiness);
  }, [messages.length]);

  const loadingRef = useRef(false);
  const loadSummary = useCallback(async (refresh = false) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setFailed(false);
    setNotSent(null);
    if (refresh) setSummary(null);
    try {
      const result = await summarizeThread(threadId, accountId, messages, { refresh });
      setSummary(result);
    } catch (err) {
      console.error("Failed to summarize thread:", err);
      setSummary(null);
      setFailed(true);
      if (err instanceof AiError && NOT_SENT_CODES.has(err.code)) setNotSent(err.message);
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [threadId, accountId, messages]);

  // Auto-load summary when available
  useEffect(() => {
    if (!available || messages.length < 2 || summary !== null || failed || loadingRef.current) return;
    loadSummary();
  }, [available, messages.length, summary, failed, loadSummary]);

  const handleRefresh = useCallback(() => loadSummary(true), [loadSummary]);

  if (messages.length < 2 || !readiness || readiness.status === "off") return null;

  // AI is configured but may not receive email content: say why, send nothing.
  if (readiness.status === "refused" || readiness.status === "needs_approval") {
    return (
      <div className="mx-4 my-2 p-3 rounded-lg bg-bg-secondary border border-border-primary flex items-start gap-2">
        <Sparkles size={14} className="text-text-tertiary shrink-0 mt-0.5" />
        <p className="text-xs text-text-secondary">{readiness.message}</p>
      </div>
    );
  }

  return (
    <div className="mx-4 my-2 p-3 rounded-lg bg-accent/5 border border-accent/20">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="flex items-center gap-2 w-full text-left"
      >
        <Sparkles size={14} className="text-accent shrink-0" />
        <span className="text-xs font-medium text-accent flex-1">AI Summary</span>
        {summary && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); handleRefresh(); }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); handleRefresh(); } }}
            className="p-0.5 text-text-tertiary hover:text-accent transition-colors cursor-pointer"
            title="Refresh summary"
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          </span>
        )}
        {collapsed ? <ChevronDown size={14} className="text-text-tertiary" /> : <ChevronUp size={14} className="text-text-tertiary" />}
      </button>
      {!collapsed && (
        <div className="mt-2 text-sm text-text-secondary">
          {loading && !summary && (
            <div className="flex items-center gap-2 text-text-tertiary">
              <div className="w-3 h-3 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
              <span className="text-xs">Generating summary...</span>
            </div>
          )}
          {summary && <p className="text-xs leading-relaxed">{summary}</p>}
          {failed && !loading && !summary && (
            <p className="text-xs text-text-tertiary">{notSent ?? "Summary unavailable right now."}</p>
          )}
          <div className="mt-2">
            <AiSendNote features={["thread_summary"]} onPreview={handleRefresh} />
          </div>
        </div>
      )}
    </div>
  );
}
