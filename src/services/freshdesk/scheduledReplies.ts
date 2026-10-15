/**
 * Scheduled replies: a Reply to the customer sent later through Freshdesk
 * (never Gmail/SMTP), by a background checker while Velo runs. Kept apart from
 * scheduled emails. When due, the Staleness check runs again; a reply whose
 * ticket changed is Held for the operator instead of sent.
 */
import { useUIStore } from "@/stores/uiStore";
import { withReadSnapshot } from "@/services/db/connection";
import { getIntegrationAccount } from "@/services/db/freshdesk";
import { getCachedTickets } from "@/services/db/freshdeskTickets";
import {
  getDueScheduledReplies,
  getScheduledReplies,
  getUnconfirmedRepliesToCheck,
  insertScheduledReply,
  moveScheduledReply,
  type ScheduledReplyState,
  type StoredScheduledReply,
} from "@/services/db/freshdeskScheduledReplies";
import { notifyScheduledReplyFailed, notifyScheduledReplyHeld } from "@/services/notifications/notificationManager";
import { currentCredentials, currentTenantId } from "./connection";
import { discardTicketDraft, loadTicketDraft } from "./ticketDrafts";
import {
  OFFLINE_MESSAGE,
  SAMPLE_MESSAGE,
  reconcileTicketSend,
  sendTicketResponse,
  type StalenessBaseline,
  type TicketSendResult,
} from "./ticketSend";
import type { TicketEditResult } from "./ticketEdits";

/** Window event fired whenever scheduled replies are added or change state */
export const SCHEDULED_REPLIES_CHANGED_EVENT = "velo-scheduled-replies-changed";

export function announceScheduledRepliesChanged(): void {
  window.dispatchEvent(new Event(SCHEDULED_REPLIES_CHANGED_EVENT));
}

export interface ScheduledReply {
  id: string;
  ticketId: string;
  subject: string;
  recipient: string;
  bodyHtml: string;
  ccEmails: string[];
  /** Unix seconds */
  sendAt: number;
  thenStatusId: string | null;
  state: ScheduledReplyState;
  /** Why a Held reply was not sent, in the operator's words */
  holdReasons: string[];
  error: string | null;
  /** The reply went out but the chosen status was not set: why */
  statusProblem: string | null;
}

const nowS = () => Math.floor(Date.now() / 1000);

function toScheduledReply(stored: StoredScheduledReply): ScheduledReply {
  return {
    id: stored.replyId,
    ticketId: stored.ticketId,
    subject: stored.subject,
    recipient: stored.recipient,
    bodyHtml: stored.bodyHtml,
    ccEmails: stored.ccEmails,
    sendAt: stored.sendAt,
    thenStatusId: stored.thenStatusId,
    state: stored.state,
    holdReasons: stored.holdReasons,
    error: stored.lastError,
    statusProblem: stored.statusProblem,
  };
}

export type ScheduleResult = { ok: true; id: string } | { ok: false; message: string };

/**
 * Turns the ticket's reply draft into a Scheduled reply: the text moves out of
 * the composer into the schedule, with the draft's Staleness check baseline
 * and the ticket's status as the operator sees it now.
 */
export async function scheduleTicketReply(
  ticketId: string,
  options: { sendAt: number; thenStatusId?: string },
): Promise<ScheduleResult> {
  if (!(await currentCredentials())) return { ok: false, message: SAMPLE_MESSAGE };
  const draft = await loadTicketDraft(ticketId, "reply");
  if (!draft) return { ok: false, message: "There is nothing to schedule." };
  const tenantId = await currentTenantId();
  const { account, ticket } = await withReadSnapshot(async () => ({
    account: await getIntegrationAccount("freshdesk"),
    ticket: (await getCachedTickets(tenantId)).find((t) => t.ticketId === ticketId),
  }));

  const id = await insertScheduledReply({
    tenantId,
    agentId: account?.me?.agentId ?? "",
    ticketId,
    subject: ticket?.subject ?? "",
    recipient: [ticket?.customerName, ticket?.customerEmail && `<${ticket.customerEmail}>`].filter(Boolean).join(" "),
    bodyHtml: draft.bodyHtml,
    ccEmails: draft.ccEmails,
    sendAt: options.sendAt,
    thenStatusId: options.thenStatusId ?? null,
    baselineStartedAt: draft.baseline.startedAt,
    baselineAssignee: draft.baseline.assigneeId,
    baselineStatus: ticket?.statusId ?? null,
  });
  await discardTicketDraft(ticketId, "reply");
  announceScheduledRepliesChanged();
  return { ok: true, id };
}

export async function listScheduledReplies(): Promise<ScheduledReply[]> {
  return (await getScheduledReplies(await currentTenantId())).map(toScheduledReply);
}

function baselineOf(reply: StoredScheduledReply): StalenessBaseline {
  return { startedAt: reply.baselineStartedAt, assigneeId: reply.baselineAssignee, statusId: reply.baselineStatus };
}

/** Total automatic attempts before a Scheduled reply is failed; the same bound for Reconciliation */
export const MAX_ATTEMPTS = 5;
/** Seconds before attempt n+1, indexed by attempts made so far minus one */
const BACKOFF_S = [60, 300, 900, 3600];

const NEVER_CONFIRMED =
  "Velo could not confirm whether this reply went out. Check the ticket in Freshdesk, then use Check Freshdesk; it will not be sent again automatically.";

function statusProblemOf(status: TicketEditResult | undefined): string | null {
  if (!status || status.outcome === "confirmed") return null;
  return status.outcome === "needs_fields"
    ? "Freshdesk needs more fields filled in first. Set the status from the ticket header."
    : status.message;
}

async function failFinally(reply: StoredScheduledReply, from: ScheduledReplyState[], message: string): Promise<void> {
  if (await moveScheduledReply(reply.replyId, from, "failed", { lastError: message, nextAttemptAt: null })) {
    notifyScheduledReplyFailed(reply.subject, message);
  }
}

/** A send that did not happen: tried again later with backoff, until the bound */
async function failedAttempt(reply: StoredScheduledReply, attemptsMade: number, message: string): Promise<void> {
  const backoff = BACKOFF_S[attemptsMade - 1];
  if (attemptsMade >= MAX_ATTEMPTS || backoff === undefined) {
    await failFinally(reply, ["sending"], message);
  } else {
    await moveScheduledReply(reply.replyId, ["sending"], "pending", { lastError: message, nextAttemptAt: nowS() + backoff });
  }
}

/** What a send or Reconciliation came to, recorded on the Scheduled reply */
async function settle(reply: StoredScheduledReply, from: ScheduledReplyState, attemptsMade: number, result: TicketSendResult): Promise<void> {
  switch (result.outcome) {
    case "sent":
      await moveScheduledReply(reply.replyId, [from], "sent", {
        statusProblem: statusProblemOf(result.status),
        lastError: null,
        nextAttemptAt: null,
      });
      return;
    case "stale":
      // Held with the fresh baseline, so "Send anyway" acknowledges exactly these changes
      await moveScheduledReply(reply.replyId, [from], "held", {
        holdReasons: result.changes,
        baselineStartedAt: result.baseline.startedAt,
        baselineAssignee: result.baseline.assigneeId,
        baselineStatus: result.baseline.statusId ?? reply.baselineStatus,
        lastError: null,
        nextAttemptAt: null,
      });
      notifyScheduledReplyHeld(reply.subject, result.changes);
      return;
    case "unconfirmed": {
      // Reconciliation is retried with backoff; after the bound it waits for the operator
      const checks = from === "unconfirmed" ? attemptsMade : 0;
      const backoff = BACKOFF_S[Math.max(checks - 1, 0)];
      const gaveUp = checks >= MAX_ATTEMPTS || backoff === undefined;
      await moveScheduledReply(reply.replyId, [from], "unconfirmed", {
        journalEntryId: result.entryId,
        attempts: checks,
        lastError: gaveUp ? NEVER_CONFIRMED : result.message,
        nextAttemptAt: gaveUp ? null : nowS() + backoff,
      });
      if (gaveUp) notifyScheduledReplyFailed(reply.subject, NEVER_CONFIRMED);
      return;
    }
    case "failed":
      // Reconciliation found no such reply: the operator decides whether to send it again
      if (from === "unconfirmed") await failFinally(reply, ["unconfirmed"], result.message);
      else await failedAttempt(reply, attemptsMade, result.message);
      return;
    case "unavailable":
      if (result.message === OFFLINE_MESSAGE) {
        // Went offline meanwhile: waits without using up an attempt
        await moveScheduledReply(reply.replyId, [from], from === "unconfirmed" ? "unconfirmed" : "pending", { attempts: reply.attempts });
      } else {
        await failFinally(reply, [from], result.message);
      }
      return;
  }
}

async function sendDue(reply: StoredScheduledReply): Promise<void> {
  const attemptsMade = reply.attempts + 1;
  if (!(await moveScheduledReply(reply.replyId, ["pending"], "sending", { claimedAt: nowS(), attempts: attemptsMade }))) return;
  const result = await sendTicketResponse({
    ticketId: reply.ticketId,
    mode: "reply",
    bodyHtml: reply.bodyHtml,
    ccEmails: reply.ccEmails,
    baseline: baselineOf(reply),
    ...(reply.thenStatusId !== null && { thenStatusId: reply.thenStatusId }),
  });
  await settle(reply, "sending", attemptsMade, result);
}

/** Reconciliation of an Unconfirmed Scheduled reply: reads Freshdesk, never posts again */
async function reconcileDue(reply: StoredScheduledReply): Promise<void> {
  if (reply.journalEntryId === null) return;
  const result = await reconcileTicketSend(reply.ticketId, reply.journalEntryId);
  await settle(reply, "unconfirmed", reply.attempts + 1, result);
}

/**
 * Sends every Scheduled reply that is due and settles Unconfirmed ones. While
 * offline nothing is attempted: a reply due meanwhile waits, and the ticket is
 * checked again once online, before anything goes out.
 */
export async function processDueScheduledReplies(): Promise<void> {
  if (!useUIStore.getState().isOnline) return;
  if (!(await currentCredentials())) return;
  const tenantId = await currentTenantId();
  const now = nowS();
  const [due, unconfirmed] = await Promise.all([
    getDueScheduledReplies(tenantId, now),
    getUnconfirmedRepliesToCheck(tenantId, now),
  ]);
  for (const reply of unconfirmed) await reconcileDue(reply);
  for (const reply of due) await sendDue(reply);
  if (due.length + unconfirmed.length > 0) announceScheduledRepliesChanged();
}
