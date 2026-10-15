/**
 * When a ticket's AI summary refreshes by itself. One refresher serves the
 * summary of the ticket on screen. Quick messages are gathered into one
 * refresh, and refreshes start at least a few minutes apart. After a failure
 * or a cancel it stays quiet until the operator summarizes themselves, so a
 * failing provider is never asked in a loop. Whether a refresh may run at
 * all (online, switch on) is the caller's `canRun`, asked when it is due.
 */

/** Quick messages within this wait become one refresh */
export const AUTO_SUMMARY_DEBOUNCE_MS = 15_000;
/** Automatic refreshes of one ticket start at least this far apart */
export const AUTO_SUMMARY_MIN_INTERVAL_MS = 3 * 60_000;

/**
 * idle: nothing planned; debouncing: a refresh follows shortly; cooling: one
 * ran recently, the next waits for the interval; running: a request is out.
 */
export type AutoSummaryPhase = "idle" | "debouncing" | "cooling" | "running";

export interface AutoSummaryRefresher {
  /** The ticket's public activity changed to `key` (or a summary is out of date for `key`) */
  request(key: string): void;
  /** A manual summary worked: automatic refreshes may resume */
  reset(): void;
  /** Stop automatic refreshes until `reset`, dropping a planned one */
  block(): void;
  /** The ticket left the screen */
  dispose(): void;
  phase(): AutoSummaryPhase;
}

export interface AutoSummaryOptions {
  /** Refresh the summary; resolves with the activity key it covered, rejects when it failed */
  run: () => Promise<string>;
  canRun: () => boolean;
  onPhase?: (phase: AutoSummaryPhase) => void;
}

export function createAutoSummaryRefresher({ run, canRun, onPhase }: AutoSummaryOptions): AutoSummaryRefresher {
  let current: AutoSummaryPhase = "idle";
  let timer: ReturnType<typeof setTimeout> | null = null;
  let plannedKey: string | null = null;
  let wantedKey: string | null = null;
  let coveredKey: string | null = null;
  let lastStart = -Infinity;
  let blocked = false;
  let disposed = false;

  function setPhase(next: AutoSummaryPhase) {
    if (next === current) return;
    current = next;
    onPhase?.(next);
  }

  function clearPlan() {
    if (timer) clearTimeout(timer);
    timer = null;
    plannedKey = null;
  }

  async function fire() {
    timer = null;
    plannedKey = null;
    if (disposed || blocked || !canRun()) {
      setPhase("idle");
      return;
    }
    lastStart = Date.now();
    setPhase("running");
    try {
      coveredKey = await run();
    } catch {
      blocked = true;
    }
    if (disposed) return;
    setPhase("idle");
    if (!blocked && wantedKey !== null && wantedKey !== coveredKey) plan(wantedKey);
  }

  function plan(key: string) {
    clearPlan();
    const now = Date.now();
    const due = Math.max(now + AUTO_SUMMARY_DEBOUNCE_MS, lastStart + AUTO_SUMMARY_MIN_INTERVAL_MS);
    plannedKey = key;
    timer = setTimeout(() => void fire(), due - now);
    setPhase(due > now + AUTO_SUMMARY_DEBOUNCE_MS ? "cooling" : "debouncing");
  }

  return {
    request(key) {
      if (disposed || blocked) return;
      wantedKey = key;
      if (key === coveredKey || current === "running") return;
      if (key === plannedKey) return;
      plan(key);
    },
    reset() {
      blocked = false;
    },
    block() {
      blocked = true;
      clearPlan();
      if (current !== "running") setPhase("idle");
    },
    dispose() {
      disposed = true;
      clearPlan();
    },
    phase: () => current,
  };
}
