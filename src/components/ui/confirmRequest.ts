export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}

type Host = (request: ConfirmRequest) => void;

let host: Host | null = null;

export function bindConfirmHost(next: Host | null): void {
  host = next;
}

/**
 * Asks the mounted confirm sheet. Resolves false when no sheet is mounted,
 * so a destructive action never proceeds without an answer.
 */
export function requestConfirm(options: Omit<ConfirmRequest, "resolve">): Promise<boolean> {
  return new Promise((resolve) => {
    if (!host) {
      resolve(false);
      return;
    }
    host({ ...options, resolve });
  });
}
