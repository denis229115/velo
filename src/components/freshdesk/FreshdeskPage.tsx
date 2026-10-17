import { useEffect, useMemo } from "react";
import { useUIStore } from "@/stores/uiStore";
import { selectCurrentView, selectVisibleTickets, useTicketStore } from "@/stores/ticketStore";
import { useSelectedTicketId } from "@/hooks/useRouteNavigation";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
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
  const views = useTicketStore((s) => s.views);
  const selectedViewId = useTicketStore((s) => s.selectedViewId);
  const draftFilter = useTicketStore((s) => s.draftFilter);
  const loadLinkedWork = useTicketStore((s) => s.loadLinkedWork);
  const focusHistory = useTicketStore((s) => s.focusHistory);
  // Histories load for the opened ticket first, then the top of the list; keyed by IDs so reloads don't re-trigger
  const visibleKey = useMemo(
    () =>
      selectVisibleTickets({ data, views, selectedViewId, draftFilter })
        .slice(0, VISIBLE_HYDRATION_ROWS)
        .map((t) => t.id)
        .join(","),
    [data, views, selectedViewId, draftFilter],
  );

  useEffect(() => {
    void load();
    const reload = () => void load();
    const reloadLinks = () => void loadLinkedWork();
    window.addEventListener("velo-tickets-synced", reload);
    window.addEventListener("velo-task-links-changed", reloadLinks);
    return () => {
      window.removeEventListener("velo-tickets-synced", reload);
      window.removeEventListener("velo-task-links-changed", reloadLinks);
    };
  }, [load, loadLinkedWork]);

  const live = data !== null && !data.isSample;
  useEffect(() => {
    if (!live) return;
    focusHistory(selectedTicketId, visibleKey ? visibleKey.split(",") : []);
  }, [live, selectedTicketId, visibleKey, focusHistory]);

  // The board takes the whole row; an opened ticket reads beside it
  if (selectCurrentView({ views, selectedViewId }).presentation === "board") {
    return (
      <div className="flex flex-1 min-w-0 flex-row">
        <ErrorBoundary name="TicketList">
          <TicketList selectedTicketId={selectedTicketId} />
        </ErrorBoundary>
        {selectedTicketId && (
          <>
            <div className="w-px bg-border-primary shrink-0" />
            <div className="flex w-[min(34rem,45%)] shrink-0">
              <ErrorBoundary name="TicketReader">
                <TicketReader ticket={ticket} ticketId={selectedTicketId} />
              </ErrorBoundary>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-w-0 flex-row">
      <ErrorBoundary name="TicketList">
        <TicketList selectedTicketId={selectedTicketId} width={width} />
      </ErrorBoundary>
      <div className="w-px bg-border-primary shrink-0" />
      <ErrorBoundary name="TicketReader">
        <TicketReader ticket={ticket} ticketId={selectedTicketId} />
      </ErrorBoundary>
    </div>
  );
}
