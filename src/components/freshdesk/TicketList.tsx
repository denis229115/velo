import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ListChecks, MessageCircleWarning, RefreshCw, UserRound } from "lucide-react";
import { ListHeader, type ListTab } from "@/components/list/ListHeader";
import { ListRow } from "@/components/list/ListRow";
import { DateGroupHeader } from "@/components/list/DateGroupHeader";
import { groupByDate } from "@/utils/dateGroups";
import { formatFullDate } from "@/utils/date";
import { useUIStore } from "@/stores/uiStore";
import { selectVisibleTickets, useTicketStore, type TicketFilter } from "@/stores/ticketStore";
import { navigateToTicket } from "@/router/navigate";
import type { TicketListItem } from "@/services/freshdesk/ticketSync";
import { LinkedWorkBadge, TicketPriorityBadge, TicketStatusBadge } from "./TicketBadges";
import { TicketSyncBar } from "./TicketSyncBar";
import { ActivityValue, activityText } from "./TicketActivity";
import { useDisplayTimeZone } from "@/components/ui/Timestamp";

const TABS: (ListTab & { id: TicketFilter })[] = [
  { id: "outstanding", label: "Outstanding" },
  { id: "mine", label: "My open tickets" },
  { id: "all", label: "All downloaded" },
];

const EMPTY_TEXT: Record<TicketFilter, string> = {
  outstanding: "No outstanding tickets downloaded.",
  mine: "No open tickets assigned to you.",
  all: "No tickets downloaded yet.",
};

function rowLabel(t: TicketListItem, timeZone: string): string {
  const a = t.activity;
  return [
    `Ticket #${t.id}`,
    t.subject,
    `customer ${t.customer ?? "not loaded"}`,
    `status ${t.status.label ?? "Unknown status"}`,
    t.priority ? `priority ${t.priority.label}` : null,
    t.assignee ? `assigned to ${t.assignee}` : "unassigned",
    `last answered ${activityText(a.lastAnswered, a.history, "never answered", timeZone)}`,
    `last customer message ${activityText(a.lastCustomerMessage, a.history, "none", timeZone)}`,
    a.needsReply === true ? "needs reply" : null,
    `last updated ${formatFullDate(t.updatedAt)}`,
  ]
    .filter(Boolean)
    .join(", ");
}

function FindOlderTicket() {
  const findOlder = useTicketStore((s) => s.findOlder);
  const [value, setValue] = useState("");
  const [note, setNote] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim()) return;
    setNote("Fetching…");
    try {
      const id = await findOlder(value);
      if (id) {
        setValue("");
        setNote(null);
        navigateToTicket(id);
      } else {
        setNote("No ticket with that ID");
      }
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Couldn't fetch the ticket");
    }
  };

  return (
    <form onSubmit={submit} className="flex items-center gap-1.5">
      {note && <span className="text-micro text-text-tertiary max-w-[10rem] truncate" title={note}>{note}</span>}
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Ticket ID"
        aria-label="Fetch an older ticket by ID"
        title="Tickets outside the downloaded scope can be fetched by ID"
        inputMode="numeric"
        className="w-20 h-6 px-1.5 rounded-md border border-border-primary bg-transparent text-meta text-text-primary placeholder:text-text-tertiary"
      />
    </form>
  );
}

function NeedsReplyBadge() {
  return (
    <span
      title="Needs reply: the customer wrote after the last answer"
      className="inline-flex items-center gap-1 shrink-0 rounded-md border border-status-warning/40 bg-status-warning/10 px-1.5 py-px text-micro font-medium text-status-warning"
    >
      <MessageCircleWarning size={11} aria-hidden className="shrink-0" />
      Needs reply
    </span>
  );
}

/** Last answered, Last customer message and the assignee under the subject. */
function TicketRowDetails({ ticket: t }: { ticket: TicketListItem }) {
  const a = t.activity;
  return (
    <span className="inline-flex items-center gap-x-3 min-w-0">
      <span className="inline-flex items-center gap-1 shrink-0">
        <span className="text-text-tertiary">Answered</span>
        <ActivityValue time={a.lastAnswered} history={a.history} never="Never" focusable={false} />
      </span>
      <span className="inline-flex items-center gap-1 shrink-0">
        <span className="text-text-tertiary">Customer</span>
        <ActivityValue time={a.lastCustomerMessage} history={a.history} never="None" focusable={false} />
      </span>
      <span className="inline-flex items-center gap-1 min-w-0">
        <UserRound size={11} aria-hidden className="shrink-0" />
        <span className="truncate">{t.assignee ?? "Unassigned"}</span>
      </span>
    </span>
  );
}

export function TicketList({ selectedTicketId, width }: { selectedTicketId: string | null; width: number }) {
  const data = useTicketStore((s) => s.data);
  const filter = useTicketStore((s) => s.filter);
  const setFilter = useTicketStore((s) => s.setFilter);
  const linkedWork = useTicketStore((s) => s.linkedWork);
  const linkedOnly = useTicketStore((s) => s.linkedOnly);
  const setLinkedOnly = useTicketStore((s) => s.setLinkedOnly);
  const refresh = useTicketStore((s) => s.refresh);
  const refreshing = useTicketStore((s) => s.refreshing);
  const density = useUIStore((s) => s.emailDensity);
  const timeZone = useDisplayTimeZone();

  const tickets = useMemo(
    () => selectVisibleTickets({ data, filter, linkedOnly, linkedWork }),
    [data, filter, linkedOnly, linkedWork],
  );
  const groups = useMemo(() => groupByDate(tickets, (t) => t.updatedAt), [tickets]);

  // Keep the keyboard-selected row in view
  useEffect(() => {
    if (!selectedTicketId) return;
    document.querySelector(`[data-ticket-id="${CSS.escape(selectedTicketId)}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [selectedTicketId]);

  const mineUnavailable = filter === "mine" && data !== null && data.meAgentId === null;

  return (
    <div className="flex flex-col bg-surface-list min-w-[240px] shrink-0" style={{ width }}>
      <ListHeader
        breadcrumb={["Freshdesk"]}
        title="Tickets"
        tabs={TABS}
        activeTab={filter}
        onTabChange={(id) => setFilter(id as TicketFilter)}
        actions={
          data && !data.isSample ? (
            <>
              <button
                type="button"
                onClick={() => setLinkedOnly(!linkedOnly)}
                aria-pressed={linkedOnly}
                aria-label="Linked work only"
                title="Show only tickets with linked ClickUp tasks"
                className={`p-1.5 rounded-md hover:bg-bg-hover ${linkedOnly ? "text-accent bg-bg-selected" : "text-text-secondary hover:text-text-primary"}`}
              >
                <ListChecks size={14} aria-hidden />
              </button>
              <FindOlderTicket />
              <button
                type="button"
                onClick={() => void refresh()}
                disabled={refreshing}
                title="Refresh tickets from Freshdesk"
                aria-label="Refresh tickets"
                className="p-1.5 rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-hover disabled:opacity-50"
              >
                <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />
              </button>
            </>
          ) : undefined
        }
      />
      {data && <TicketSyncBar data={data} />}

      <div className="@container flex-1 overflow-y-auto">
        {data && tickets.length === 0 && (
          <p className="px-4 py-8 text-center text-meta text-text-tertiary">
            {mineUnavailable
              ? "My open tickets needs a connected helpdesk, so Velo knows which agent you are."
              : linkedOnly
                ? "No tickets here have linked ClickUp tasks."
                : EMPTY_TEXT[filter]}
          </p>
        )}
        {groups.map((group) => (
          <div key={group.key} role="group" aria-label={group.label}>
            <DateGroupHeader label={group.label} />
            {group.items.map((t) => (
              <div key={t.id} data-ticket-id={t.id}>
                <ListRow
                  density={density}
                  unread={false}
                  sender={t.customer ?? "Customer not loaded"}
                  subject={t.subject || "(no subject)"}
                  subjectPrefix={`#${t.id}`}
                  preview={<TicketRowDetails ticket={t} />}
                  time={t.updatedAt}
                  selected={t.id === selectedTicketId}
                  indicators={
                    <>
                      {t.activity.needsReply === true && <NeedsReplyBadge />}
                      <TicketStatusBadge status={t.status} />
                      {t.priority && <TicketPriorityBadge priority={t.priority} />}
                      {linkedWork.has(t.id) && <LinkedWorkBadge summary={linkedWork.get(t.id)!} />}
                    </>
                  }
                  onClick={() => navigateToTicket(t.id)}
                  buttonProps={{ "aria-label": rowLabel(t, timeZone) }}
                />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
