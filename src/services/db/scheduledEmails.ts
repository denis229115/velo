import { getDb } from "./connection";
import { getCurrentUnixTimestamp } from "@/utils/timestamp";
import type { EmailAttachment } from "@/utils/emailBuilder";

export interface DbScheduledEmail {
  id: string;
  account_id: string;
  to_addresses: string;
  cc_addresses: string | null;
  bcc_addresses: string | null;
  subject: string | null;
  body_html: string;
  reply_to_message_id: string | null;
  thread_id: string | null;
  scheduled_at: number;
  signature_id: string | null;
  attachment_paths: string | null;
  status: string;
  created_at: number;
  attempts: number;
  next_attempt_at: number | null;
  last_error: string | null;
  /** Send-as alias chosen in the composer; null sends from the account address */
  from_email: string | null;
}

export async function getPendingScheduledEmails(): Promise<DbScheduledEmail[]> {
  const db = await getDb();
  const now = getCurrentUnixTimestamp();
  return db.select<DbScheduledEmail[]>(
    `SELECT * FROM scheduled_emails
     WHERE status = 'pending' AND scheduled_at <= $1
       AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
     ORDER BY scheduled_at ASC`,
    [now],
  );
}

export async function getScheduledEmailsForAccount(
  accountId: string,
): Promise<DbScheduledEmail[]> {
  const db = await getDb();
  return db.select<DbScheduledEmail[]>(
    "SELECT * FROM scheduled_emails WHERE account_id = $1 AND status = 'pending' ORDER BY scheduled_at ASC",
    [accountId],
  );
}

export interface ScheduledEmailWithAccount extends DbScheduledEmail {
  /** Address of the email account it sends through; null if the account was removed */
  account_email: string | null;
}

/** How many sent scheduled emails the scheduled emails screen keeps showing. */
const RECENT_SENT_LIMIT = 50;

/**
 * Every scheduled email the operator can see: anything not yet sent (failed
 * first, then by send time) followed by the most recently sent ones.
 */
export async function listScheduledEmails(): Promise<ScheduledEmailWithAccount[]> {
  const db = await getDb();
  const open = await db.select<ScheduledEmailWithAccount[]>(
    `SELECT s.*, a.email AS account_email FROM scheduled_emails s
     LEFT JOIN accounts a ON a.id = s.account_id
     WHERE s.status IN ('pending', 'sending', 'failed')
     ORDER BY CASE s.status WHEN 'failed' THEN 0 WHEN 'sending' THEN 1 ELSE 2 END, s.scheduled_at ASC`,
  );
  const sent = await db.select<ScheduledEmailWithAccount[]>(
    `SELECT s.*, a.email AS account_email FROM scheduled_emails s
     LEFT JOIN accounts a ON a.id = s.account_id
     WHERE s.status = 'sent'
     ORDER BY s.scheduled_at DESC LIMIT $1`,
    [RECENT_SENT_LIMIT],
  );
  return [...open, ...sent];
}

export async function insertScheduledEmail(email: {
  accountId: string;
  toAddresses: string;
  ccAddresses: string | null;
  bccAddresses: string | null;
  subject: string | null;
  bodyHtml: string;
  replyToMessageId: string | null;
  threadId: string | null;
  scheduledAt: number;
  signatureId: string | null;
  /** Send-as alias chosen in the composer; null or omitted sends from the account address */
  fromEmail?: string | null;
  /** Stored in the same INSERT as the row so concurrent schedules can't mix them up */
  attachments?: EmailAttachment[];
}): Promise<string> {
  const db = await getDb();
  const id = crypto.randomUUID();
  const attachmentData =
    email.attachments && email.attachments.length > 0
      ? JSON.stringify(email.attachments)
      : null;
  await db.execute(
    `INSERT INTO scheduled_emails (id, account_id, to_addresses, cc_addresses, bcc_addresses, subject, body_html, reply_to_message_id, thread_id, scheduled_at, signature_id, attachment_paths, from_email)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      id,
      email.accountId,
      email.toAddresses,
      email.ccAddresses,
      email.bccAddresses,
      email.subject,
      email.bodyHtml,
      email.replyToMessageId,
      email.threadId,
      email.scheduledAt,
      email.signatureId,
      attachmentData,
      email.fromEmail ?? null,
    ],
  );
  return id;
}

export async function getScheduledEmailsInStatus(
  status: "pending" | "sending" | "sent" | "failed" | "cancelled",
): Promise<DbScheduledEmail[]> {
  const db = await getDb();
  return db.select<DbScheduledEmail[]>(
    "SELECT * FROM scheduled_emails WHERE status = $1 ORDER BY scheduled_at ASC",
    [status],
  );
}

export async function getScheduledEmail(id: string): Promise<DbScheduledEmail | null> {
  const db = await getDb();
  const rows = await db.select<DbScheduledEmail[]>(
    "SELECT * FROM scheduled_emails WHERE id = $1",
    [id],
  );
  return rows[0] ?? null;
}

/**
 * Atomically move a pending (or, for a manual retry, failed) row to "sending".
 * Returns false if another run already claimed it, so the same row is never
 * sent twice concurrently.
 */
export async function claimScheduledEmail(
  id: string,
  fromStatus: "pending" | "failed" = "pending",
): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute(
    "UPDATE scheduled_emails SET status = 'sending', attempts = attempts + 1 WHERE id = $1 AND status = $2",
    [id, fromStatus],
  );
  return result.rowsAffected === 1;
}

/**
 * Record a failed send: back to "pending" with a retry time, or terminal
 * "failed" when nextAttemptAt is null.
 */
export async function recordScheduledEmailFailure(
  id: string,
  error: string,
  nextAttemptAt: number | null,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE scheduled_emails SET status = $1, next_attempt_at = $2, last_error = $3 WHERE id = $4",
    [nextAttemptAt === null ? "failed" : "pending", nextAttemptAt, error, id],
  );
}

export async function updateScheduledEmailStatus(
  id: string,
  status: "pending" | "sending" | "sent" | "failed" | "cancelled",
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE scheduled_emails SET status = $1 WHERE id = $2",
    [status, id],
  );
}

/**
 * Cancel a scheduled email that has not started sending. Returns false if
 * it is no longer pending (already sending, sent or failed), leaving it as is.
 */
export async function cancelScheduledEmail(id: string): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute(
    "DELETE FROM scheduled_emails WHERE id = $1 AND status = 'pending'",
    [id],
  );
  return result.rowsAffected === 1;
}

export async function deleteScheduledEmail(id: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM scheduled_emails WHERE id = $1", [id]);
}
