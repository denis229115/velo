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
 * The shared assistant surface: a neutral material card, a monochrome sparkle,
 * and the same header and footer on every card. Accent is reserved for Accept.
 */
export function AiCard({ title, footnote, actions, children }: AiCardProps) {
  return (
    <section className="material-pop rounded-[var(--radius-panel)] border border-separator px-3 py-2">
      <header className="flex items-center gap-2">
        <Sparkles size={14} className="shrink-0 text-text-secondary" aria-hidden />
        <h3 className="text-preview font-medium text-text-primary flex-1 min-w-0 truncate">{title}</h3>
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
          className="h-2.5 rounded-full bg-text-tertiary/20 animate-pulse"
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
        <button type="button" onClick={onRetry} className="text-preview text-text-secondary hover:text-text-primary shrink-0">
          Retry
        </button>
      )}
    </div>
  );
}
