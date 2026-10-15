import { useEffect, useRef, useState } from "react";
import { RefreshCw, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { AiSendNote } from "@/components/ai/AiSendPreview";
import { getAiReadiness, type AiReadiness } from "@/services/ai/gateway";
import { AiError } from "@/services/ai/errors";
import type { TicketListItem } from "@/services/freshdesk/ticketSync";
import type { HistoryEntry, TicketHistoryView } from "@/services/freshdesk/ticketHistory";
import {
  SUMMARY_SECTIONS,
  summarizeTicket,
  TicketSummaryFormatError,
  type TicketAiSource,
  type TicketSummary,
} from "@/services/freshdesk/ticketAi";

// The gateway refused or the operator cancelled: nothing left Velo, so say so rather than report a failure
const NOT_SENT_CODES = new Set(["CANCELLED", "PREVIEW_REQUIRED", "SENSITIVE_DATA", "NOT_CONFIGURED", "NOT_APPROVED", "PROVIDER_REFUSED"]);

/** The history entry's anchor, which summary references scroll to */
export function ticketEntryAnchor(entryId: string): string {
  return `ticket-entry-${entryId}`;
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

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "done"; summary: TicketSummary }
  | { kind: "failed"; message: string };

function failureText(err: unknown): string {
  if (err instanceof AiError && NOT_SENT_CODES.has(err.code)) return err.message;
  if (err instanceof TicketSummaryFormatError) return err.message;
  return "Summary unavailable right now. Reading and replying are not affected.";
}

/**
 * The Ticket summary, on request: issue, facts, work done, blocker, open
 * questions and next action, each point linking to the messages it rests on.
 * Kept in Velo only; nothing is written to Freshdesk. With AI off it says so
 * in one line and the reader works as usual.
 */
export function TicketSummaryCard({ ticket, view }: { ticket: TicketListItem; view: TicketHistoryView | null }) {
  const readiness = useAiReadiness();
  const [state, setState] = useState<State>({ kind: "idle" });
  const run = useRef(0);

  // Leaving the ticket abandons a request in flight
  useEffect(() => () => void run.current++, []);

  if (!readiness) return null;

  if (readiness.status !== "ready") {
    return (
      <section aria-label="AI summary" className="max-w-4xl mb-4 flex items-start gap-2 rounded-lg border border-border-primary px-3 py-2">
        <Sparkles size={14} aria-hidden className="shrink-0 mt-0.5 text-text-tertiary" />
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
    setState({ kind: "loading" });
    try {
      const summary = await summarizeTicket(ticketAiSource(ticket, view), { refresh });
      if (run.current === mine) setState({ kind: "done", summary });
    } catch (err) {
      if (run.current === mine) setState({ kind: "failed", message: failureText(err) });
    }
  }

  function cancel() {
    run.current++;
    setState({ kind: "idle" });
  }

  const entries = view?.entries ?? [];
  const note = <AiSendNote features={["ticket_summary"]} onPreview={() => void summarize(true)} />;

  if (state.kind !== "done") {
    return (
      <section aria-label="AI summary" className="max-w-4xl mb-4 rounded-lg border border-border-primary px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <Sparkles size={14} aria-hidden className="shrink-0 text-accent" />
          <span className="text-preview font-medium text-text-primary">AI summary</span>
          {state.kind === "loading" ? (
            <>
              <span role="status" className="inline-flex items-center gap-1.5 text-meta text-text-tertiary">
                <span className="w-3 h-3 border-2 border-accent/30 border-t-accent rounded-full animate-spin" aria-hidden />
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

  return (
    <section aria-label="AI summary" className="max-w-4xl mb-4 rounded-lg border border-accent/30 bg-accent/5 px-4 py-3">
      <div className="flex items-center gap-2 mb-2">
        <Sparkles size={14} aria-hidden className="shrink-0 text-accent" />
        <span className="text-preview font-medium text-text-primary">AI summary</span>
        <span className="text-micro text-text-tertiary">Kept in Velo only, never written to Freshdesk</span>
        <Button variant="ghost" size="xs" iconOnly aria-label="Summarize again" title="Summarize again" className="ml-auto" onClick={() => void summarize(true)} icon={<RefreshCw size={12} aria-hidden />} />
        <Button variant="ghost" size="xs" iconOnly aria-label="Hide summary" title="Hide summary" onClick={() => setState({ kind: "idle" })} icon={<X size={12} aria-hidden />} />
      </div>
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
      onClick={() => document.getElementById(ticketEntryAnchor(entryId))?.scrollIntoView({ behavior: "smooth", block: "start" })}
      className="ml-1 inline-flex items-center rounded border border-border-primary bg-bg-primary px-1 text-micro font-mono text-text-secondary hover:text-text-primary hover:bg-bg-hover align-baseline"
    >
      {n}
    </button>
  );
}
