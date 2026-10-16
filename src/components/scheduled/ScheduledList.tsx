import { AlertCircle, CheckCircle2, Clock, HelpCircle, Loader2, PauseCircle, Pencil, RotateCcw, Send, X, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { formatFullDate } from "@/utils/date";

export type ScheduledStatus = "pending" | "sending" | "sent" | "failed" | "held" | "unconfirmed";

/** What the operator can do with an item; reaching the remote service is marked by `remote` below */
export type ScheduledAction = "cancel" | "retry" | "edit" | "send_anyway" | "check";

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
  /** Why it waits for the operator (a Held item), one line each */
  reasons?: string[];
  /** A secondary line, e.g. what happens after sending or a partial success */
  detail?: string | null;
  /** Defaults: Cancel while pending, Retry once failed */
  actions?: ScheduledAction[];
  /** Why actions that reach the remote service are off right now (offline, sample data) */
  remoteBlocked?: string | null;
}

const STATUS_DISPLAY: Record<ScheduledStatus, { label: string; icon: LucideIcon; className: string }> = {
  pending: { label: "Scheduled", icon: Clock, className: "text-text-secondary" },
  sending: { label: "Sending", icon: Loader2, className: "text-accent" },
  sent: { label: "Sent", icon: CheckCircle2, className: "text-success" },
  failed: { label: "Failed", icon: AlertCircle, className: "text-danger" },
  held: { label: "On hold – ticket changed", icon: PauseCircle, className: "text-status-warning" },
  unconfirmed: { label: "Unconfirmed", icon: HelpCircle, className: "text-status-warning" },
};

const DEFAULT_ACTIONS: Partial<Record<ScheduledStatus, ScheduledAction[]>> = {
  pending: ["cancel"],
  failed: ["retry"],
};

const REMOTE: ReadonlySet<ScheduledAction> = new Set(["retry", "send_anyway", "check"]);

interface ScheduledListProps {
  items: ScheduledListItem[];
  /** Items with an action in flight; their buttons are disabled */
  busyIds: ReadonlySet<string>;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onEdit?: (id: string) => void;
  onSendAnyway?: (id: string) => void;
  onCheck?: (id: string) => void;
}

export function ScheduledList({ items, busyIds, onCancel, onRetry, onEdit, onSendAnyway, onCheck }: ScheduledListProps) {
  const buttons: Record<ScheduledAction, { label: string; icon: ReactNode; primary?: boolean; run?: (id: string) => void }> = {
    send_anyway: { label: "Send anyway", icon: <Send size={12} />, primary: true, run: onSendAnyway },
    retry: { label: "Retry", icon: <RotateCcw size={12} />, primary: true, run: onRetry },
    check: { label: "Check Freshdesk", icon: <HelpCircle size={12} />, run: onCheck },
    edit: { label: "Edit", icon: <Pencil size={12} />, run: onEdit },
    cancel: { label: "Cancel", icon: <X size={12} />, run: onCancel },
  };
  return (
    <ul className="divide-y divide-border-secondary">
      {items.map((item) => {
        const status = STATUS_DISPLAY[item.status];
        const StatusIcon = status.icon;
        const busy = busyIds.has(item.id);
        const actions = item.actions ?? DEFAULT_ACTIONS[item.status] ?? [];
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
              {item.reasons && item.reasons.length > 0 && (
                <ul aria-label="Why it is on hold" className="mt-1 list-disc pl-4 text-xs text-text-primary">
                  {item.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              )}
              {item.detail && <p className="mt-0.5 text-xs text-text-secondary break-words">{item.detail}</p>}
              {item.error && (
                <p className="mt-1 text-xs text-danger break-words">{item.error}</p>
              )}
            </div>
            {actions.length > 0 && (
              <div className="flex shrink-0 items-center gap-1">
                {actions.map((action) => {
                  const button = buttons[action];
                  if (!button.run) return null;
                  const run = button.run;
                  const blocked = REMOTE.has(action) ? (item.remoteBlocked ?? null) : null;
                  return (
                    <Button
                      key={action}
                      size="xs"
                      variant={button.primary ? undefined : "ghost"}
                      icon={button.icon}
                      disabled={busy || blocked !== null}
                      title={blocked ?? undefined}
                      onClick={() => run(item.id)}
                    >
                      {button.label}
                    </Button>
                  );
                })}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
