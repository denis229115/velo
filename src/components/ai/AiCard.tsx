import type { ReactNode } from "react";
import { Sparkles } from "lucide-react";

interface AiCardProps {
  title: string;
  /** Tertiary source line, such as "Claude · redacted". */
  footnote?: string;
  actions?: ReactNode;
  children: ReactNode;
}

/**
 * The shared assistant surface: a quiet accent tint, a sparkle, and the same
 * header and footer on every card.
 */
export function AiCard({ title, footnote, actions, children }: AiCardProps) {
  return (
    <section
      className="rounded-[var(--radius-panel)] border border-separator px-3 py-2"
      style={{ background: "color-mix(in srgb, var(--system-ai) 9%, var(--surface-reader))" }}
    >
      <header className="flex items-center gap-2">
        <Sparkles size={14} className="shrink-0 text-accent" aria-hidden />
        <h3 className="text-preview font-medium text-accent flex-1 min-w-0 truncate">{title}</h3>
        {actions && <div className="flex items-center gap-1 shrink-0">{actions}</div>}
      </header>
      <div className="mt-2">{children}</div>
      {footnote && <p className="mt-2 text-meta text-text-tertiary">{footnote}</p>}
    </section>
  );
}

export function AiSkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="space-y-1.5" aria-hidden>
      {Array.from({ length: lines }, (_, index) => (
        <div
          key={index}
          className="h-2.5 rounded-full bg-accent/15 animate-pulse"
          style={{ width: index === lines - 1 ? "55%" : "100%" }}
        />
      ))}
    </div>
  );
}

export function AiFailure({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex items-center gap-2">
      <p className="text-preview text-text-secondary flex-1">{message}</p>
      {onRetry && (
        <button type="button" onClick={onRetry} className="text-preview text-accent hover:underline shrink-0">
          Retry
        </button>
      )}
    </div>
  );
}
