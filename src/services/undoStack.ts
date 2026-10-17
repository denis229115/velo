export interface UndoAction {
  label: string;
  undo: () => void | Promise<void>;
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

export function clearUndo(expected?: UndoAction): void {
  if (!current || (expected && current !== expected)) return;
  current = null;
  emit();
}

/** Runs the offered undo once. Returns false when there is nothing to undo. */
export function undoLast(): boolean {
  const action = current;
  if (!action) return false;
  current = null;
  emit();
  const failed = (error: unknown) => window.dispatchEvent(new CustomEvent("velo-undo-error", { detail: `Undo failed: ${String(error)}` }));
  try { void Promise.resolve(action.undo()).catch(failed); }
  catch (error) { failed(error); }
  return true;
}

export function subscribeUndo(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
