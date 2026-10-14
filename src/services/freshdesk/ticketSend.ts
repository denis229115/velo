/**
 * Sending a ticket response: a Reply to the customer or an Internal note,
 * always through Freshdesk's own API (never Gmail/SMTP). Every send is a
 * journalled remote write; it needs a connection and is never queued.
 */
import { useUIStore } from "@/stores/uiStore";
import { withReadSnapshot } from "@/services/db/connection";
import { getAgents, getIntegrationAccount, getStatusClasses } from "@/services/db/freshdesk";
import { getCachedTickets } from "@/services/db/freshdeskTickets";
import { finishJournalEntry, getJournalEntries, startJournalEntry } from "@/services/db/freshdeskJournal";
import { sanitizeHtml } from "@/utils/sanitize";
import { FreshdeskError, freshdeskPost, type HelpdeskCredentials } from "./client";
import { currentCredentials, currentTenantId } from "./connection";
import type { DecodedConversation } from "./activity";
import { refreshTicketHistory, type FreshTicket } from "./ticketHistory";
import { updateTicket, type TicketEditResult } from "./ticketEdits";

/** The two composer modes; a note can never go out as a reply */
export type ComposerMode = "reply" | "note";

/** What the operator had seen when the draft started, for the Staleness check */
export interface StalenessBaseline {
  /** Unix seconds */
  startedAt: number;
  assigneeId: string | null;
}

export interface TicketSendRequest {
  ticketId: string;
  mode: ComposerMode;
  /** Editor HTML; sanitised again here */
  bodyHtml: string;
  ccEmails?: string[];
  baseline: StalenessBaseline;
  /** Reply and set status: a status classified Done, set only once the reply is sent */
  thenStatusId?: string;
}

export type TicketSendResult =
  /** `status` is the second operation of reply-and-set-status, reported on its own */
  | { outcome: "sent"; status?: TicketEditResult }
  /** Nothing sent: the ticket changed since the draft started. Sending with `baseline` acknowledges it. */
  | { outcome: "stale"; changes: string[]; baseline: StalenessBaseline }
  /** Freshdesk did not answer; resolved by reconcileTicketSend, never by sending again */
  | { outcome: "unconfirmed"; entryId: number; message: string }
  | { outcome: "failed"; message: string }
  /** Not sent at all: offline or sample data. Sends are never queued. */
  | { outcome: "unavailable"; message: string };

export const OFFLINE_MESSAGE = "Sending needs a connection to Freshdesk. Your draft is kept.";
export const SAMPLE_MESSAGE = "Sample tickets can't be answered. Connect a helpdesk to send.";
const UNCONFIRMED_MESSAGE =
  "Freshdesk did not answer, so Velo can't tell yet whether this went out. Velo checks the conversation instead of sending again.";
const STILL_UNCONFIRMED_MESSAGE =
  "Velo could not read the ticket back from Freshdesk yet. It will not send again until it knows what happened.";

/** Freshdesk and Velo clocks may disagree a little when matching a send by time */
const CLOCK_SKEW_S = 120;

const nowS = () => Math.floor(Date.now() / 1000);

/** What the journal keeps about a send so reconciliation can recognise it */
interface SendRecord {
  mode: ComposerMode;
  sentAfter: number;
  /** The draft's text, whitespace removed, for matching it in the conversation */
  fingerprint: string;
  ccEmails: string[];
  thenStatusId: string | null;
}

/** The baseline for a draft that starts now, from the cached ticket */
export async function captureStalenessBaseline(ticketId: string): Promise<StalenessBaseline> {
  const ticket = await withReadSnapshot(async () =>
    (await getCachedTickets(await currentTenantId())).find((t) => t.ticketId === ticketId),
  );
  return { startedAt: nowS(), assigneeId: ticket?.responderId ?? null };
}

const squash = (text: string | null): string => (text ?? "").replace(/\s+/g, "");

function textOf(html: string): string {
  return new DOMParser().parseFromString(html, "text/html").body.textContent ?? "";
}

/** The HTML Freshdesk receives: the sanitised draft, plus my signature on a reply */
function outgoingBody(mode: ComposerMode, body: string, signature: string | null | undefined): string {
  return mode === "reply" && signature ? `${body}${sanitizeHtml(signature)}` : body;
}

/** What changed on the ticket since the draft started, in the operator's words */
function changesSince(
  baseline: StalenessBaseline,
  fresh: FreshTicket,
  meId: string | null,
  agentNames: Map<string, string>,
): string[] {
  const changes: string[] = [];
  const assignee = fresh.ticket.responderId;
  if (assignee !== baseline.assigneeId) {
    changes.push(assignee ? `Reassigned to ${agentNames.get(assignee) ?? "another agent"}.` : "Unassigned meanwhile.");
  }
  const newer = fresh.conversations.filter((c) => c.createdAt > baseline.startedAt && (meId === null || c.userId !== meId));
  for (const c of newer) {
    const change = describe(c, agentNames);
    if (!changes.includes(change)) changes.push(change);
  }
  return changes;
}

function describe(c: DecodedConversation, agentNames: Map<string, string>): string {
  const who = (c.userId && agentNames.get(c.userId)) || "Someone";
  switch (c.kind) {
    case "customer_message":
      return "The customer wrote.";
    case "internal_note":
      return `${who} added an internal note.`;
    case "reply":
    case "unverified_reply":
    case "automated_reply":
      return `${who} replied.`;
    default:
      return `${who} added to the conversation.`;
  }
}

function failureMessage(error: FreshdeskError): string {
  return error.detail?.message ? `${error.message.replace(/\.$/, "")}: ${error.detail.message}` : error.message;
}

/**
 * Sends a Reply or an Internal note. Runs the Staleness check first (fresh
 * ticket and conversation from Freshdesk); when a colleague or the customer
 * acted since the draft started, nothing is sent and the changes come back.
 */
export async function sendTicketResponse(request: TicketSendRequest): Promise<TicketSendResult> {
  if (!useUIStore.getState().isOnline) return { outcome: "unavailable", message: OFFLINE_MESSAGE };
  const current = await currentCredentials();
  if (!current) return { outcome: "unavailable", message: SAMPLE_MESSAGE };
  const { tenantId, credentials } = current;
  const { ticketId, mode } = request;

  const { account, agents, classes } = await withReadSnapshot(async () => ({
    account: await getIntegrationAccount("freshdesk"),
    agents: await getAgents(tenantId),
    classes: await getStatusClasses(tenantId),
  }));
  const thenStatusId = mode === "reply" ? (request.thenStatusId ?? null) : null;
  if (thenStatusId !== null && classes.get(thenStatusId) !== "done") {
    return { outcome: "failed", message: "That status is not classified Done in Velo. Nothing was sent." };
  }
  const meId = account?.me?.agentId ?? null;

  let fresh: FreshTicket;
  try {
    fresh = await refreshTicketHistory(tenantId, credentials, ticketId);
  } catch (error) {
    if (!(error instanceof FreshdeskError)) throw error;
    return { outcome: "failed", message: `Velo could not re-check the ticket before sending: ${failureMessage(error)} Nothing was sent.` };
  }
  const agentNames = new Map(agents.map((a) => [a.agentId, a.name]));
  const changes = changesSince(request.baseline, fresh, meId, agentNames);
  if (changes.length > 0) {
    return { outcome: "stale", changes, baseline: { startedAt: nowS(), assigneeId: fresh.ticket.responderId } };
  }

  const draft = sanitizeHtml(request.bodyHtml);
  const body = outgoingBody(mode, draft, account?.me?.signature);
  const ccEmails = mode === "reply" ? (request.ccEmails ?? []) : [];
  const payload = mode === "reply" ? { body, ...(ccEmails.length > 0 && { cc_emails: ccEmails }) } : { body, private: true };
  const record: SendRecord = { mode, sentAfter: nowS(), fingerprint: squash(textOf(draft)).slice(0, 200), ccEmails, thenStatusId };
  const entryId = await startJournalEntry(tenantId, ticketId, mode === "reply" ? "send_reply" : "add_note", { ...record });
  try {
    await freshdeskPost<unknown>(credentials, `/tickets/${encodeURIComponent(ticketId)}/${mode === "reply" ? "reply" : "notes"}`, payload);
  } catch (error) {
    if (!(error instanceof FreshdeskError)) throw error;
    if (error.kind === "network") {
      await finishJournalEntry(entryId, "unconfirmed", UNCONFIRMED_MESSAGE);
      return { outcome: "unconfirmed", entryId, message: UNCONFIRMED_MESSAGE };
    }
    const message = failureMessage(error);
    await finishJournalEntry(entryId, "failed", message);
    return { outcome: "failed", message };
  }
  await finishJournalEntry(entryId, "confirmed", null);
  await refreshAfterSend(tenantId, credentials, ticketId);
  return sentThen(ticketId, thenStatusId);
}

/** The second operation of reply-and-set-status, journalled on its own */
async function sentThen(ticketId: string, thenStatusId: string | null): Promise<TicketSendResult> {
  if (thenStatusId === null) return { outcome: "sent" };
  return { outcome: "sent", status: await updateTicket(ticketId, { statusId: thenStatusId }) };
}

/** Reads the ticket back so the reader and Last answered show the send; a failed read leaves it to the next sync */
async function refreshAfterSend(tenantId: string, credentials: HelpdeskCredentials, ticketId: string): Promise<void> {
  try {
    await refreshTicketHistory(tenantId, credentials, ticketId);
  } catch {
    // Sent all the same; the next hydration run reads the ticket again
  }
}

function sentByThisSend(c: DecodedConversation, record: SendRecord, meId: string | null): boolean {
  const kindMatches = record.mode === "note" ? c.kind === "internal_note" : c.kind !== "internal_note";
  return (
    kindMatches &&
    (meId === null || c.userId === meId) &&
    c.createdAt >= record.sentAfter - CLOCK_SKEW_S &&
    squash(c.bodyText).includes(record.fingerprint)
  );
}

/**
 * Reconciliation of an Unconfirmed send (A10): reads the conversation back and
 * looks for the send by author, kind, time and text. Never posts again.
 */
export async function reconcileTicketSend(ticketId: string, entryId: number): Promise<TicketSendResult> {
  const current = await currentCredentials();
  if (!current) return { outcome: "unavailable", message: SAMPLE_MESSAGE };
  const { tenantId, credentials } = current;
  const { entry, account } = await withReadSnapshot(async () => ({
    entry: (await getJournalEntries(tenantId, ticketId)).find((e) => e.entryId === entryId),
    account: await getIntegrationAccount("freshdesk"),
  }));
  if (!entry) return { outcome: "failed", message: "Velo has no record of this send." };
  if (entry.outcome === "confirmed") return { outcome: "sent" };
  if (entry.outcome === "failed") return { outcome: "failed", message: entry.errorMessage ?? "The send failed." };
  if (!useUIStore.getState().isOnline) return { outcome: "unconfirmed", entryId, message: STILL_UNCONFIRMED_MESSAGE };

  const record = entry.changes as unknown as SendRecord;
  let fresh: FreshTicket;
  try {
    fresh = await refreshTicketHistory(tenantId, credentials, ticketId);
  } catch {
    return { outcome: "unconfirmed", entryId, message: STILL_UNCONFIRMED_MESSAGE };
  }
  const meId = account?.me?.agentId ?? null;
  if (fresh.conversations.some((c) => sentByThisSend(c, record, meId))) {
    await finishJournalEntry(entryId, "confirmed", null);
    return sentThen(ticketId, record.thenStatusId);
  }
  const what = record.mode === "note" ? "internal note" : "reply";
  const message = `Freshdesk has no record of this ${what}, so it was not sent. Your draft is kept; send it again when ready.`;
  await finishJournalEntry(entryId, "failed", message);
  return { outcome: "failed", message };
}
