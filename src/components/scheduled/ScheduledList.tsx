import { AlertCircle, CheckCircle2, Clock, Loader2, RotateCcw, X, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { formatFullDate } from "@/utils/date";

export type ScheduledStatus = "pending" | "sending" | "sent" | "failed";

/**
 * One item on a scheduled-sends list. Kept free of email specifics so
 * scheduled ticket replies can be listed the same way.
 */
export interface ScheduledListItem {
  id: string;
  title: string;
  recipients: string;
  /** Where it sends from, e.g. the email account address */
  source: string;
  status: ScheduledStatus;
  /** Unix seconds */
  sendAt: number;
  error: string | null;
}

const STATUS_DISPLAY: Record<ScheduledStatus, { label: string; icon: LucideIcon; className: string }> = {
  pending: { label: "Scheduled", icon: Clock, className: "text-text-secondary" },
  sending: { label: "Sending", icon: Loader2, className: "text-accent" },
  sent: { label: "Sent", icon: CheckCircle2, className: "text-success" },
  failed: { label: "Failed", icon: AlertCircle, className: "text-danger" },
};

interface ScheduledListProps {
  items: ScheduledListItem[];
  /** Items with a cancel or retry in flight; their buttons are disabled */
  busyIds: ReadonlySet<string>;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
}

export function ScheduledList({ items, busyIds, onCancel, onRetry }: ScheduledListProps) {
  return (
    <ul className="divide-y divide-border-secondary">
      {items.map((item) => {
        const status = STATUS_DISPLAY[item.status];
        const StatusIcon = status.icon;
        const busy = busyIds.has(item.id);
        return (
          <li key={item.id} className="flex items-start gap-3 px-4 py-2.5">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-sm font-medium text-text-primary truncate">{item.title}</span>
                <span className={`inline-flex items-center gap-1 text-xs shrink-0 ${status.className}`}>
                  <StatusIcon size={12} className={item.status === "sending" ? "animate-spin" : undefined} />
                  {status.label}
                </span>
              </div>
              <div className="flex items-center gap-2 text-xs text-text-tertiary min-w-0">
                <time dateTime={new Date(item.sendAt * 1000).toISOString()} className="shrink-0">
                  {formatFullDate(item.sendAt * 1000)}
                </time>
                <span aria-hidden>·</span>
                <span className="shrink-0">{item.source}</span>
                <span aria-hidden>·</span>
                <span className="truncate">To: {item.recipients}</span>
              </div>
              {item.error && (
                <p className="mt-1 text-xs text-danger break-words">{item.error}</p>
              )}
            </div>
            {item.status === "pending" && (
              <Button size="xs" variant="ghost" icon={<X size={12} />} disabled={busy} onClick={() => onCancel(item.id)}>
                Cancel
              </Button>
            )}
            {item.status === "failed" && (
              <Button size="xs" icon={<RotateCcw size={12} />} disabled={busy} onClick={() => onRetry(item.id)}>
                Retry
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
