/**
 * Sample data: stand-in statuses and tickets shown until a helpdesk is
 * connected. Every item carries `isSample: true` and the UI marks it as
 * sample wherever it is shown. The statuses are Freshdesk's four built-in
 * defaults, not anyone's real configuration.
 */

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
