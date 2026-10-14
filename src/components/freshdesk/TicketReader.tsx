import type { ReactNode } from "react";
import { EmptyState } from "@/components/ui/EmptyState";
import { ReadingPaneIllustration } from "@/components/ui/illustrations";
import { SampleBadge } from "@/components/ui/SampleBadge";
import { formatFullDate } from "@/utils/date";
import type { TicketListItem } from "@/services/freshdesk/ticketSync";
import { TicketPriorityBadge, TicketStatusBadge } from "./TicketBadges";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="contents">
      <dt className="text-meta text-text-tertiary">{label}</dt>
      <dd className="text-row text-text-primary min-w-0">{children}</dd>
    </div>
  );
}

/** The ticket open on the right of the list; read-only. */
export function TicketReader({ ticket, ticketId }: { ticket: TicketListItem | null; ticketId: string | null }) {
  return (
    <section aria-label="Ticket reader" className="flex-1 min-w-0 flex flex-col bg-surface-reader">
      {!ticket ? (
        <EmptyState
          illustration={ReadingPaneIllustration}
          title="Freshdesk"
          subtitle={ticketId ? `Ticket #${ticketId} is not in the local copy` : "Select a ticket to read"}
        />
      ) : (
        <div className="overflow-y-auto px-8 py-6">
          <div className="flex items-center gap-2 text-meta text-text-tertiary mb-1">
            <span className="tabular-nums">#{ticket.id}</span>
            {ticket.isSample && <SampleBadge />}
            {ticket.fetchedOnDemand && <span>Fetched on demand: outside the downloaded scope</span>}
          </div>
          <h2 className="text-title font-semibold text-text-primary mb-5">{ticket.subject || "(no subject)"}</h2>
          <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-2.5 items-center max-w-xl">
            <Field label="Status">
              <TicketStatusBadge status={ticket.status} />
            </Field>
            <Field label="Priority">{ticket.priority ? <TicketPriorityBadge priority={ticket.priority} /> : "None"}</Field>
            <Field label="Customer">{ticket.customer ?? "Not loaded yet"}</Field>
            <Field label="Assignee">{ticket.assignee ?? "Unassigned"}</Field>
            <Field label="Last updated">
              <time dateTime={new Date(ticket.updatedAt).toISOString()}>{formatFullDate(ticket.updatedAt)}</time>
            </Field>
          </dl>
        </div>
      )}
    </section>
  );
}
