import { useCallback, useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { Sparkles } from "lucide-react";
import { getAiReadiness, type AiReadiness } from "@/services/ai/gateway";
import {
  composeFromPromptStream,
  generateReplyStream,
  transformTextStream,
  type TransformType,
} from "@/services/ai/aiService";
import { friendlyAiError } from "@/services/ai/friendlyError";
import { useComposerStore } from "@/stores/composerStore";
import { AiSendNote } from "@/components/ai/AiSendPreview";
import { AiFailure } from "@/components/ai/AiCard";
import { InlineDiff } from "@/components/ai/InlineDiff";
import { reportComposerAura } from "@/components/ai/composerAura";
import { useAiStream } from "@/components/ai/useAiStream";
import { Menu } from "@/components/ui/Menu";
import { escapeHtml } from "@/utils/sanitize";
import { captureRewriteTarget } from "./rewriteTarget";
import { AuraGlow, AuraShimmer } from "@/components/ui/AuraGlow";
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

const TONES: Array<{ id: string; label: string; type: TransformType }> = [
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
  const [error, setError] = useState<string | null>(null);
  const [canRetry, setCanRetry] = useState(false);
  const [readiness, setReadiness] = useState<AiReadiness | null>(null);
  const [diff, setDiff] = useState<PendingDiff | null>(null);
  const [menu, setMenu] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const busy = useRef(false);
  // Each run gets a number so a stopped run that settles late cannot clear a newer run's state.
  const runCounter = useRef(0);
  const setBodyHtml = useComposerStore((s) => s.setBodyHtml);
  const targetRef = useRef<ReturnType<typeof captureRewriteTarget> | null>(null);
  const selectionRef = useRef<ReturnType<typeof captureRewriteTarget> | null>(null);
  const lastRun = useRef<(() => Promise<void>) | null>(null);
  const ai = useAiStream();
  const writing = Boolean(diff?.streaming && diff.after);

  useEffect(() => {
    reportComposerAura(writing ? "working" : ai.phase === "success" ? "success" : "idle");
  }, [writing, ai.phase]);

  useEffect(() => () => reportComposerAura("idle"), []);

  useEffect(() => () => {
    ai.stop();
    targetRef.current?.dispose();
    selectionRef.current?.dispose();
  }, [editor]);

  useEffect(() => {
    getAiReadiness().then(setReadiness);
  }, []);

  const accept = useCallback(() => {
    if (!editor || !diff || diff.streaming) return;
    const range = targetRef.current?.range();
    if (!range) {
      setError("The original text changed. Discard this proposal and select the text again.");
      return;
    }
    const content = diff.after.trim().startsWith("<") ? diff.after : escapeHtml(diff.after);
    targetRef.current?.dispose();
    targetRef.current = null;
    editor.chain().focus().insertContentAt(range, content).run();
    setBodyHtml(editor.getHTML());
    setDiff(null);
    setPrompt("");
  }, [diff, editor, setBodyHtml]);

  const discard = useCallback(() => {
    ai.stop();
    busy.current = false;
    targetRef.current?.dispose();
    targetRef.current = null;
    setDiff(null);
  }, [ai]);

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

  const runStream = async (instruction: string, produce: (signal: AbortSignal) => AsyncIterable<string>, captured?: ReturnType<typeof captureRewriteTarget>) => {
    if (!editor || busy.current) return;
    const target = captured ?? captureRewriteTarget(editor, false);
    if (targetRef.current !== target) targetRef.current?.dispose();
    targetRef.current = target;
    const before = target.before;
    busy.current = true;
    const runId = ++runCounter.current;
    const current = () => runId === runCounter.current;
    setError(null);
    setCanRetry(false);
    setDiff({ before, after: "", summary: instruction, streaming: true, retry: () => { void lastRun.current?.(); } });
    try {
      const after = await ai.run(produce, (soFar) => {
        setDiff((current) => current && { ...current, after: soFar });
      });
      if (after === null) {
        if (current()) setDiff(null);
        return;
      }
      if (!current()) return;
      setDiff((current) => current && { ...current, after, streaming: false, summary: instruction });
    } catch (err) {
      if (!current()) return;
      const friendly = friendlyAiError(err);
      setError(friendly.message);
      setCanRetry(friendly.retry);
      setDiff(null);
    } finally {
      if (current()) busy.current = false;
    }
  };

  const working = ai.phase === "working";
  const barPhase = ai.phase === "error" ? "error" : working && !writing ? "working" : "idle";

  const handleCompose = async () => {
    const instruction = prompt.trim();
    if (!instruction) return;
    const run = () => runStream(instruction, (signal) => (
      isReplyMode ? generateReplyStream(threadMessages ?? [], instruction, signal) : composeFromPromptStream(instruction, signal)
    ));
    lastRun.current = run;
    await run();
  };

  const handleTransform = async (label: string, type: TransformType) => {
    if (!editor) return;
    const target = selectionRef.current;
    if (!target || !target.range()) {
      setError("Select the text to rewrite again; the original selection changed.");
      return;
    }
    const html = target.before;
    const run = () => runStream(`${label}`, (signal) => transformTextStream(html, type, signal), target);
    lastRun.current = run;
    await run();
  };

  return (
    <div className="px-3 py-2 border-b border-border-secondary">
      <div className="flex items-center gap-2 mb-2">
        <button
          ref={anchorRef}
          type="button"
          className="inline-flex items-center gap-1 text-xs text-text-secondary"
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
        <AuraGlow
          palette="halo"
          shape="pill"
          variant="field"
          priority={10}
          phase={barPhase}
          fieldClassName="px-3 py-1.5 flex items-center gap-2"
        >
          <Sparkles size={12} className="text-text-secondary shrink-0" aria-hidden />
          <span className="relative flex-1 min-w-0">
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
              className={`w-full bg-transparent text-xs outline-none placeholder:text-text-tertiary ${barPhase === "working" ? "text-transparent placeholder:text-transparent" : "text-text-primary"}`}
              disabled={working}
            />
            {barPhase === "working" && (
              <span className="pointer-events-none absolute inset-0 flex items-center">
                <AuraShimmer>{prompt.trim() || "Writing…"}</AuraShimmer>
              </span>
            )}
          </span>
          <button
            type="button"
            onClick={() => void handleCompose()}
            disabled={working || (!isReplyMode && !prompt.trim())}
            className="px-2 py-0.5 text-xs text-text-secondary border border-separator rounded-full disabled:opacity-50"
          >
            {working ? "..." : isReplyMode ? "Generate Reply" : "Generate"}
          </button>
        </AuraGlow>
      )}

      {editor && (
        <div className="mt-1">
          <button type="button" disabled={working} className="text-meta text-text-tertiary hover:text-text-primary disabled:opacity-50" onMouseDown={(event) => event.preventDefault()} onClick={() => {
            if (!editor || editor.state.selection.empty) { setError("Select text to rewrite first."); return; }
            discard();
            selectionRef.current?.dispose();
            selectionRef.current = captureRewriteTarget(editor, true);
            setMenu(true);
          }}>
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
              onSelect: () => void handleTransform(tone.label, tone.type),
            }))}
          />
        </div>
      )}

      {diff && (
        <AuraGlow
          palette="intelligence"
          shape="card"
          variant="plain"
          priority={30}
          phase={writing ? "working" : "idle"}
          className="mt-2"
        >
          <div data-ai-diff>
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
                discard();
              }}
              onStop={discard}
            />
          </div>
        </AuraGlow>
      )}

      {error && (
        <div className="mt-1">
          <AiFailure message={error} onRetry={canRetry ? () => void lastRun.current?.() : undefined} />
        </div>
      )}
    </div>
  );
}
