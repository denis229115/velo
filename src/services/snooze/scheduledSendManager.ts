import {
  getPendingScheduledEmails,
  getScheduledEmail,
  getScheduledEmailsInStatus,
  claimScheduledEmail,
  recordScheduledEmailFailure,
  updateScheduledEmailStatus,
  type DbScheduledEmail,
} from "../db/scheduledEmails";
import { getEmailProvider } from "../email/providerFactory";
import { buildRawEmail, type EmailAttachment } from "@/utils/emailBuilder";
import { getAccount } from "../db/accounts";
import { hasMessageWithIdHeader } from "../db/messages";
import { createBackgroundChecker } from "../backgroundCheckers";
import { notifyScheduledSendFailed } from "../notifications/notificationManager";
import { getCurrentUnixTimestamp } from "@/utils/timestamp";
import { useUIStore } from "@/stores/uiStore";

/** Window event fired whenever scheduled emails are added or change status. */
export const SCHEDULED_EMAILS_CHANGED_EVENT = "velo-scheduled-emails-changed";

export function announceScheduledEmailsChanged(): void {
  window.dispatchEvent(new Event(SCHEDULED_EMAILS_CHANGED_EVENT));
}

/** Total send attempts before a scheduled email is marked failed. */
export const MAX_SEND_ATTEMPTS = 5;

/** Seconds to wait before attempt n+1, indexed by attempts made so far minus one. */
const RETRY_BACKOFF_SECONDS = [60, 300, 900, 3600];

function splitAddresses(value: string | null): string[] | undefined {
  if (!value) return undefined;
  return value.split(",").map((a) => a.trim()).filter(Boolean);
}

function parseAttachments(email: DbScheduledEmail): EmailAttachment[] | undefined {
  if (!email.attachment_paths) return undefined;
  try {
    return JSON.parse(email.attachment_paths) as EmailAttachment[];
  } catch {
    console.warn(`Failed to parse attachment_paths for scheduled email ${email.id}`);
    return undefined;
  }
}

/**
 * Every attempt for a scheduled email carries the same Message-ID, so a copy
 * that reached the mailbox can be recognised before anything is sent again.
 */
function scheduledMessageId(email: DbScheduledEmail, fromEmail: string): string {
  const domain = fromEmail.includes("@") ? fromEmail.split("@")[1] : "velomail.local";
  return `<scheduled.${email.id}@${domain}>`;
}

/** The send-as alias chosen in the composer, else the account's own address. */
function senderOf(email: DbScheduledEmail, accountEmail: string): string {
  return email.from_email ?? accountEmail;
}

async function wentOut(email: DbScheduledEmail, fromEmail: string): Promise<boolean> {
  return hasMessageWithIdHeader(email.account_id, scheduledMessageId(email, fromEmail));
}

async function failPermanently(email: DbScheduledEmail, reason: string): Promise<void> {
  await recordScheduledEmailFailure(email.id, reason, null);
  notifyScheduledSendFailed(email.subject ?? "", reason);
}

/** Build the message from the stored row and hand it to the account's provider. */
async function deliver(email: DbScheduledEmail, from: string): Promise<void> {
  const provider = await getEmailProvider(email.account_id);
  const raw = buildRawEmail({
    from,
    to: splitAddresses(email.to_addresses) ?? [],
    cc: splitAddresses(email.cc_addresses),
    bcc: splitAddresses(email.bcc_addresses),
    subject: email.subject ?? "",
    htmlBody: email.body_html,
    inReplyTo: email.reply_to_message_id ?? undefined,
    threadId: email.thread_id ?? undefined,
    attachments: parseAttachments(email),
    messageId: scheduledMessageId(email, from),
  });
  await provider.sendMessage(raw, email.thread_id ?? undefined);
}

async function sendScheduledEmail(email: DbScheduledEmail): Promise<void> {
  const account = await getAccount(email.account_id);
  if (!account) {
    await failPermanently(email, "The email account no longer exists in Velo.");
    return;
  }

  const from = senderOf(email, account.email);

  // A timed-out earlier attempt may have been delivered after all
  if (email.attempts > 0 && (await wentOut(email, from))) {
    await updateScheduledEmailStatus(email.id, "sent");
    return;
  }

  if (!(await claimScheduledEmail(email.id))) return;
  const attemptsMade = email.attempts + 1;

  try {
    await deliver(email, from);
    await updateScheduledEmailStatus(email.id, "sent");
  } catch (err) {
    console.error(`Failed to send scheduled email ${email.id}:`, err);
    const reason = err instanceof Error ? err.message : String(err);
    const backoff = RETRY_BACKOFF_SECONDS[attemptsMade - 1];
    if (attemptsMade >= MAX_SEND_ATTEMPTS || backoff === undefined) {
      await failPermanently(email, reason);
    } else {
      await recordScheduledEmailFailure(email.id, reason, getCurrentUnixTimestamp() + backoff);
    }
  }
}

/**
 * Send every scheduled email that is due (and past its retry backoff).
 * While offline nothing is attempted, so waiting doesn't use up retries.
 */
export async function processDueScheduledEmails(): Promise<void> {
  if (!useUIStore.getState().isOnline) return;
  const due = await getPendingScheduledEmails();
  for (const email of due) {
    await sendScheduledEmail(email);
  }
  if (due.length > 0) announceScheduledEmailsChanged();
}

/**
 * Startup reconciliation for rows a crash or quit left in "sending". They are
 * never sent again automatically: either the sent copy is found locally and
 * the row is marked sent, or it fails with a prompt to check Sent first.
 */
export async function recoverInterruptedScheduledSends(): Promise<void> {
  const interrupted = await getScheduledEmailsInStatus("sending");
  for (const email of interrupted) {
    const account = await getAccount(email.account_id);
    if (account && (await wentOut(email, senderOf(email, account.email)))) {
      await updateScheduledEmailStatus(email.id, "sent");
    } else {
      await failPermanently(
        email,
        "Velo closed while this email was sending, so it may not have gone out. Check your Sent folder before sending it again.",
      );
    }
  }
  if (interrupted.length > 0) announceScheduledEmailsChanged();
}

export type RetryOutcome =
  | { status: "sent" }
  | { status: "failed"; error: string }
  /** Nothing was attempted; the email is left as it was */
  | { status: "not-retried"; reason: string };

/**
 * The operator's manual retry of a failed scheduled email: one attempt, with
 * the same Message-ID as before. If an earlier attempt is found to have gone
 * out, it is marked sent instead. A failed retry stays failed; it is never
 * retried automatically.
 */
export async function retryFailedScheduledEmail(id: string): Promise<RetryOutcome> {
  if (!useUIStore.getState().isOnline) {
    return { status: "not-retried", reason: "You're offline. Retry once you're back online." };
  }
  const email = await getScheduledEmail(id);
  if (!email || email.status !== "failed") {
    return { status: "not-retried", reason: "This email is no longer failed, so there is nothing to retry." };
  }
  const account = await getAccount(email.account_id);
  if (!account) {
    const error = "The email account no longer exists in Velo.";
    await recordScheduledEmailFailure(id, error, null);
    return { status: "failed", error };
  }

  const from = senderOf(email, account.email);
  if (email.attempts > 0 && (await wentOut(email, from))) {
    await updateScheduledEmailStatus(id, "sent");
    return { status: "sent" };
  }

  if (!(await claimScheduledEmail(id, "failed"))) {
    return { status: "not-retried", reason: "This email is already being retried." };
  }
  try {
    await deliver(email, from);
    await updateScheduledEmailStatus(id, "sent");
    return { status: "sent" };
  } catch (err) {
    console.error(`Retry of scheduled email ${id} failed:`, err);
    const error = err instanceof Error ? err.message : String(err);
    await recordScheduledEmailFailure(id, error, null);
    return { status: "failed", error };
  }
}

let recoveredThisSession = false;

async function runScheduledSends(): Promise<void> {
  if (!recoveredThisSession) {
    recoveredThisSession = true;
    await recoverInterruptedScheduledSends();
  }
  await processDueScheduledEmails();
}

const scheduledSendChecker = createBackgroundChecker("ScheduledSend", runScheduledSends);
export const startScheduledSendChecker = scheduledSendChecker.start;
export const stopScheduledSendChecker = scheduledSendChecker.stop;
