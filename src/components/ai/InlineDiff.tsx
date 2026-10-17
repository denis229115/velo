import type { ReactNode } from "react";

interface InlineDiffProps {
  before: string;
  after: string;
  summary: string;
  streaming: boolean;
  onAccept: () => void;
  onDiscard: () => void;
  onRetry: () => void;
  onRefine: () => void;
  onStop?: () => void;
  acceptLabel?: string;
}

/** The previous words stay put. Accept commits the insertion; Discard restores it. */
export function InlineDiff({
  before,
  after,
  summary,
  streaming,
  onAccept,
  onDiscard,
  onRetry,
  onRefine,
  onStop,
  acceptLabel = "Accept",
}: InlineDiffProps) {
  return (
    <div className="space-y-2">
      <p className="text-row text-text-primary leading-relaxed">
        {before && (
          <span className="line-through opacity-70" style={{ color: "var(--system-danger)" }}>
            {stripTags(before)}{" "}
          </span>
        )}
        <span className="underline decoration-[1.5px] underline-offset-2" style={{ background: "var(--system-success-soft)", textDecorationColor: "var(--system-success)" }}>
          {stripTags(after)}
        </span>
        {streaming && <StreamingCaret />}
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-meta text-text-tertiary flex-1 min-w-0">{summary}</span>
        {streaming ? (
          <DiffButton onClick={onStop}>Stop</DiffButton>
        ) : (
          <DiffButton onClick={onAccept} title="Accept (Cmd+Enter)" primary>
            {acceptLabel}
          </DiffButton>
        )}
        <DiffButton onClick={onDiscard}>Discard</DiffButton>
        {!streaming && <DiffButton onClick={onRetry}>Retry</DiffButton>}
        {!streaming && <DiffButton onClick={onRefine}>Refine</DiffButton>}
      </div>
    </div>
  );
}

function DiffButton({
  children,
  onClick,
  title,
  primary = false,
}: {
  children: ReactNode;
  onClick?: () => void;
  title?: string;
  primary?: boolean;
}) {
  const tone = primary
    ? "bg-accent text-white border border-transparent"
    : "border border-separator text-text-secondary hover:bg-state-hover";
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={!onClick}
      className={`px-2 py-0.5 text-meta rounded-[var(--radius-control-sm)] disabled:opacity-50 ${tone}`}
    >
      {children}
    </button>
  );
}

export function StreamingCaret() {
  return <span className="ai-caret ml-0.5" aria-hidden />;
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}
