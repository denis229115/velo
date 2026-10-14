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
  isSample: true;
}

export const SAMPLE_STATUSES: readonly SampleStatus[] = [
  { id: "2", label: "Open", isSample: true },
  { id: "3", label: "Pending", isSample: true },
  { id: "4", label: "Resolved", isSample: true },
  { id: "5", label: "Closed", isSample: true },
];

export const SAMPLE_TICKETS: readonly SampleTicket[] = [
  { id: "sample-1", subject: "Sample ticket: cannot sign in", customerName: "Sample Customer", statusId: "2", isSample: true },
  { id: "sample-2", subject: "Sample ticket: invoice copy requested", customerName: "Sample Customer", statusId: "3", isSample: true },
  { id: "sample-3", subject: "Sample ticket: export finished", customerName: "Sample Customer", statusId: "4", isSample: true },
];
