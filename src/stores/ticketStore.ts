import { create } from "zustand";
import {
  fetchOlderTicket,
  getTicketList,
  syncTickets,
  type TicketListData,
  type TicketListItem,
} from "@/services/freshdesk/ticketSync";
import { hydrateTicketHistories } from "@/services/freshdesk/ticketHistory";
import { getLinkedTicketSummary, type LinkedWorkSummary } from "@/services/clickup/links";

export type TicketFilter = "outstanding" | "mine" | "all";

/** Outstanding: not classified done. My open: the verified me, in a status classified open. */
export function filterTickets(data: TicketListData | null, filter: TicketFilter): TicketListItem[] {
  if (!data) return [];
  switch (filter) {
    case "outstanding":
      return data.tickets.filter((t) => t.outstanding);
    case "mine":
      return data.meAgentId === null
        ? []
        : data.tickets.filter((t) => t.assigneeId === data.meAgentId && t.status.statusClass === "open");
    case "all":
      return data.tickets;
  }
}

interface TicketState {
  data: TicketListData | null;
  /** Bumped on every reload so views holding derived data (the reader's history) refresh */
  version: number;
  filter: TicketFilter;
  /** Linked ClickUp tasks per ticket ID */
  linkedWork: Map<string, LinkedWorkSummary>;
  /** Show only tickets with linked ClickUp work, within the current filter */
  linkedOnly: boolean;
  refreshing: boolean;
  load: () => Promise<void>;
  setFilter: (filter: TicketFilter) => void;
  setLinkedOnly: (linkedOnly: boolean) => void;
  /** Re-reads linked-task badges after links or task states change */
  loadLinkedWork: () => Promise<void>;
  /** Manual refresh: one sync run, then reload */
  refresh: () => Promise<void>;
  /** Fetch an older ticket by ID; resolves to its ID when found */
  findOlder: (ticketId: string) => Promise<string | null>;
  /** Tells background hydration which tickets the operator is looking at */
  focusHistory: (openedId: string | null, visibleIds: string[]) => void;
}

export const useTicketStore = create<TicketState>((set, get) => ({
  data: null,
  version: 0,
  filter: "outstanding",
  linkedWork: new Map(),
  linkedOnly: false,
  refreshing: false,
  load: async () => {
    const [data, linkedWork] = await Promise.all([getTicketList(), getLinkedTicketSummary()]);
    set((s) => ({ data, linkedWork, version: s.version + 1 }));
  },
  setFilter: (filter) => set({ filter }),
  setLinkedOnly: (linkedOnly) => set({ linkedOnly }),
  loadLinkedWork: async () => set({ linkedWork: await getLinkedTicketSummary() }),
  refresh: async () => {
    set({ refreshing: true });
    try {
      await syncTickets({ trigger: "manual" });
      void hydrateTicketHistories();
    } finally {
      set({ refreshing: false });
      await get().load();
    }
  },
  findOlder: async (ticketId) => {
    const found = await fetchOlderTicket(ticketId);
    await get().load();
    if (found) set({ filter: "all" });
    return found?.id ?? null;
  },
  focusHistory: (openedId, visibleIds) => {
    void hydrateTicketHistories({ openedId, visibleIds });
  },
}));

/** The tickets the list shows, in order; keyboard navigation walks the same list. */
export function selectVisibleTickets(
  state: Pick<TicketState, "data" | "filter"> & Partial<Pick<TicketState, "linkedOnly" | "linkedWork">>,
): TicketListItem[] {
  const tickets = filterTickets(state.data, state.filter);
  const linkedWork = state.linkedWork;
  return state.linkedOnly && linkedWork ? tickets.filter((t) => linkedWork.has(t.id)) : tickets;
}
