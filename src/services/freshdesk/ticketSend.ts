/**
 * Sending a ticket response: a Reply to the customer or an Internal note,
 * always through Freshdesk's own API (never Gmail/SMTP). Every send is a
 * journalled remote write; it needs a connection and is never queued.
 */
import { isEmailAddress, uniqueValidAddresses } from "./emailAddress";
import { useUIStore } from "@/stores/uiStore";
import { withReadSnapshot } from "@/services/db/connection";
import { getAgents, getFieldChoices, getIntegrationAccount, getStatusClasses } from "@/services/db/freshdesk";
import { getCachedTickets } from "@/services/db/freshdeskTickets";
import { finishJournalEntry, getJournalEntries, startJournalEntry } from "@/services/db/freshdeskJournal";
import { sanitizeHtml } from "@/utils/sanitize";
import { FreshdeskError, freshdeskPost, type HelpdeskCredentials } from "./client";
import { currentCredentials, currentTenantId } from "./connection";
import type { DecodedConversation } from "./activity";
import { refreshTicketHistory, type FreshTicket } from "./ticketHistory";
import { updateTicket, type TicketEditResult } from "./ticketEdits";
import { attachmentLimitProblem, cleanAttachmentName, multipartBody, type ReplyAttachment } from "./replyAttachments";

/** The two composer modes; a note can never go out as a reply */
export type ComposerMode = "reply" | "note";

/** What the operator had seen when the draft started, for the Staleness check */
export interface StalenessBaseline {
  /** Unix seconds */
  startedAt: number;
  assigneeId: string | null;
  /** The ticket's status then; when given, a status change counts as a change (Scheduled replies) */
  statusId?: string | null;
  /**
   * Unix seconds; when given, any answer to the customer after this, mine
   * included, counts as a change (a Scheduled reply must not be a second answer)
   */
  repliesSince?: number;
}

/** What the customer receives: a public reply, or a note made public */
const ANSWERS: ReadonlySet<DecodedConversation["kind"]> = new Set(["reply", "unverified_reply", "public_note"]);
const ALREADY_ANSWERED = "A reply was already sent since you scheduled this.";

export interface TicketSendRequest {
  ticketId: string;
  mode: ComposerMode;
  /** Editor HTML; sanitised again here */
  bodyHtml: string;
  ccEmails?: string[];
  baseline: StalenessBaseline;
  /** Reply and set status: a status classified Done, set only once the reply is sent */
  thenStatusId?: string;
  /** Files sent with it, in the same multipart request */
  attachments?: ReplyAttachment[];
}

export type TicketSendResult =
  /** `status` is the second operation of reply-and-set-status, reported on its own */
  | { outcome: "sent"; status?: TicketEditResult }
  /** Nothing sent: the ticket changed since the draft started. Sending with `baseline` acknowledges it. */
  | { outcome: "stale"; changes: string[]; baseline: StalenessBaseline }
  /**
   * Freshdesk did not answer, or answered with a server error (5xx): the reply may
   * be stored. Resolved by reconcileTicketSend, never by sending again.
   */
  | { outcome: "unconfirmed"; entryId: number; message: string }
  /**
   * Not sent. `retryAfterSeconds`: Freshdesk's rate limit says when to try again.
   * `rejected`: Freshdesk refused this request itself (4xx); the same request would be refused again.
   */
  | { outcome: "failed"; message: string; retryAfterSeconds?: number; rejected?: true }
  /** Not sent at all: offline or sample data. Sends are never queued. */
  | { outcome: "unavailable"; message: string };

export const OFFLINE_MESSAGE = "Sending needs a connection to Freshdesk. Your draft is kept.";
export const SAMPLE_MESSAGE = "Sample tickets can't be answered. Connect a helpdesk to send.";
export const UNCONFIRMED_MESSAGE =
  "Freshdesk did not answer, so Velo can't tell yet whether this went out. Velo checks the conversation instead of sending again.";
const serverErrorMessage = (status: number) =>
  `Freshdesk answered with an error (HTTP ${status}), so Velo can't tell yet whether this went out. Velo checks the conversation instead of sending again.`;
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
  /** The attached files' names as Freshdesk receives them (absent on sends without files) */
  attachmentNames?: string[];
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
  statusLabels: Map<string, string>,
): string[] {
  const changes: string[] = [];
  const assignee = fresh.ticket.responderId;
  if (assignee !== baseline.assigneeId) {
    changes.push(assignee ? `Reassigned to ${agentNames.get(assignee) ?? "another agent"}.` : "Unassigned meanwhile.");
  }
  const status = fresh.ticket.statusId;
  if (baseline.statusId !== undefined && status !== baseline.statusId) {
    changes.push(`Status changed to ${statusLabels.get(status) ?? "a status Velo does not know"}.`);
  }
  const newer = fresh.conversations.filter((c) => c.createdAt > baseline.startedAt && (meId === null || c.userId !== meId));
  for (const c of newer) {
    const change = describe(c, agentNames);
    if (!changes.includes(change)) changes.push(change);
  }
  const since = baseline.repliesSince;
  if (since !== undefined && fresh.conversations.some((c) => c.createdAt > since && ANSWERS.has(c.kind) && !newer.includes(c))) {
    changes.push(ALREADY_ANSWERED);
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

function waitText(seconds: number): string {
  return seconds < 90 ? `${seconds} seconds` : `${Math.round(seconds / 60)} minutes`;
}

/** A server error (5xx) answers after the request arrived: Freshdesk may have stored the reply */
const ambiguous = (error: FreshdeskError): boolean =>
  error.kind === "network" || (error.kind === "server" && (error.status ?? 0) >= 500);

function failureMessage(error: FreshdeskError): string {
  if (error.kind === "rate_limited") {
    const reason = error.detail?.message ? `: ${error.detail.message.replace(/\.$/, "")}` : "";
    const when = error.retryAfterSeconds ? ` Try again in ${waitText(error.retryAfterSeconds)}.` : " Try again shortly.";
    return `Freshdesk refused the send because of its rate limit${reason}.${when} Nothing was sent.`;
  }
  if (error.status === 413) return "Freshdesk refused the attachments as too large. Nothing was sent.";
  const fileErrors = (error.detail?.fieldErrors ?? []).filter((e) => e.field.startsWith("attachments") && e.message);
  if (fileErrors.length > 0) {
    return `Freshdesk did not accept the attachments: ${fileErrors.map((e) => e.message.replace(/\.$/, "")).join("; ")}. Nothing was sent.`;
  }
  const reasons = (error.detail?.fieldErrors ?? []).filter((e) => e.message);
  if (reasons.length > 0) {
    const list = reasons.map((e) => `${e.field ? `${e.field}: ` : ""}${e.message.replace(/\.$/, "")}`).join("; ");
    return `${error.message.replace(/\.$/, "")}: ${list}. Nothing was sent.`;
  }
  return error.detail?.message ? `${error.message.replace(/\.$/, "")}: ${error.detail.message}` : error.message;
}

/**
 * Sends a Reply or an Internal note. Runs the Staleness check first (fresh
 * ticket and conversation from Freshdesk); when a colleague or the customer
 * acted since the draft started, nothing is sent and the changes come back.
 */
export async function sendTicketResponse(request: TicketSendRequest): Promise<TicketSendResult> {
  const invalid = request.mode === "reply" ? (request.ccEmails ?? []).filter((e) => !isEmailAddress(e.trim())) : [];
  if (invalid.length > 0) {
    const shown = invalid.map((e) => e.replace(/\s+/g, " ").slice(0, 60)).join(", ");
    return { outcome: "failed", message: `Not an email address: ${shown}. Nothing was sent.` };
  }
  if (!useUIStore.getState().isOnline) return { outcome: "unavailable", message: OFFLINE_MESSAGE };
  const current = await currentCredentials();
  if (!current) return { outcome: "unavailable", message: SAMPLE_MESSAGE };
  const { tenantId, credentials } = current;
  const { ticketId, mode } = request;
  const tooLarge = attachmentLimitProblem(request.attachments ?? []);
  if (tooLarge) return { outcome: "failed", message: `${tooLarge} Nothing was sent.` };

  const { account, agents, classes, statuses } = await withReadSnapshot(async () => ({
    account: await getIntegrationAccount("freshdesk"),
    agents: await getAgents(tenantId),
    classes: await getStatusClasses(tenantId),
    statuses: await getFieldChoices(tenantId, "status"),
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
  if (!fresh.complete) return { outcome: "unavailable", message: "The ticket history is incomplete. Velo cannot re-check colleague activity before sending. Nothing was sent." };
  const agentNames = new Map(agents.map((a) => [a.agentId, a.name]));
  const statusLabels = new Map(statuses.map((s) => [s.choiceId, s.label]));
  const changes = changesSince(request.baseline, fresh, meId, agentNames, statusLabels);
  if (changes.length > 0) {
    const baseline: StalenessBaseline = { startedAt: nowS(), assigneeId: fresh.ticket.responderId };
    if (request.baseline.statusId !== undefined) baseline.statusId = fresh.ticket.statusId;
    if (request.baseline.repliesSince !== undefined) baseline.repliesSince = baseline.startedAt;
    return { outcome: "stale", changes, baseline };
  }

  const draft = sanitizeHtml(request.bodyHtml);
  const body = outgoingBody(mode, draft, account?.me?.signature);
  const ccEmails = mode === "reply" ? uniqueValidAddresses(request.ccEmails ?? []) : [];
  const attachments = request.attachments ?? [];
  const payload = mode === "reply" ? { body, ...(ccEmails.length > 0 && { cc_emails: ccEmails }) } : { body, private: true };
  const record: SendRecord = { mode, sentAfter: nowS(), fingerprint: squash(textOf(draft)).slice(0, 200), ccEmails, thenStatusId };
  if (attachments.length > 0) record.attachmentNames = attachments.map((a) => cleanAttachmentName(a.name));
  const entryId = await startJournalEntry(tenantId, ticketId, mode === "reply" ? "send_reply" : "add_note", { ...record });
  try {
    await freshdeskPost<unknown>(
      credentials,
      `/tickets/${encodeURIComponent(ticketId)}/${mode === "reply" ? "reply" : "notes"}`,
      attachments.length > 0 ? multipartBody(formFields(payload), attachments) : payload,
    );
  } catch (error) {
    if (!(error instanceof FreshdeskError)) throw error;
    if (ambiguous(error)) {
      const message = error.kind === "network" ? UNCONFIRMED_MESSAGE : serverErrorMessage(error.status ?? 500);
      await finishJournalEntry(entryId, "unconfirmed", message);
      return { outcome: "unconfirmed", entryId, message };
    }
    // Rate limited or refused (4xx): Freshdesk did not store it
    const message = failureMessage(error);
    await finishJournalEntry(entryId, "failed", message);
    if (error.kind === "rate_limited") {
      return { outcome: "failed", message, ...(error.retryAfterSeconds !== undefined && { retryAfterSeconds: error.retryAfterSeconds }) };
    }
    return { outcome: "failed", message, rejected: true };
  }
  await finishJournalEntry(entryId, "confirmed", null);
  await refreshAfterSend(tenantId, credentials, ticketId);
  return sentThen(ticketId, thenStatusId);
}

/** A JSON payload as multipart fields (booleans as "true"/"false") */
function formFields(payload: Record<string, string | boolean | string[] | undefined>): Record<string, string | string[]> {
  return Object.fromEntries(
    Object.entries(payload).flatMap(([k, v]) => (v === undefined ? [] : [[k, typeof v === "boolean" ? String(v) : v]])),
  );
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
    squash(c.bodyText).includes(record.fingerprint) &&
    (record.attachmentNames ?? []).every((name) => c.attachments.some((a) => a.name === name))
  );
}

/**
 * Reconciliation of an Unconfirmed send (A10): reads the conversation back and
 * looks for the send by author, kind, time, text and file names. Never posts again.
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
  if (!fresh.complete) return { outcome: "unconfirmed", entryId, message: "The ticket history is incomplete. Velo cannot rule out this send and will not send again." };
  const what = record.mode === "note" ? "internal note" : "reply";
  const message = `Freshdesk has no record of this ${what}, so it was not sent. Your draft is kept; send it again when ready.`;
  await finishJournalEntry(entryId, "failed", message);
  return { outcome: "failed", message };
}
