/**
 * Ticket activity: what each conversation is, and the metrics derived from a
 * ticket's history (see CONTEXT.md, Activity). Pure functions; times are unix
 * seconds in, unix ms out.
 */

/** Freshdesk conversation sources (fixed API values). */
const SOURCE_REPLY = 0;
const SOURCE_NOTE = 2;
/** Ticket source for a ticket an agent started by email (not a customer request). */
export const TICKET_SOURCE_OUTBOUND_EMAIL = 10;

export type ConversationKind =
  /** Public, outbound, written by a known human agent: the only kind that answers */
  | "reply"
  /** Public reply produced by an automation rule */
  | "automated_reply"
  /** Public outbound reply whose author is not one of the helpdesk's agents, so it may be automated */
  | "unverified_reply"
  | "public_note"
  | "internal_note"
  /** Phone, chat and other logged interactions */
  | "logged_interaction"
  | "customer_message"
  /** Arrived from outside but written by an agent (e.g. an agent answering by email) */
  | "incoming_from_agent";

export interface ConversationAttachment {
  name: string;
  contentType: string | null;
  size: number | null;
  url: string | null;
}

export interface DecodedConversation {
  conversationId: string;
  kind: ConversationKind;
  userId: string | null;
  fromEmail: string | null;
  bodyHtml: string | null;
  bodyText: string | null;
  attachments: ConversationAttachment[];
  createdAt: number;
  updatedAt: number;
}

const idOrNull = (v: unknown): string | null => (typeof v === "number" || typeof v === "string" ? String(v) : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function seconds(iso: unknown): number | null {
  const ms = typeof iso === "string" ? Date.parse(iso) : NaN;
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

export function decodeAttachments(raw: unknown): ConversationAttachment[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((a) => {
    if (!a || typeof a !== "object") return [];
    const att = a as Record<string, unknown>;
    return [{
      name: str(att.name) ?? "attachment",
      contentType: str(att.content_type),
      size: typeof att.size === "number" ? att.size : null,
      url: str(att.attachment_url),
    }];
  });
}

export function classifyConversation(c: Record<string, unknown>, humanAgentIds: ReadonlySet<string>): ConversationKind {
  const userId = idOrNull(c.user_id);
  const byAgent = userId !== null && humanAgentIds.has(userId);
  if (c.private === true) return "internal_note";
  if (c.incoming === true) return byAgent ? "incoming_from_agent" : "customer_message";
  if (c.source === SOURCE_NOTE) return "public_note";
  if (c.source !== SOURCE_REPLY) return "logged_interaction";
  if (c.automation_id != null || c.automation_type_id != null) return "automated_reply";
  return byAgent ? "reply" : "unverified_reply";
}

/** Null when the payload is not a conversation Velo can place in time. */
export function decodeConversation(raw: unknown, humanAgentIds: ReadonlySet<string>): DecodedConversation | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const conversationId = idOrNull(c.id);
  const createdAt = seconds(c.created_at);
  if (conversationId === null || createdAt === null) return null;
  return {
    conversationId,
    kind: classifyConversation(c, humanAgentIds),
    userId: idOrNull(c.user_id),
    fromEmail: str(c.from_email),
    bodyHtml: str(c.body),
    bodyText: str(c.body_text),
    attachments: decodeAttachments(c.attachments),
    createdAt,
    updatedAt: seconds(c.updated_at) ?? createdAt,
  };
}

/** The latest time of each kind of activity in a history, unix seconds. */
export interface ActivitySummary {
  lastAnsweredAt: number | null;
  /** Latest reply whose author could not be verified as a human agent */
  unverifiedReplyAt: number | null;
  lastCustomerMessageAt: number | null;
  lastInternalNoteAt: number | null;
  lastActivityAt: number | null;
}

const latest = (a: number | null, b: number): number => (a === null || b > a ? b : a);

/**
 * Summarises a history: the original request (a customer message unless an
 * agent started the ticket by email) plus its conversations.
 */
export function summarizeHistory(
  request: { createdAt: number; ticketSource: number | null },
  conversations: Pick<DecodedConversation, "kind" | "createdAt">[],
): ActivitySummary {
  const s: ActivitySummary = {
    lastAnsweredAt: null,
    unverifiedReplyAt: null,
    lastCustomerMessageAt: request.ticketSource === TICKET_SOURCE_OUTBOUND_EMAIL ? null : request.createdAt,
    lastInternalNoteAt: null,
    lastActivityAt: null,
  };
  for (const c of conversations) {
    s.lastActivityAt = latest(s.lastActivityAt, c.createdAt);
    if (c.kind === "reply") s.lastAnsweredAt = latest(s.lastAnsweredAt, c.createdAt);
    else if (c.kind === "unverified_reply") s.unverifiedReplyAt = latest(s.unverifiedReplyAt, c.createdAt);
    else if (c.kind === "customer_message") s.lastCustomerMessageAt = latest(s.lastCustomerMessageAt, c.createdAt);
    else if (c.kind === "internal_note") s.lastInternalNoteAt = latest(s.lastInternalNoteAt, c.createdAt);
  }
  return s;
}

export type ActivityTime = { state: "known"; at: number } | { state: "never" } | { state: "unknown" };

/** not_loaded: no history yet; incomplete: partly loaded or out of date; complete: verified in full. */
export type HistoryState = "not_loaded" | "incomplete" | "complete";

export interface TicketActivity {
  history: HistoryState;
  lastAnswered: ActivityTime;
  lastCustomerMessage: ActivityTime;
  lastInternalNote: ActivityTime;
  lastActivity: ActivityTime;
  /** Null while it cannot be decided */
  needsReply: boolean | null;
}

const UNKNOWN: ActivityTime = { state: "unknown" };
const timeOf = (s: number | null): ActivityTime => (s === null ? { state: "never" } : { state: "known", at: s * 1000 });

/**
 * The metrics the operator sees. Anything short of a complete, current
 * history is Unknown, never Never answered.
 */
export function activityFrom(summary: ActivitySummary | null, history: HistoryState, outstanding: boolean): TicketActivity {
  if (!summary || history !== "complete") {
    return { history, lastAnswered: UNKNOWN, lastCustomerMessage: UNKNOWN, lastInternalNote: UNKNOWN, lastActivity: UNKNOWN, needsReply: null };
  }
  const answered = summary.lastAnsweredAt;
  const unverified = summary.unverifiedReplyAt;
  const customer = summary.lastCustomerMessageAt;
  // A reply that may have been automated, newer than any verified one, leaves Last answered undecidable
  const answerUndecided = unverified !== null && (answered === null || unverified > answered);

  let needsReply: boolean | null;
  if (!outstanding || customer === null) needsReply = false;
  else if (answered !== null && answered >= customer) needsReply = false;
  else if (unverified !== null && unverified >= customer) needsReply = null;
  else needsReply = true;

  return {
    history,
    lastAnswered: answerUndecided ? UNKNOWN : timeOf(answered),
    lastCustomerMessage: timeOf(customer),
    lastInternalNote: timeOf(summary.lastInternalNoteAt),
    lastActivity: timeOf(summary.lastActivityAt),
    needsReply,
  };
}
