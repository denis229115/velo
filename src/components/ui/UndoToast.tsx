import { useEffect, useState, useSyncExternalStore } from "react";
import { peekUndo, subscribeUndo, undoLast } from "@/services/undoStack";

/** One toast for the latest reversible mail action. Z runs the same undo. */
export function UndoToast() {
  const action = useSyncExternalStore(subscribeUndo, peekUndo, () => null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const failed = (event: Event) => setError((event as CustomEvent<string>).detail);
    window.addEventListener("velo-undo-error", failed);
    window.addEventListener("velo-mail-action-error", failed);
    return () => {
      window.removeEventListener("velo-undo-error", failed);
      window.removeEventListener("velo-mail-action-error", failed);
    };
  }, []);
  if (error) {
    return (
      <div
        role="alert"
        className="material-pop fixed bottom-12 left-1/2 z-[60] flex max-w-[min(32rem,90vw)] -translate-x-1/2 items-center gap-3 rounded-2xl px-4 py-2 text-row text-status-error"
      >
        <span>{error}</span>
        <button type="button" onClick={() => setError(null)} className="shrink-0 font-medium text-text-primary">
          Dismiss
        </button>
      </div>
    );
  }
  if (!action) return null;
  return (
    <div
      role="status"
      className="material-pop fixed bottom-12 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-3 rounded-full px-3 py-1.5 text-row text-text-primary"
    >
      <span>{action.label}</span>
      <button type="button" onClick={() => undoLast()} className="font-medium text-accent">
        Undo
        <kbd className="ml-1 text-meta text-text-tertiary">Z</kbd>
      </button>
    </div>
  );
}
