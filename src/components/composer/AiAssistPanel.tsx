import { useCallback, useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { Sparkles } from "lucide-react";
import { getAiReadiness, type AiReadiness } from "@/services/ai/gateway";
import {
  composeFromPrompt,
  generateReply,
  transformText,
  type TransformType,
} from "@/services/ai/aiService";
import { friendlyAiError } from "@/services/ai/friendlyError";
import { completeText, readTextStream, type TextStream } from "@/services/ai/textStream";
import { useComposerStore } from "@/stores/composerStore";
import { AiSendNote } from "@/components/ai/AiSendPreview";
import { AiFailure } from "@/components/ai/AiCard";
import { InlineDiff, StreamingCaret } from "@/components/ai/InlineDiff";
import { Menu } from "@/components/ui/Menu";
import { claimComposerEnter } from "@/components/ai/composerEnter";

interface AiAssistPanelProps {
  editor: Editor | null;
  isReplyMode: boolean;
  threadMessages?: string[];
}

interface PendingDiff {
  before: string;
  after: string;
  summary: string;
  streaming: boolean;
  retry: () => void;
}

const TONES: Array<{ id: string; label: string; type: TransformType | "warm" | "neutral" }> = [
  { id: "rewrite", label: "Rewrite", type: "improve" },
  { id: "shorten", label: "Shorten", type: "shorten" },
  { id: "concise", label: "Concise", type: "shorten" },
  { id: "warm", label: "Warm", type: "warm" },
  { id: "neutral", label: "Neutral", type: "neutral" },
  { id: "formal", label: "Formal", type: "formalize" },
];

export function AiAssistPanel({ editor, isReplyMode, threadMessages }: AiAssistPanelProps) {
  const [prompt, setPrompt] = useState("");
  const [open, setOpen] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canRetry, setCanRetry] = useState(false);
  const [readiness, setReadiness] = useState<AiReadiness | null>(null);
  const [diff, setDiff] = useState<PendingDiff | null>(null);
  const [menu, setMenu] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const streamRef = useRef<TextStream | null>(null);
  const setBodyHtml = useComposerStore((s) => s.setBodyHtml);
  const lastRun = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    getAiReadiness().then(setReadiness);
  }, []);

  const applyToEditor = useCallback((html: string) => {
    if (!editor) return;
    const content = html.trim().startsWith("<") ? html : `<p>${escapeHtml(html)}</p>`;
    editor.chain().focus().setContent(content).run();
    setBodyHtml(editor.getHTML());
  }, [editor, setBodyHtml]);

  const accept = useCallback(() => {
    if (!diff || diff.streaming) return;
    applyToEditor(diff.after);
    setDiff(null);
    setPrompt("");
  }, [diff, applyToEditor]);

  const discard = useCallback(() => {
    streamRef.current?.abort();
    streamRef.current = null;
    setDiff(null);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!diff || diff.streaming) return;
    return claimComposerEnter(accept);
  }, [diff, accept]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "j") {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!readiness || readiness.status === "off") return null;

  if (readiness.status === "refused" || readiness.status === "needs_approval") {
    return (
      <div className="px-3 py-2 border-b border-border-secondary bg-bg-secondary flex items-start gap-2">
        <Sparkles size={12} className="text-text-tertiary shrink-0 mt-0.5" />
        <p className="text-xs text-text-secondary">{readiness.message}</p>
      </div>
    );
  }

  const runStream = async (instruction: string, produce: () => Promise<string>) => {
    if (!editor || loading) return;
    const before = editor.getHTML();
    setLoading(true);
    setError(null);
    setCanRetry(false);
    setDiff({ before, after: "", summary: instruction, streaming: true, retry: () => { void lastRun.current?.(); } });
    const stream = completeText("");
    streamRef.current = stream;
    try {
      const result = await produce();
      streamRef.current = completeText(result);
      const after = await readTextStream(streamRef.current, (soFar) => {
        setDiff((current) => current && { ...current, after: soFar });
      });
      setDiff((current) => current && { ...current, after, streaming: false, summary: instruction });
    } catch (err) {
      const friendly = friendlyAiError(err);
      setError(friendly.message);
      setCanRetry(friendly.retry);
      setDiff(null);
    } finally {
      streamRef.current = null;
      setLoading(false);
    }
  };

  const handleCompose = async () => {
    const instruction = prompt.trim();
    if (!instruction) return;
    const run = () => runStream(instruction, () => (isReplyMode ? generateReply(threadMessages ?? [], instruction) : composeFromPrompt(instruction)));
    lastRun.current = run;
    await run();
  };

  const handleTransform = async (label: string, type: TransformType) => {
    if (!editor) return;
    const html = editor.getHTML();
    if (!html || html === "<p></p>") return;
    const run = () => runStream(`${label}`, () => transformText(html, type));
    lastRun.current = run;
    await run();
  };

  const toneType = (tone: (typeof TONES)[number]): TransformType => {
    if (tone.type === "warm" || tone.type === "neutral") return "improve";
    return tone.type;
  };

  return (
    <div className="px-3 py-2 border-b border-border-secondary">
      <div className="flex items-center gap-2 mb-2">
        <button
          ref={anchorRef}
          type="button"
          className="inline-flex items-center gap-1 text-xs text-accent"
          onClick={() => setOpen((value) => !value)}
        >
          <Sparkles size={12} />
          Write with AI
        </button>
        <div className="ml-auto">
          <AiSendNote features={["ai_compose", "ai_reply", "text_transform"]} />
        </div>
      </div>

      {open && (
        <div className="material-pop rounded-full px-3 py-1.5 flex items-center gap-2">
          <Sparkles size={12} className="text-accent shrink-0" aria-hidden />
          <input
            type="text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setOpen(false);
              } else if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void handleCompose();
              } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
                e.preventDefault();
                void handleCompose();
              }
            }}
            placeholder={isReplyMode ? "Instructions for reply (optional)..." : "Describe what to write..."}
            className="flex-1 bg-transparent text-xs text-text-primary outline-none placeholder:text-text-tertiary"
            disabled={loading}
          />
          {loading && <StreamingCaret />}
          <button
            type="button"
            onClick={() => void handleCompose()}
            disabled={loading || (!isReplyMode && !prompt.trim())}
            className="px-2 py-0.5 text-xs text-white bg-accent rounded-full disabled:opacity-50"
          >
            {loading ? "..." : isReplyMode ? "Generate Reply" : "Generate"}
          </button>
        </div>
      )}

      {editor && (
        <div className="mt-1">
          <button type="button" className="text-meta text-text-tertiary hover:text-text-primary" onClick={() => setMenu(true)}>
            Selection
          </button>
          <Menu
            open={menu}
            onClose={() => setMenu(false)}
            label="Rewrite selection"
            anchorRef={anchorRef}
            items={TONES.map((tone) => ({
              id: tone.id,
              label: tone.label,
              onSelect: () => void handleTransform(tone.label, toneType(tone)),
            }))}
          />
        </div>
      )}

      {diff && (
        <div className="mt-2" data-ai-diff>
          <InlineDiff
            before={diff.before}
            after={diff.after}
            summary={diff.streaming ? prompt || diff.summary : diff.summary}
            streaming={diff.streaming}
            onAccept={accept}
            onDiscard={discard}
            onRetry={() => void diff.retry()}
            onRefine={() => {
              setOpen(true);
              setDiff(null);
            }}
            onStop={discard}
          />
        </div>
      )}

      {error && (
        <div className="mt-1">
          <AiFailure message={error} onRetry={canRetry ? () => void lastRun.current?.() : undefined} />
        </div>
      )}
    </div>
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char] ?? char));
}
