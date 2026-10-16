/**
 * Sample data: stand-in statuses and tickets shown until a helpdesk is
 * connected. Every item carries `isSample: true` and the UI marks it as
 * sample wherever it is shown. The statuses are Freshdesk's four built-in
 * defaults, not anyone's real configuration.
 */
import type { HistoryState } from "./activity";
import type { EntryKind, HistoryEntry } from "./ticketHistory";

export interface SampleStatus {
  id: string;
  label: string;
  isSample: true;
}

export interface SampleTicket {
  /** Prefixed so it can never collide with a helpdesk ticket ID. */
  id: string;
  subject: string;
  customerName: string;
  statusId: string;
  priorityId: string;
  assigneeName: string | null;
  updatedMinutesAgo: number;
  isSample: true;
}

export interface SamplePriority {
  id: string;
  label: string;
}

export const SAMPLE_STATUSES: readonly SampleStatus[] = [
  { id: "2", label: "Open", isSample: true },
  { id: "3", label: "Pending", isSample: true },
  { id: "4", label: "Resolved", isSample: true },
  { id: "5", label: "Closed", isSample: true },
];

/** Freshdesk's four fixed ticket priorities. */
export const SAMPLE_PRIORITIES: readonly SamplePriority[] = [
  { id: "1", label: "Low" },
  { id: "2", label: "Medium" },
  { id: "3", label: "High" },
  { id: "4", label: "Urgent" },
];

/** Sample ticket "sample-4" uses a status ID no sample status has, to show how unknown statuses look. */
export const SAMPLE_TICKETS: readonly SampleTicket[] = [
  { id: "sample-1", subject: "Sample ticket: cannot sign in", customerName: "Sample Customer", statusId: "2", priorityId: "3", assigneeName: "Sample Agent", updatedMinutesAgo: 25, isSample: true },
  { id: "sample-2", subject: "Sample ticket: invoice copy requested", customerName: "Sample Customer", statusId: "3", priorityId: "2", assigneeName: null, updatedMinutesAgo: 180, isSample: true },
  { id: "sample-3", subject: "Sample ticket: export finished", customerName: "Sample Customer", statusId: "4", priorityId: "1", assigneeName: "Sample Agent", updatedMinutesAgo: 60 * 26, isSample: true },
  { id: "sample-4", subject: "Sample ticket: status Velo does not know", customerName: "Sample Customer", statusId: "99", priorityId: "4", assigneeName: "Sample Agent", updatedMinutesAgo: 60 * 50, isSample: true },
];

interface SampleEntry {
  kind: EntryKind;
  author: string;
  minutesAgo: number;
  text: string;
}

/** Sample conversation histories; "sample-4" shows a history that is only partly loaded. */
const SAMPLE_ENTRIES: Record<string, { history: HistoryState; entries: SampleEntry[] }> = {
  "sample-1": {
    history: "complete",
    entries: [
      { kind: "request", author: "Sample Customer", minutesAgo: 60 * 30, text: "Sample: I cannot sign in since this morning." },
      { kind: "automated_reply", author: "Automation", minutesAgo: 60 * 30 - 1, text: "Sample: we received your request." },
      { kind: "reply", author: "Sample Agent", minutesAgo: 60 * 6, text: "Sample: I have reset your session. Please try again." },
      { kind: "internal_note", author: "Sample Colleague", minutesAgo: 60 * 2, text: "Sample internal note: the sign-in provider had an outage." },
      { kind: "customer_message", author: "Sample Customer", minutesAgo: 25, text: "Sample: still failing, same error." },
    ],
  },
  "sample-2": {
    history: "complete",
    entries: [
      { kind: "request", author: "Sample Customer", minutesAgo: 60 * 5, text: "Sample: could I get a copy of my invoice?" },
      { kind: "reply", author: "Sample Agent", minutesAgo: 180, text: "Sample: attached, let me know if anything is missing." },
    ],
  },
  "sample-3": {
    history: "complete",
    entries: [
      { kind: "request", author: "Sample Customer", minutesAgo: 60 * 30, text: "Sample: my export never finished." },
      { kind: "public_note", author: "Sample Agent", minutesAgo: 60 * 27, text: "Sample public note: export queue is long today." },
      { kind: "reply", author: "Sample Agent", minutesAgo: 60 * 26, text: "Sample: your export is ready." },
    ],
  },
  "sample-4": {
    history: "incomplete",
    entries: [
      { kind: "request", author: "Sample Customer", minutesAgo: 60 * 52, text: "Sample: the status of this ticket is one Velo does not know." },
    ],
  },
};

/** A sample ticket's history with times relative to `now` (unix ms). */
export function sampleHistory(ticketId: string, now: number): { history: HistoryState; entries: HistoryEntry[] } | null {
  const sample = SAMPLE_ENTRIES[ticketId];
  if (!sample) return null;
  return {
    history: sample.history,
    entries: sample.entries.map((e, i) => ({
      id: i === 0 ? "request" : `${ticketId}-${i}`,
      kind: e.kind,
      visibility: e.kind === "internal_note" ? "internal" : "public",
      author: e.author,
      at: now - e.minutesAgo * 60_000,
      bodyHtml: null,
      bodyText: e.text,
      attachments: [],
    })),
  };
}
