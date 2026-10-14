import { create } from "zustand";
import {
  fetchOlderTicket,
  getTicketList,
  syncTickets,
  type TicketListData,
  type TicketListItem,
} from "@/services/freshdesk/ticketSync";
import { hydrateTicketHistories } from "@/services/freshdesk/ticketHistory";

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
  refreshing: boolean;
  load: () => Promise<void>;
  setFilter: (filter: TicketFilter) => void;
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
  refreshing: false,
  load: async () => {
    const data = await getTicketList();
    set((s) => ({ data, version: s.version + 1 }));
  },
  setFilter: (filter) => set({ filter }),
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
export function selectVisibleTickets(state: Pick<TicketState, "data" | "filter">): TicketListItem[] {
  return filterTickets(state.data, state.filter);
}
