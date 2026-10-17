export interface UndoAction {
  label: string;
  undo: () => void;
}

type Listener = () => void;

let current: UndoAction | null = null;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener();
  window.dispatchEvent(new CustomEvent("velo-undo-changed"));
}

export function offerUndo(action: UndoAction): void {
  current = action;
  emit();
}

export function peekUndo(): UndoAction | null {
  return current;
}

export function clearUndo(): void {
  if (!current) return;
  current = null;
  emit();
}

/** Runs the offered undo once. Returns false when there is nothing to undo. */
export function undoLast(): boolean {
  const action = current;
  if (!action) return false;
  current = null;
  emit();
  action.undo();
  return true;
}

export function subscribeUndo(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
