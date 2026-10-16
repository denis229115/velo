import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useDraggable } from "@dnd-kit/core";
import { ArrowRightLeft, Check } from "lucide-react";
import type { LinkedWorkSummary } from "@/services/clickup/links";
import type { ClassifiableStatus } from "@/services/freshdesk/connection";
import type { TicketListItem } from "@/services/freshdesk/ticketSync";
import type { ActivityTime } from "@/services/freshdesk/activity";
import { navigateToTicket } from "@/router/navigate";
import { LinkedWorkBadge, TicketPriorityBadge } from "./TicketBadges";
import { formatAgo } from "./TicketSyncBar";
import type { FreshdeskWritable } from "./useFreshdeskWritable";

/** Age since Last answered; Unknown while the history is not fully read */
export function lastAnsweredText(time: ActivityTime): string {
  if (time.state === "known") return `Last answered ${formatAgo(time.at)}`;
  if (time.state === "never") return "Never answered";
  return "Last answered unknown";
}

interface TicketCardProps {
  ticket: TicketListItem;
  linkedWork: LinkedWorkSummary | undefined;
  selected: boolean;
  /** Statuses a ticket can move to, in Freshdesk's order */
  statuses: ClassifiableStatus[];
  /** Whether moves are on; off while offline, with the helpdesk down, or on sample data */
  writable: FreshdeskWritable;
  onMove: (ticket: TicketListItem, statusId: string) => void;
}

/** A ticket on the board. Drag it to a column, or use its Move menu. */
export function TicketCard({ ticket, linkedWork, selected, statuses, writable, onMove }: TicketCardProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `ticket:${ticket.id}`,
    data: { ticketId: ticket.id },
    disabled: !writable.writable,
  });
  return (
    <article
      ref={setNodeRef}
      aria-label={`Ticket #${ticket.id}: ${ticket.subject || "(no subject)"}`}
      data-ticket-id={ticket.id}
      {...listeners}
      {...attributes}
      // The Move menu is the keyboard way to move, so the card itself is not a drag handle in the tab order
      tabIndex={-1}
      role="article"
      className={`group relative rounded-md border bg-surface-base px-2.5 py-2 text-left shadow-sm transition-colors motion-reduce:transition-none ${
        selected ? "border-accent ring-1 ring-accent/40" : "border-border-primary hover:border-border-secondary"
      } ${isDragging ? "opacity-40" : ""}`}
    >
      <div className="flex items-start gap-1.5">
        <button
          type="button"
          onClick={() => navigateToTicket(ticket.id)}
          className="min-w-0 flex-1 text-left rounded focus-visible:outline-2 focus-visible:outline-accent"
        >
          <span className="block text-micro text-text-tertiary tabular-nums">#{ticket.id}</span>
          <span className="block text-row font-medium text-text-primary line-clamp-2">{ticket.subject || "(no subject)"}</span>
        </button>
        <MoveMenu ticket={ticket} statuses={statuses} writable={writable} onMove={onMove} />
      </div>
      <p className="mt-1 truncate text-meta text-text-secondary">{ticket.customer ?? "Customer not loaded"}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {ticket.priority && <TicketPriorityBadge priority={ticket.priority} />}
        {linkedWork && <LinkedWorkBadge summary={linkedWork} />}
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2 text-micro text-text-tertiary">
        <span className="truncate">{ticket.assignee ?? "Unassigned"}</span>
        <span className="shrink-0">{lastAnsweredText(ticket.activity.lastAnswered)}</span>
      </div>
    </article>
  );
}

function MoveMenu({
  ticket,
  statuses,
  writable,
  onMove,
}: {
  ticket: TicketListItem;
  statuses: ClassifiableStatus[];
  writable: FreshdeskWritable;
  onMove: (ticket: TicketListItem, statusId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const label = `Move ticket #${ticket.id}`;

  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus();
  }, [open]);

  // An open menu does not outlive the connection
  useEffect(() => {
    if (!writable.writable) setOpen(false);
  }, [writable.writable]);

  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      items[(at + step + items.length) % items.length]?.focus();
    }
  };

  return (
    <div
      className="relative shrink-0"
      // Keep the board's pointer drag from starting on the menu
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Move to another status"
        {...writable.controlProps}
        onClick={() => setOpen((o) => !o)}
        className="rounded p-1 text-text-tertiary hover:bg-bg-hover hover:text-text-primary disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-accent"
      >
        <ArrowRightLeft size={13} aria-hidden />
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={`${label} to`}
          onKeyDown={onKeyDown}
          onBlur={(e) => {
            if (!menuRef.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
          }}
          className="absolute right-0 top-full z-20 mt-1 w-52 rounded-md border border-border-primary bg-surface-overlay py-1 overlay-shadow"
        >
          <p className="px-2.5 pb-1 text-micro text-text-tertiary">Move to</p>
          {statuses.map((s) => {
            const current = s.id === ticket.status.id;
            return (
              <button
                key={s.id}
                type="button"
                role="menuitem"
                aria-disabled={current}
                tabIndex={-1}
                onClick={() => {
                  if (current) return;
                  close();
                  onMove(ticket, s.id);
                }}
                className={`flex w-full items-center gap-2 px-2.5 py-1 text-left text-row focus:bg-bg-hover focus:outline-none ${
                  current ? "text-text-tertiary" : "text-text-primary hover:bg-bg-hover"
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{s.label}</span>
                {current && <Check size={12} aria-label="Current status" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
