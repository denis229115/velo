type Listener = () => void;

let notice: string | null = null;
const listeners = new Set<Listener>();

/** The latest mail-sync line from App, shared with the sidebar pill. */
export function reportSyncNotice(next: string | null): void {
  notice = next;
  for (const listener of listeners) listener();
}

export function getSyncNotice(): string | null {
  return notice;
}

export function subscribeSyncNotice(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
