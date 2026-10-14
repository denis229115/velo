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

/**
 * Atomically move a pending row to "sending". Returns false if another
 * run already claimed it, so the same row is never sent twice concurrently.
 */
export async function claimScheduledEmail(id: string): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute(
    "UPDATE scheduled_emails SET status = 'sending', attempts = attempts + 1 WHERE id = $1 AND status = 'pending'",
    [id],
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

export async function deleteScheduledEmail(id: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM scheduled_emails WHERE id = $1", [id]);
}
