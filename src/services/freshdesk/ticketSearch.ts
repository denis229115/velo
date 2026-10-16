import type { TicketListItem } from "./ticketSync";

/** The ticket ID a query names ("#123" or "123"), or null when it is not an ID. */
export function parseTicketIdQuery(query: string): string | null {
  const id = query.replace(/\s+/g, "").replace(/^#/, "");
  return /^\d+$/.test(id) ? id : null;
}

/**
 * Local search over the downloaded tickets: never contacts Freshdesk or an AI
 * service. An ID query matches that ticket only.
 */
export function searchTickets(tickets: TicketListItem[], query: string): TicketListItem[] {
  const id = parseTicketIdQuery(query);
  if (id !== null) return tickets.filter((t) => t.id === id);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return tickets.filter((t) => {
    const text = searchableText(t);
    return words.every((w) => text.includes(w));
  });
}

/** The words the ticket is shown with: an unknown status reads "Unknown status", as on its badge. */
function searchableText(t: TicketListItem): string {
  return [
    t.subject,
    t.customer,
    t.customerEmail,
    t.status.known ? t.status.label : "Unknown status",
    t.priority?.label,
    t.assignee,
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}
