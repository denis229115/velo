import { useSyncExternalStore } from "react";
import { peekUndo, subscribeUndo, undoLast } from "@/services/undoStack";

/** One toast for the latest reversible mail action. Z runs the same undo. */
export function UndoToast() {
  const action = useSyncExternalStore(subscribeUndo, peekUndo, () => null);
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
