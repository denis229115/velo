import { useCallback, useEffect, useState } from "react";
import { CalendarClock } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import {
  cancelScheduledEmail,
  listScheduledEmails,
  type ScheduledEmailWithAccount,
} from "@/services/db/scheduledEmails";
import {
  retryFailedScheduledEmail,
  SCHEDULED_EMAILS_CHANGED_EVENT,
} from "@/services/snooze/scheduledSendManager";
import {
  cancelScheduledReply,
  checkScheduledReply,
  editScheduledReply,
  listScheduledReplies,
  SCHEDULED_REPLIES_CHANGED_EVENT,
  sendScheduledReplyNow,
  type ScheduledReply,
} from "@/services/freshdesk/scheduledReplies";
import { getStatusClassification } from "@/services/freshdesk/connection";
import { useFreshdeskWritable } from "@/components/freshdesk/useFreshdeskWritable";
import { navigateToTicket } from "@/router/navigate";
import { ScheduledList, type ScheduledAction, type ScheduledListItem, type ScheduledStatus } from "./ScheduledList";
import { formatAttachmentSize } from "@/services/freshdesk/replyAttachments";

function sourceOf(email: ScheduledEmailWithAccount): string {
  const account = email.account_email ?? "Removed email account";
  return email.from_email && email.from_email !== email.account_email
    ? `${email.from_email} (via ${account})`
    : account;
}

function toListItem(email: ScheduledEmailWithAccount): ScheduledListItem {
  return {
    id: email.id,
    title: email.subject || "(no subject)",
    recipients: email.to_addresses,
    source: sourceOf(email),
    status: email.status as ScheduledStatus,
    sendAt: email.scheduled_at,
    error: email.status === "failed" ? email.last_error : null,
  };
}

const REPLY_ACTIONS: Record<ScheduledStatus, ScheduledAction[]> = {
  pending: ["edit", "cancel"],
  held: ["send_anyway", "edit", "cancel"],
  failed: ["retry", "edit", "cancel"],
  unconfirmed: ["check"],
  sending: [],
  sent: [],
};

function replyDetail(reply: ScheduledReply, statusLabels: Map<string, string>): string | null {
  if (reply.statusProblem) return `Reply sent; the status was not changed: ${reply.statusProblem}`;
  if (reply.thenStatusId === null || reply.state === "sent") return null;
  const label = statusLabels.get(reply.thenStatusId) ?? "the chosen status";
  return `Then set ${label}, once Freshdesk confirms the reply`;
}

/** The files kept with the reply and the status to set, in one line */
function replyDetails(reply: ScheduledReply, statusLabels: Map<string, string>): string | null {
  const files =
    reply.attachments.length > 0 && reply.state !== "sent"
      ? `With ${reply.attachments.map((a) => `${a.name} (${formatAttachmentSize(a.size)})`).join(", ")}`
      : null;
  return [files, replyDetail(reply, statusLabels)].filter(Boolean).join(" · ") || null;
}

function toReplyItem(reply: ScheduledReply, statusLabels: Map<string, string>, remoteBlocked: string | null): ScheduledListItem {
  return {
    id: reply.id,
    title: reply.subject || `Ticket #${reply.ticketId}`,
    recipients: reply.recipient || "the customer",
    source: `Freshdesk · #${reply.ticketId}`,
    status: reply.state,
    sendAt: reply.sendAt,
    error: reply.state === "failed" || reply.state === "unconfirmed" ? reply.error : null,
    reasons: reply.state === "held" ? reply.holdReasons : [],
    detail: replyDetails(reply, statusLabels),
    actions: REPLY_ACTIONS[reply.state],
    remoteBlocked,
  };
}

export function ScheduledEmailsPage() {
  const [items, setItems] = useState<ScheduledListItem[] | null>(null);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [replies, setReplies] = useState<ScheduledReply[]>([]);
  const [statusLabels, setStatusLabels] = useState<Map<string, string>>(new Map());
  const writable = useFreshdeskWritable();

  const load = useCallback(async () => {
    const [emails, ticketReplies, classification] = await Promise.all([
      listScheduledEmails(),
      listScheduledReplies(),
      getStatusClassification(),
    ]);
    setItems(emails.map(toListItem));
    setReplies(ticketReplies);
    setStatusLabels(new Map(classification.statuses.map((s) => [s.id, s.label])));
  }, []);

  /** Run a cancel or retry for one item, keeping its buttons disabled meanwhile. */
  const runFor = useCallback(async (id: string, action: () => Promise<string | null>) => {
    setBusyIds((prev) => new Set(prev).add(id));
    setNotice(null);
    try {
      setNotice(await action());
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      await load();
    }
  }, [load]);

  const handleCancel = useCallback((id: string) => runFor(id, async () => {
    const cancelled = await cancelScheduledEmail(id);
    return cancelled ? null : "This email is already sending or done, so it can no longer be cancelled.";
  }), [runFor]);

  const handleRetry = useCallback((id: string) => runFor(id, async () => {
    const outcome = await retryFailedScheduledEmail(id);
    // A failed retry's error shows on the email itself
    return outcome.status === "not-retried" ? outcome.reason : null;
  }), [runFor]);

  const handleReplyCancel = useCallback((id: string) => runFor(id, async () => {
    const cancelled = await cancelScheduledReply(id);
    return cancelled ? null : "This reply is already on its way or done, so it can no longer be cancelled.";
  }), [runFor]);

  const handleReplyEdit = useCallback((id: string) => runFor(id, async () => {
    const result = await editScheduledReply(id);
    if (!result.ok) return result.message;
    navigateToTicket(result.ticketId);
    return null;
  }), [runFor]);

  const handleReplySend = useCallback((id: string) => runFor(id, () => sendScheduledReplyNow(id)), [runFor]);
  const handleReplyCheck = useCallback((id: string) => runFor(id, () => checkScheduledReply(id)), [runFor]);

  useEffect(() => {
    void load();
    const reload = () => void load();
    window.addEventListener(SCHEDULED_EMAILS_CHANGED_EVENT, reload);
    window.addEventListener(SCHEDULED_REPLIES_CHANGED_EVENT, reload);
    return () => {
      window.removeEventListener(SCHEDULED_EMAILS_CHANGED_EVENT, reload);
      window.removeEventListener(SCHEDULED_REPLIES_CHANGED_EVENT, reload);
    };
  }, [load]);

  const replyItems = replies.map((r) => toReplyItem(r, statusLabels, writable.reason));
  const total = items ? items.length + replyItems.length : null;
  const sectionHeading = "px-4 pt-3 pb-1 text-xs font-medium uppercase tracking-wide text-text-tertiary";

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      <div className="shrink-0 px-4 py-3 border-b border-border-primary">
        <div className="flex items-center gap-2">
          <CalendarClock size={18} className="text-text-secondary" />
          <h1 className="text-base font-semibold text-text-primary">Scheduled</h1>
          {total !== null && <span className="text-xs text-text-tertiary">({total})</span>}
        </div>
        {notice && (
          <p role="status" className="mt-2 text-xs text-text-secondary">{notice}</p>
        )}
      </div>
      <div className="flex-1 overflow-y-auto">
        {total === 0 ? (
          <EmptyState
            icon={CalendarClock}
            title="Nothing scheduled"
            subtitle="Emails you send later and scheduled ticket replies appear here until they go out."
          />
        ) : items ? (
          <>
            {items.length > 0 && (
              <section aria-label="Scheduled emails">
                {replyItems.length > 0 && <h2 className={sectionHeading}>Emails</h2>}
                <ScheduledList items={items} busyIds={busyIds} onCancel={handleCancel} onRetry={handleRetry} />
              </section>
            )}
            {replyItems.length > 0 && (
              <section aria-label="Scheduled ticket replies">
                <h2 className={sectionHeading}>Ticket replies</h2>
                <ScheduledList
                  items={replyItems}
                  busyIds={busyIds}
                  onCancel={handleReplyCancel}
                  onRetry={handleReplySend}
                  onEdit={handleReplyEdit}
                  onSendAnyway={handleReplySend}
                  onCheck={handleReplyCheck}
                />
              </section>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}
