import { useShortcutAction } from "@/hooks/useShortcutAction";
import { useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { AiSendNote } from "@/components/ai/AiSendPreview";
import { getAiReadiness, APPROVED_PROVIDER_LABEL, type AiReadiness } from "@/services/ai/gateway";
import { getSetting } from "@/services/db/settings";
import { useUIStore } from "@/stores/uiStore";
import { AiError } from "@/services/ai/errors";
import type { TicketListItem } from "@/services/freshdesk/ticketSync";
import type { HistoryEntry, TicketHistoryView } from "@/services/freshdesk/ticketHistory";
import {
  publicActivityKey,
  SUMMARY_SECTIONS,
  summarizeTicket,
  TicketSummaryFormatError,
  type TicketAiSource,
  type TicketSummary,
} from "@/services/freshdesk/ticketAi";
import {
  AUTO_SUMMARY_DEBOUNCE_MS,
  AUTO_SUMMARY_SETTING,
  AUTO_SUMMARY_MIN_INTERVAL_MS,
  createAutoSummaryRefresher,
  type AutoSummaryPhase,
  type AutoSummaryRefresher,
} from "@/services/freshdesk/ticketAutoSummary";

// The gateway refused or the operator cancelled: nothing left Velo, so say so rather than report a failure
const NOT_SENT_CODES = new Set(["CANCELLED", "PREVIEW_REQUIRED", "SENSITIVE_DATA", "NOT_CONFIGURED", "NOT_APPROVED", "PROVIDER_REFUSED"]);

/** The history entry's anchor, which summary references scroll to */
export function ticketEntryAnchor(entryId: string): string {
  return `ticket-entry-${entryId}`;
}

/** History listens for this and expands the cited conversation, including one that was collapsed. */
export const TICKET_ENTRY_REVEAL_EVENT = "velo-reveal-ticket-entry";

/** Scroll a summary citation to its conversation and ask the history to expand it. */
export function revealTicketEntry(entryId: string) {
  document.dispatchEvent(new CustomEvent(TICKET_ENTRY_REVEAL_EVENT, { detail: entryId }));
  document.getElementById(ticketEntryAnchor(entryId))?.scrollIntoView?.({ behavior: "smooth", block: "start" });
}

export function ticketAiSource(ticket: TicketListItem, view: TicketHistoryView): TicketAiSource {
  return {
    ticketId: ticket.id,
    subject: ticket.subject,
    status: ticket.status.label,
    priority: ticket.priority?.label ?? null,
    entries: view.entries,
  };
}

/** AI readiness, checked once per mount; null while checking */
export function useAiReadiness(): AiReadiness | null {
  const [readiness, setReadiness] = useState<AiReadiness | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getAiReadiness()
      .then((r) => !cancelled && setReadiness(r))
      .catch(() => !cancelled && setReadiness({ status: "off", message: "AI is not available." }));
    return () => {
      cancelled = true;
    };
  }, []);
  return readiness;
}

/** Whether summaries update by themselves; null until the setting is read */
function useAutoSummarySetting(): boolean | null {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getSetting(AUTO_SUMMARY_SETTING)
      .then((v) => !cancelled && setOn(v !== "false"))
      .catch(() => !cancelled && setOn(true));
    return () => {
      cancelled = true;
    };
  }, []);
  return on;
}

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  /** `key` is the public activity the summary rests on; `notice` says why the last automatic update did not happen */
  | { kind: "done"; summary: TicketSummary; key: string; notice?: string; refreshing?: boolean }
  | { kind: "failed"; message: string };

function failureText(err: unknown): string {
  if (err instanceof AiError && NOT_SENT_CODES.has(err.code)) return err.message;
  if (err instanceof TicketSummaryFormatError) return err.message;
  return "Summary unavailable right now. Reading and replying are not affected.";
}

/**
 * The Ticket summary: issue, facts, work done, blocker, open questions and next
 * action, each point linking to the messages it rests on. Kept in Velo only;
 * nothing is written to Freshdesk. With AI off it says so in one line and the
 * reader works as usual.
 *
 * It is made on request. Once one is on screen and a new public message
 * arrives, it updates by itself (unless Settings → AI turns that off): through
 * the same gateway as a manual summary, never opening a send preview on its
 * own, never offline, never twice within a few minutes, and never again after
 * a failure. Until the new summary is ready the old one stays, labelled
 * Updating; when no update is coming it is labelled Out of date.
 */
export function TicketSummaryCard({ ticket, view }: { ticket: TicketListItem; view: TicketHistoryView | null }) {
  const readiness = useAiReadiness();
  const online = useUIStore((s) => s.isOnline);
  const autoOn = useAutoSummarySetting();
  const [state, setState] = useState<State>({ kind: "idle" });
  const [phase, setPhase] = useState<AutoSummaryPhase>("idle");
  const run = useRef(0);
  const refresher = useRef<AutoSummaryRefresher | null>(null);
  const ready = readiness?.status === "ready";
  const displayed = state.kind === "done";
  const latest = useRef({ ticket, view, online, autoOn, ready, displayed });
  latest.current = { ticket, view, online, autoOn, ready, displayed };

  // Leaving the ticket abandons a request in flight and anything planned
  useEffect(() => () => void run.current++, []);
  useEffect(() => {
    if (!displayed) return;
    async function refresh(): Promise<string> {
      const { ticket, view } = latest.current;
      if (!view || !latest.current.displayed) throw new Error("The conversation is not loaded.");
      const source = ticketAiSource(ticket, view);
      const key = publicActivityKey(source);
      const mine = ++run.current;
      try {
        const summary = await summarizeTicket(source, { unattended: true });
        if (run.current === mine) setState({ kind: "done", summary, key });
      } catch (err) {
        if (run.current === mine) setState((prev) => (prev.kind === "done" ? { ...prev, notice: failureText(err) } : prev));
        throw err;
      }
      return key;
    }
    const r = createAutoSummaryRefresher({
      run: refresh,
      canRun: () => latest.current.displayed && latest.current.ready && latest.current.online && latest.current.autoOn === true,
      debounceMs: AUTO_SUMMARY_DEBOUNCE_MS,
      minIntervalMs: AUTO_SUMMARY_MIN_INTERVAL_MS,
      onPhase: setPhase,
    });
    refresher.current = r;
    return () => {
      r.dispose();
      if (refresher.current === r) refresher.current = null;
    };
  }, [displayed]);

  // New public activity makes a summary on screen out of date, and plans its update
  const currentKey = useMemo(() => (view ? publicActivityKey(ticketAiSource(ticket, view)) : null), [ticket, view]);
  const stale = state.kind === "done" && currentKey !== null && state.key !== currentKey;
  const complete = view?.history === "complete";
  useEffect(() => {
    if (stale && currentKey !== null && complete && ready && online && autoOn) refresher.current?.request(currentKey);
  }, [stale, currentKey, complete, ready, online, autoOn]);

  useShortcutAction("ticket.summarize", ({ ticketId }) => {
    if (ticketId !== ticket.id || !ready || !view || state.kind === "loading" || (state.kind === "done" && state.refreshing)) return;
    void summarize(state.kind === "failed" || state.kind === "done");
  });

  if (!readiness) return null;

  if (readiness.status !== "ready") {
    return (
      <section aria-label="AI summary" className="material-pop max-w-4xl mb-4 flex items-start gap-2 rounded-[var(--radius-panel)] border border-separator px-3 py-2">
        <Sparkles size={14} aria-hidden className="shrink-0 mt-0.5 text-text-secondary" />
        <p className="text-meta text-text-tertiary">
          {readiness.status === "off"
            ? "AI summary is off. Approve the Claude API in Settings to summarise tickets and draft replies."
            : readiness.message}
        </p>
      </section>
    );
  }

  async function summarize(refresh = false) {
    if (!view) return;
    const mine = ++run.current;
    const source = ticketAiSource(ticket, view);
    const key = publicActivityKey(source);
    setState((prev) => (prev.kind === "done" ? { ...prev, refreshing: true, notice: undefined } : { kind: "loading" }));
    try {
      const summary = await summarizeTicket(source, { refresh });
      if (run.current !== mine) return;
      refresher.current?.reset();
      setState({ kind: "done", summary, key });
    } catch (err) {
      if (run.current !== mine) return;
      setState((prev) => (prev.kind === "done" ? { ...prev, refreshing: false, notice: failureText(err) } : { kind: "failed", message: failureText(err) }));
    }
  }

  function hide() {
    run.current++;
    refresher.current?.dispose();
    refresher.current = null;
    setPhase("idle");
    setState({ kind: "idle" });
  }

  function cancel() {
    run.current++;
    refresher.current?.block();
    setState((prev) => (prev.kind === "done" ? { ...prev, refreshing: false } : { kind: "idle" }));
  }

  const entries = view?.entries ?? [];
  const note = <AiSendNote features={["ticket_summary"]} onPreview={() => void summarize(true)} />;

  if (state.kind !== "done") {
    return (
      <section aria-label="AI summary" className="material-pop max-w-4xl mb-4 rounded-[var(--radius-panel)] border border-separator px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <Sparkles size={14} aria-hidden className="shrink-0 text-text-secondary" />
          <span className="text-preview font-medium text-text-primary">AI summary</span>
          {state.kind === "loading" ? (
            <>
              <span role="status" className="inline-flex items-center gap-1.5 text-meta text-text-tertiary">
                <span className="w-3 h-3 border-2 border-text-tertiary/40 border-t-text-secondary rounded-full animate-spin" aria-hidden />
                Summarizing…
              </span>
              <Button variant="ghost" size="xs" onClick={cancel}>
                Cancel
              </Button>
            </>
          ) : (
            <Button variant="secondary" size="xs" className="border border-border-primary" disabled={!view} onClick={() => void summarize(state.kind === "failed")}>
              {state.kind === "failed" ? "Try again" : "Summarize"}
            </Button>
          )}
          <span className="ml-auto">{note}</span>
        </div>
        {state.kind === "failed" && <p className="mt-1.5 text-meta text-text-secondary">{state.message}</p>}
      </section>
    );
  }

  const updating = !!state.refreshing || (stale && (phase === "debouncing" || phase === "running"));
  const hint = state.notice ?? (stale && !online ? "Offline: it updates when you are back online." : null);

  return (
    <section aria-label="AI summary" className="material-pop max-w-4xl mb-4 rounded-[var(--radius-panel)] border border-separator px-4 py-3">
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <Sparkles size={14} aria-hidden className="shrink-0 text-text-secondary" />
        <span className="text-preview font-medium text-text-primary">AI summary</span>
        {updating ? (
          <>
            <span role="status" className="inline-flex items-center gap-1.5 text-micro text-text-secondary">
              <span className="w-3 h-3 border-2 border-text-tertiary/40 border-t-text-secondary rounded-full animate-spin" aria-hidden />
              Updating with {APPROVED_PROVIDER_LABEL}…
            </span>
            <Button variant="ghost" size="xs" onClick={cancel}>
              Cancel
            </Button>
          </>
        ) : stale ? (
          <>
            <span className="rounded border border-status-warning/40 bg-status-warning/10 px-1.5 py-px text-micro font-medium text-status-warning">Out of date</span>
            <Button variant="secondary" size="xs" className="border border-border-primary" disabled={!view} onClick={() => void summarize()}>
              Update summary
            </Button>
          </>
        ) : (
          <span className="text-micro text-text-tertiary">Kept in Velo only, never written to Freshdesk</span>
        )}
        <Button variant="ghost" size="xs" iconOnly aria-label="Summarize again" title="Summarize again" className="ml-auto" disabled={updating} onClick={() => void summarize(true)} icon={<RefreshCw size={12} aria-hidden />} />
        <Button variant="ghost" size="xs" iconOnly aria-label="Hide summary" title="Hide summary" onClick={hide} icon={<X size={12} aria-hidden />} />
      </div>
      {hint && <p className="mb-2 text-meta text-text-secondary">{hint}</p>}
      <dl className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2.5">
        {SUMMARY_SECTIONS.map(({ key, label }) => (
          <div key={key} className="min-w-0">
            <dt>
              <h3 className="text-micro font-medium uppercase tracking-wide text-text-tertiary">{label}</h3>
            </dt>
            <dd className="mt-0.5">
              {state.summary[key].length === 0 ? (
                <p className="text-meta text-text-tertiary">None</p>
              ) : (
                <ul className="space-y-0.5">
                  {state.summary[key].map((point, i) => (
                    <li key={i} className="text-meta text-text-primary leading-relaxed">
                      {point.text}
                      {point.sources.map((id) => (
                        <SourceRef key={id} entryId={id} entries={entries} />
                      ))}
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </div>
        ))}
      </dl>
      <div className="mt-2.5">{note}</div>
    </section>
  );
}

/** A reference to the message a point rests on, numbered as the history numbers it */
function SourceRef({ entryId, entries }: { entryId: string; entries: HistoryEntry[] }) {
  const index = entries.findIndex((e) => e.id === entryId);
  if (index < 0) return null;
  const entry = entries[index]!;
  const n = index + 1;
  return (
    <button
      type="button"
      aria-label={`Go to message ${n} by ${entry.author}`}
      title={`Message ${n} by ${entry.author}`}
      onClick={() => revealTicketEntry(entryId)}
      className="ml-1 inline-flex items-center rounded border border-border-primary bg-bg-primary px-1 text-micro font-mono text-text-secondary hover:text-text-primary hover:bg-bg-hover align-baseline"
    >
      {n}
    </button>
  );
}
