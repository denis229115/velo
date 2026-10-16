import { getDb } from "./connection";

/**
 * Where a Scheduled reply stands. `held` waits for the operator because the
 * ticket changed; `unconfirmed` is settled by Reconciliation, never by sending again.
 */
export type ScheduledReplyState = "pending" | "sending" | "held" | "unconfirmed" | "sent" | "failed";

export interface StoredScheduledReply {
  replyId: string;
  tenantId: string;
  agentId: string;
  ticketId: string;
  subject: string;
  /** The customer as the operator saw them when scheduling */
  recipient: string;
  bodyHtml: string;
  ccEmails: string[];
  /** Unix seconds */
  sendAt: number;
  /** A status classified Done, set only once the reply is confirmed sent */
  thenStatusId: string | null;
  /** The Staleness check baseline: what the operator had seen */
  baselineStartedAt: number;
  baselineAssignee: string | null;
  baselineStatus: string | null;
  /** Helpdesk connection generation this reply is pinned to. Empty on rows scheduled before generations were stored. */
  connectionGeneration: string;
  state: ScheduledReplyState;
  holdReasons: string[];
  /** The journal entry of a send still Unconfirmed */
  journalEntryId: number | null;
  /** When the background checker took it for sending, unix seconds */
  claimedAt: number | null;
  attempts: number;
  nextAttemptAt: number | null;
  lastError: string | null;
  /** Reply sent, status not set: why (the second operation's own failure) */
  statusProblem: string | null;
  createdAt: number;
  updatedAt: number;
}

interface Row {
  reply_id: string;
  tenant_id: string;
  agent_id: string;
  ticket_id: string;
  subject: string;
  recipient: string;
  body_html: string;
  cc_json: string;
  send_at: number;
  then_status_id: string | null;
  baseline_started_at: number;
  baseline_assignee: string | null;
  baseline_status: string | null;
  connection_generation: string;
  state: ScheduledReplyState;
  hold_reasons_json: string;
  journal_entry_id: number | null;
  claimed_at: number | null;
  attempts: number;
  next_attempt_at: number | null;
  last_error: string | null;
  status_problem: string | null;
  created_at: number;
  updated_at: number;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

function stringList(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((e): e is string => typeof e === "string") : [];
  } catch {
    return [];
  }
}

function fromRow(row: Row): StoredScheduledReply {
  return {
    replyId: row.reply_id,
    tenantId: row.tenant_id,
    agentId: row.agent_id,
    ticketId: row.ticket_id,
    subject: row.subject,
    recipient: row.recipient,
    bodyHtml: row.body_html,
    ccEmails: stringList(row.cc_json),
    sendAt: row.send_at,
    thenStatusId: row.then_status_id,
    baselineStartedAt: row.baseline_started_at,
    baselineAssignee: row.baseline_assignee,
    baselineStatus: row.baseline_status,
    connectionGeneration: row.connection_generation,
    state: row.state,
    holdReasons: stringList(row.hold_reasons_json),
    journalEntryId: row.journal_entry_id,
    claimedAt: row.claimed_at,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    statusProblem: row.status_problem,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type NewScheduledReply = Pick<
  StoredScheduledReply,
  | "tenantId"
  | "agentId"
  | "ticketId"
  | "subject"
  | "recipient"
  | "bodyHtml"
  | "ccEmails"
  | "sendAt"
  | "thenStatusId"
  | "baselineStartedAt"
  | "baselineAssignee"
  | "baselineStatus"
  | "connectionGeneration"
>;

export async function insertScheduledReply(reply: NewScheduledReply): Promise<string> {
  const db = await getDb();
  const id = crypto.randomUUID();
  const now = nowSeconds();
  await db.execute(
    `INSERT INTO freshdesk_scheduled_replies
       (reply_id, tenant_id, agent_id, ticket_id, subject, recipient, body_html, cc_json, send_at, then_status_id,
        baseline_started_at, baseline_assignee, baseline_status, connection_generation, state, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'pending', $15, $15)`,
    [
      id,
      reply.tenantId,
      reply.agentId,
      reply.ticketId,
      reply.subject,
      reply.recipient,
      reply.bodyHtml,
      JSON.stringify(reply.ccEmails),
      reply.sendAt,
      reply.thenStatusId,
      reply.baselineStartedAt,
      reply.baselineAssignee,
      reply.baselineStatus,
      reply.connectionGeneration,
      now,
    ],
  );
  return id;
}

export async function getScheduledReply(replyId: string): Promise<StoredScheduledReply | null> {
  const db = await getDb();
  const rows = await db.select<Row[]>("SELECT * FROM freshdesk_scheduled_replies WHERE reply_id = $1", [replyId]);
  return rows[0] ? fromRow(rows[0]) : null;
}

/** Every Scheduled reply of one helpdesk, soonest first */
export async function getScheduledReplies(tenantId: string): Promise<StoredScheduledReply[]> {
  const db = await getDb();
  const rows = await db.select<Row[]>(
    "SELECT * FROM freshdesk_scheduled_replies WHERE tenant_id = $1 ORDER BY send_at, created_at",
    [tenantId],
  );
  return rows.map(fromRow);
}

export async function getScheduledRepliesInState(tenantId: string, state: ScheduledReplyState): Promise<StoredScheduledReply[]> {
  const db = await getDb();
  const rows = await db.select<Row[]>(
    "SELECT * FROM freshdesk_scheduled_replies WHERE tenant_id = $1 AND state = $2 ORDER BY send_at",
    [tenantId, state],
  );
  return rows.map(fromRow);
}

/** Pending replies that are due and past any retry backoff */
export async function getDueScheduledReplies(tenantId: string, now: number): Promise<StoredScheduledReply[]> {
  const db = await getDb();
  const rows = await db.select<Row[]>(
    `SELECT * FROM freshdesk_scheduled_replies
     WHERE tenant_id = $1 AND state = 'pending' AND send_at <= $2 AND (next_attempt_at IS NULL OR next_attempt_at <= $2)
     ORDER BY send_at`,
    [tenantId, now],
  );
  return rows.map(fromRow);
}

/** Unconfirmed replies whose next Reconciliation is due */
export async function getUnconfirmedRepliesToCheck(tenantId: string, now: number): Promise<StoredScheduledReply[]> {
  const db = await getDb();
  const rows = await db.select<Row[]>(
    `SELECT * FROM freshdesk_scheduled_replies
     WHERE tenant_id = $1 AND state = 'unconfirmed' AND next_attempt_at IS NOT NULL AND next_attempt_at <= $2
     ORDER BY send_at`,
    [tenantId, now],
  );
  return rows.map(fromRow);
}

/**
 * Moves a reply from one of `from` to `to` only if it is still there, so two
 * runs (or a run and the operator) never both act on it. True when it moved.
 */
export async function moveScheduledReply(
  replyId: string,
  from: ScheduledReplyState[],
  to: ScheduledReplyState,
  changes: Partial<
    Pick<
      StoredScheduledReply,
      | "holdReasons"
      | "journalEntryId"
      | "claimedAt"
      | "attempts"
      | "nextAttemptAt"
      | "lastError"
      | "statusProblem"
      | "baselineStartedAt"
      | "baselineAssignee"
      | "baselineStatus"
    >
  > = {},
): Promise<boolean> {
  const db = await getDb();
  const columns: Record<string, unknown> = {
    hold_reasons_json: changes.holdReasons && JSON.stringify(changes.holdReasons),
    journal_entry_id: changes.journalEntryId,
    claimed_at: changes.claimedAt,
    attempts: changes.attempts,
    next_attempt_at: changes.nextAttemptAt,
    last_error: changes.lastError,
    status_problem: changes.statusProblem,
    baseline_started_at: changes.baselineStartedAt,
    baseline_assignee: changes.baselineAssignee,
    baseline_status: changes.baselineStatus,
  };
  const set = Object.entries(columns).filter(([, v]) => v !== undefined);
  const params: unknown[] = [to, nowSeconds(), ...set.map(([, v]) => v), replyId, ...from];
  const assignments = set.map(([c], i) => `, ${c} = $${i + 3}`).join("");
  const idParam = set.length + 3;
  const fromParams = from.map((_, i) => `$${idParam + 1 + i}`).join(", ");
  const result = await db.execute(
    `UPDATE freshdesk_scheduled_replies SET state = $1, updated_at = $2${assignments}
     WHERE reply_id = $${idParam} AND state IN (${fromParams})`,
    params,
  );
  return result.rowsAffected > 0;
}

/**
 * Pins a still-editable reply to a new connection generation of the same helpdesk.
 * True when this call stored `generation`. A reply already on that generation, or no longer in `from`, is left alone.
 */
export async function rememberScheduledReplyGeneration(
  replyId: string,
  from: ScheduledReplyState[],
  generation: string,
): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute(
    `UPDATE freshdesk_scheduled_replies SET connection_generation = $1, updated_at = $2
     WHERE reply_id = $3 AND connection_generation != $1 AND state IN (${from.map((_, i) => `$${i + 4}`).join(", ")})`,
    [generation, nowSeconds(), replyId, ...from],
  );
  return result.rowsAffected > 0;
}

/** Removes a reply that is in one of `from`; true when it was removed */
export async function deleteScheduledReply(replyId: string, from: ScheduledReplyState[]): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute(
    `DELETE FROM freshdesk_scheduled_replies WHERE reply_id = $1 AND state IN (${from.map((_, i) => `$${i + 2}`).join(", ")})`,
    [replyId, ...from],
  );
  return result.rowsAffected > 0;
}
