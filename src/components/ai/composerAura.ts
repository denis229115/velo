import { useSyncExternalStore } from "react";

export type ComposerAuraPhase = "idle" | "working" | "success" | "error";

let phase: ComposerAuraPhase = "idle";
const listeners = new Set<() => void>();

/** The composer body follows the assist stream without a second glow of its own. */
export function reportComposerAura(next: ComposerAuraPhase): void {
  if (phase === next) return;
  phase = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useComposerAura(): ComposerAuraPhase {
  return useSyncExternalStore(subscribe, () => phase, () => "idle");
}
