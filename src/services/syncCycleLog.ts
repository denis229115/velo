import { invoke } from "@tauri-apps/api/core";

export interface SyncCycleSummary {
  accountId: string;
  provider: string;
  /** "delta", "initial" or "calendar" */
  kind: string;
  durationMs: number;
  /** IMAP delta cycles only */
  foldersChecked?: number;
  messagesFetched?: number;
  errors: string[];
}

const MAX_ERROR_LENGTH = 200;

/** One line per sync cycle per account: what ran, how much it did, how long, what failed. */
export function formatSyncCycleLine(s: SyncCycleSummary): string {
  const parts = [
    `[sync] account=${s.accountId}`,
    `provider=${s.provider}`,
    `kind=${s.kind}`,
  ];
  if (s.foldersChecked !== undefined) parts.push(`folders_checked=${s.foldersChecked}`);
  if (s.messagesFetched !== undefined) parts.push(`messages_fetched=${s.messagesFetched}`);
  parts.push(`duration_ms=${s.durationMs}`, `errors=${s.errors.length}`);
  let line = parts.join(" ");
  const first = s.errors[0];
  if (first) {
    line += ` first_error="${first.replace(/\s+/g, " ").slice(0, MAX_ERROR_LENGTH)}"`;
  }
  return line;
}

/** Write the cycle line to the app log (Rust `log` at info level, which lands in the log file). */
export function logSyncCycle(summary: SyncCycleSummary): void {
  const line = formatSyncCycleLine(summary);
  console.log(line);
  try {
    void Promise.resolve(invoke("log_sync_cycle", { line })).catch(() => {});
  } catch {
    // logging must never break a sync
  }
}
