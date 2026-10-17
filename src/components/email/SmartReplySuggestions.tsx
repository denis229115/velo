import { useState, useCallback, useRef, useEffect } from "react";
import { RefreshCw } from "lucide-react";
import { isAiAvailable } from "@/services/ai/gateway";
import { generateSmartReplies } from "@/services/ai/aiService";
import { friendlyAiError } from "@/services/ai/friendlyError";
import { AiSendNote } from "@/components/ai/AiSendPreview";
import { AiCard, AiFailure, AiSkeleton } from "@/components/ai/AiCard";
import type { DbMessage } from "@/services/db/messages";

interface SmartReplySuggestionsProps {
  threadId: string;
  accountId: string;
  messages: DbMessage[];
  noReply?: boolean;
}

export function SmartReplySuggestions({ threadId, accountId, messages, noReply }: SmartReplySuggestionsProps) {
  const [replies, setReplies] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [available, setAvailable] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const checkedRef = useRef(false);
  const loadingRef = useRef(false);

  useEffect(() => {
    if (checkedRef.current) return;
    checkedRef.current = true;
    isAiAvailable().then(setAvailable);
  }, []);

  const loadReplies = useCallback(async (refresh = false) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setFailure(null);
    if (refresh) setReplies(null);
    try {
      const result = await generateSmartReplies(threadId, accountId, messages, refresh ? { refresh } : undefined);
      setReplies(result.slice(0, 3));
    } catch (err) {
      console.error("Failed to generate smart replies:", err);
      setFailure(friendlyAiError(err).message);
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [threadId, accountId, messages]);

  const handleRefresh = useCallback(() => loadReplies(true), [loadReplies]);

  const handleReplyClick = useCallback((replyText: string) => {
    // A chip fills the inline reply as a draft the operator still has to send.
    window.dispatchEvent(new CustomEvent("velo-insert-reply-draft", { detail: { text: replyText } }));
  }, []);

  if (!available || messages.length === 0 || noReply) return null;

  return (
    <div className="mx-4 my-2">
      <AiCard
        title="Replies"
        actions={
          replies ? (
            <button type="button" onClick={handleRefresh} className="p-0.5 text-text-tertiary hover:text-accent" title="Refresh suggestions">
              <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
            </button>
          ) : null
        }
      >
        {!replies && !loading && !failure && (
          <button type="button" onClick={() => loadReplies()} className="text-xs text-accent hover:underline">
            Generate replies
          </button>
        )}
        {loading && !replies && <AiSkeleton lines={1} />}
        {failure && !loading && <AiFailure message={failure} onRetry={() => loadReplies(true)} />}
        {replies && (
          <div className="flex flex-wrap gap-1.5">
            {replies.map((reply) => (
              <button
                key={reply}
                type="button"
                onClick={() => handleReplyClick(reply)}
                className="px-3 py-1 text-xs text-text-primary bg-surface-subtle border border-separator rounded-full hover:bg-state-hover max-w-[280px] truncate"
                title={reply}
              >
                {reply}
              </button>
            ))}
          </div>
        )}
        <div className="mt-2">
          <AiSendNote features={["smart_replies"]} onPreview={handleRefresh} />
        </div>
      </AiCard>
    </div>
  );
}
