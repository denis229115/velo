import { Bot, FileText, Globe, Lock, MessageSquare, Phone, Reply, ShieldQuestion, StickyNote, type LucideIcon } from "lucide-react";
import { Timestamp } from "@/components/ui/Timestamp";
import { formatRelative } from "@/utils/timeZone";
import type { ActivityTime, HistoryState } from "@/services/freshdesk/activity";
import type { EntryKind } from "@/services/freshdesk/ticketHistory";

/** Plain-text form of a metric, for row labels. */
export function activityText(time: ActivityTime, history: HistoryState, never: string, timeZone: string): string {
  if (time.state === "known") return formatRelative(time.at, Date.now(), timeZone);
  if (time.state === "never") return never;
  return history === "not_loaded" ? "loading" : "unknown";
}

/**
 * One activity metric: a time (hover for zones), the metric's own "never"
 * wording once history is complete, or Unknown / Loading before that.
 */
export function ActivityValue({
  time,
  history,
  never,
  focusable,
}: {
  time: ActivityTime;
  history: HistoryState;
  never: string;
  focusable?: boolean;
}) {
  if (time.state === "known") return <Timestamp at={time.at} focusable={focusable} />;
  if (time.state === "never") return <span>{never}</span>;
  return (
    <span
      className="text-text-tertiary italic"
      title={history === "not_loaded" ? "Conversation history is loading" : "Conversation history is not fully loaded, so this can't be decided yet"}
    >
      {history === "not_loaded" ? "Loading…" : "Unknown"}
    </span>
  );
}

export function NeedsReplyValue({ value, history }: { value: boolean | null; history: HistoryState }) {
  if (value === null) {
    return <span className="text-text-tertiary italic">{history === "not_loaded" ? "Loading…" : "Unknown"}</span>;
  }
  return value ? <span className="font-medium text-status-warning">Yes</span> : <span>No</span>;
}

interface KindStyle {
  label: string;
  icon: LucideIcon;
  tone: string;
}

const PUBLIC_TONE = "border-border-primary bg-transparent text-text-secondary";
const AGENT_TONE = "border-status-success/40 bg-status-success/10 text-status-success";
const INTERNAL_TONE = "border-status-warning/40 bg-status-warning/10 text-status-warning";
const ALERT_TONE = "border-status-error/40 bg-status-error/10 text-status-error";

export const ENTRY_KINDS: Record<EntryKind, KindStyle> = {
  request: { label: "Original request", icon: FileText, tone: PUBLIC_TONE },
  reply: { label: "Public reply", icon: Reply, tone: AGENT_TONE },
  automated_reply: { label: "Automated reply", icon: Bot, tone: PUBLIC_TONE },
  unverified_reply: { label: "Public reply, author not verified", icon: ShieldQuestion, tone: ALERT_TONE },
  public_note: { label: "Public note", icon: Globe, tone: PUBLIC_TONE },
  internal_note: { label: "Internal note", icon: Lock, tone: INTERNAL_TONE },
  logged_interaction: { label: "Logged interaction", icon: Phone, tone: PUBLIC_TONE },
  customer_message: { label: "Customer", icon: MessageSquare, tone: PUBLIC_TONE },
  incoming_from_agent: { label: "Agent, by email", icon: StickyNote, tone: PUBLIC_TONE },
};

/** What an entry is; colour is never the only cue (each badge has a label and an icon). */
export function EntryKindBadge({ kind }: { kind: EntryKind }) {
  const { label, icon: Icon, tone } = ENTRY_KINDS[kind];
  return (
    <span className={`inline-flex items-center gap-1 shrink-0 rounded-md border px-1.5 py-px text-micro font-medium ${tone}`}>
      <Icon size={11} aria-hidden className="shrink-0" />
      <span data-testid="entry-kind">{label}</span>
    </span>
  );
}
