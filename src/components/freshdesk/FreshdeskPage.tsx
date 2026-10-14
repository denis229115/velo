import { useEffect, useMemo } from "react";
import { useUIStore } from "@/stores/uiStore";
import { selectVisibleTickets, useTicketStore } from "@/stores/ticketStore";
import { useSelectedTicketId } from "@/hooks/useRouteNavigation";
import { TicketList } from "./TicketList";
import { TicketReader } from "./TicketReader";

const MIN_TICKET_LIST_WIDTH = 560;
/** List rows whose histories load right after the opened ticket's */
const VISIBLE_HYDRATION_ROWS = 30;

/** The Freshdesk section: ticket list with the reader on the right, as in email. */
export function FreshdeskPage() {
  // Ticket rows carry status and priority badges, so the list starts wider than the email list
  const width = Math.max(useUIStore((s) => s.emailListWidth), MIN_TICKET_LIST_WIDTH);
  const data = useTicketStore((s) => s.data);
  const load = useTicketStore((s) => s.load);
  const selectedTicketId = useSelectedTicketId();
  const ticket = data?.tickets.find((t) => t.id === selectedTicketId) ?? null;
  const filter = useTicketStore((s) => s.filter);
  const focusHistory = useTicketStore((s) => s.focusHistory);
  // Histories load for the opened ticket first, then the top of the list; keyed by IDs so reloads don't re-trigger
  const visibleKey = useMemo(
    () => selectVisibleTickets({ data, filter }).slice(0, VISIBLE_HYDRATION_ROWS).map((t) => t.id).join(","),
    [data, filter],
  );

  useEffect(() => {
    void load();
    const reload = () => void load();
    window.addEventListener("velo-tickets-synced", reload);
    return () => window.removeEventListener("velo-tickets-synced", reload);
  }, [load]);

  const live = data !== null && !data.isSample;
  useEffect(() => {
    if (!live) return;
    focusHistory(selectedTicketId, visibleKey ? visibleKey.split(",") : []);
  }, [live, selectedTicketId, visibleKey, focusHistory]);

  return (
    <div className="flex flex-1 min-w-0 flex-row">
      <TicketList selectedTicketId={selectedTicketId} width={width} />
      <div className="w-px bg-border-primary shrink-0" />
      <TicketReader ticket={ticket} ticketId={selectedTicketId} />
    </div>
  );
}
