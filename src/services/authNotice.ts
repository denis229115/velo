type Listener = () => void;

let accountId: string | null = null;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function reportAuthExpired(id: string): void {
  accountId = id;
  emit();
}

export function clearAuthExpired(): void {
  if (!accountId) return;
  accountId = null;
  emit();
}

export function getAuthExpired(): string | null {
  return accountId;
}

export function subscribeAuthExpired(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
