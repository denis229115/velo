/**
 * One working aura at a time. A higher priority replaces a lower one.
 * Equal priority keeps the claim that started most recently.
 */

type Slot = { priority: number; seq: number };

const slots = new Map<number, Slot>();
const listeners = new Set<() => void>();
let nextId = 1;
let stamp = 0;
let owner = 0;

function pick(): void {
  let bestId = 0;
  let bestPriority = -1;
  let bestSeq = -1;
  for (const [id, slot] of slots) {
    if (slot.priority > bestPriority || (slot.priority === bestPriority && slot.seq > bestSeq)) {
      bestId = id;
      bestPriority = slot.priority;
      bestSeq = slot.seq;
    }
  }
  if (bestId === owner) return;
  owner = bestId;
  for (const listener of listeners) listener();
}

export function claimAura(priority: number): { id: number; owns: () => boolean; release: () => void } {
  const id = nextId++;
  slots.set(id, { priority, seq: ++stamp });
  pick();
  return {
    id,
    owns: () => owner === id,
    release() {
      if (!slots.delete(id)) return;
      pick();
    },
  };
}

export function subscribeAura(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test hook. */
export function resetAuraOwner(): void {
  slots.clear();
  owner = 0;
  stamp = 0;
  for (const listener of listeners) listener();
}
