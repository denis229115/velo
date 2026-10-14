import { ChevronDown, ChevronUp, ChevronsUp, Circle, CircleCheck, CircleDot, CircleHelp, Clock, Equal, ListChecks, type LucideIcon } from "lucide-react";
import type { LinkedWorkSummary } from "@/services/clickup/links";
import type { TicketListItem, TicketStatusInfo } from "@/services/freshdesk/ticketSync";

type Tone = "open" | "waiting" | "done" | "neutral" | "alert";

// Status tokens from the theme; each badge also carries its text label and an icon, so colour is never the only cue
const TONES: Record<Tone, string> = {
  open: "border-status-warning/40 bg-status-warning/10 text-status-warning",
  waiting: "border-border-primary bg-surface-subtle text-text-secondary",
  done: "border-status-success/40 bg-status-success/10 text-status-success",
  neutral: "border-border-primary bg-transparent text-text-secondary",
  alert: "border-status-error/40 bg-status-error/10 text-status-error",
};

function Badge({ tone, icon: Icon, label, title }: { tone: Tone; icon: LucideIcon; label: string; title: string }) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 max-w-[11rem] shrink-0 rounded-md border px-1.5 py-px text-micro font-medium ${TONES[tone]}`}
    >
      <Icon size={11} aria-hidden className="shrink-0" />
      <span className="truncate">{label}</span>
    </span>
  );
}

const CLASS_NAMES = { open: "Open", waiting: "Waiting", done: "Done" } as const;

/** Freshdesk's exact status label, toned by the operator's status class. */
export function TicketStatusBadge({ status }: { status: TicketStatusInfo }) {
  if (!status.known || status.label === null) {
    return (
      <Badge
        tone="alert"
        icon={CircleHelp}
        label="Unknown status"
        title={`Status ID ${status.id} is not one of this helpdesk's statuses. It counts as Outstanding.`}
      />
    );
  }
  const cls = status.statusClass;
  const title = cls ? `Status: ${status.label} (status class ${CLASS_NAMES[cls]})` : `Status: ${status.label} (not classified yet; counts as Outstanding)`;
  if (cls === "open") return <Badge tone="open" icon={CircleDot} label={status.label} title={title} />;
  if (cls === "waiting") return <Badge tone="waiting" icon={Clock} label={status.label} title={title} />;
  if (cls === "done") return <Badge tone="done" icon={CircleCheck} label={status.label} title={title} />;
  return <Badge tone="neutral" icon={Circle} label={status.label} title={title} />;
}

// Freshdesk's priority IDs are fixed (1 Low … 4 Urgent); the label is still the helpdesk's own
const PRIORITY_STYLE: Record<string, { tone: Tone; icon: LucideIcon }> = {
  "4": { tone: "alert", icon: ChevronsUp },
  "3": { tone: "open", icon: ChevronUp },
  "2": { tone: "neutral", icon: Equal },
  "1": { tone: "neutral", icon: ChevronDown },
};

export function TicketPriorityBadge({ priority }: { priority: NonNullable<TicketListItem["priority"]> }) {
  const style = PRIORITY_STYLE[priority.id] ?? { tone: "neutral" as const, icon: Equal };
  return <Badge tone={style.tone} icon={style.icon} label={priority.label} title={`Priority: ${priority.label}`} />;
}

/** Linked ClickUp tasks on a ticket; toned done when every linked task is done. */
export function LinkedWorkBadge({ summary }: { summary: LinkedWorkSummary }) {
  const label = `${summary.count} task${summary.count === 1 ? "" : "s"}`;
  const allDone = summary.done === summary.count;
  const title = `Linked ClickUp tasks: ${summary.count}${summary.done > 0 ? ` (${summary.done} done)` : ""}`;
  return <Badge tone={allDone ? "done" : "neutral"} icon={allDone ? CircleCheck : ListChecks} label={label} title={title} />;
}
