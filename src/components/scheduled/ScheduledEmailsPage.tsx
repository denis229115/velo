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
import { ScheduledList, type ScheduledListItem, type ScheduledStatus } from "./ScheduledList";

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

export function ScheduledEmailsPage() {
  const [items, setItems] = useState<ScheduledListItem[] | null>(null);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const emails = await listScheduledEmails();
    setItems(emails.map(toListItem));
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

  useEffect(() => {
    void load();
    const reload = () => void load();
    window.addEventListener(SCHEDULED_EMAILS_CHANGED_EVENT, reload);
    return () => window.removeEventListener(SCHEDULED_EMAILS_CHANGED_EVENT, reload);
  }, [load]);

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      <div className="shrink-0 px-4 py-3 border-b border-border-primary">
        <div className="flex items-center gap-2">
          <CalendarClock size={18} className="text-text-secondary" />
          <h1 className="text-base font-semibold text-text-primary">Scheduled</h1>
          {items && <span className="text-xs text-text-tertiary">({items.length})</span>}
        </div>
        {notice && (
          <p role="status" className="mt-2 text-xs text-text-secondary">{notice}</p>
        )}
      </div>
      <div className="flex-1 overflow-y-auto">
        {items && items.length === 0 ? (
          <EmptyState
            icon={CalendarClock}
            title="No scheduled emails"
            subtitle="Emails you send later appear here until they go out."
          />
        ) : items ? (
          <ScheduledList items={items} busyIds={busyIds} onCancel={handleCancel} onRetry={handleRetry} />
        ) : null}
      </div>
    </div>
  );
}
