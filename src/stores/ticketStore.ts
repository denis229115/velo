import { create } from "zustand";
import {
  fetchOlderTicket,
  getTicketList,
  syncTickets,
  type TicketListData,
  type TicketListItem,
} from "@/services/freshdesk/ticketSync";
import { hydrateTicketHistories } from "@/services/freshdesk/ticketHistory";
import {
  DEFAULT_VIEW_ID,
  applyTicketView,
  createTicketView,
  deleteTicketView,
  getTicketViews,
  presetViews,
  selectTicketView,
  updateTicketView,
  type TicketView,
  type TicketViewChanges,
  type TicketViewFilter,
} from "@/services/freshdesk/ticketViews";

interface TicketState {
  data: TicketListData | null;
  /** Bumped on every reload so views holding derived data (the reader's history) refresh */
  version: number;
  /** Ticket views of the current helpdesk, presets first */
  views: TicketView[];
  selectedViewId: string;
  /** Filters being edited on the selected view, not saved yet */
  draftFilter: TicketViewFilter | null;
  refreshing: boolean;
  load: () => Promise<void>;
  loadViews: () => Promise<void>;
  selectView: (viewId: string) => Promise<void>;
  /** Sort, columns, density and presentation persist at once; a custom view also takes name and filter */
  updateView: (viewId: string, changes: TicketViewChanges) => Promise<void>;
  /** Saves the selected view's settings with the edited filters as a new view and selects it */
  saveViewAs: (name: string) => Promise<void>;
  deleteView: (viewId: string) => Promise<void>;
  setDraftFilter: (filter: TicketViewFilter | null) => void;
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
  views: presetViews(false),
  selectedViewId: DEFAULT_VIEW_ID,
  draftFilter: null,
  refreshing: false,
  load: async () => {
    const data = await getTicketList();
    set((s) => ({ data, version: s.version + 1 }));
  },
  loadViews: async () => {
    const { views, selectedViewId } = await getTicketViews();
    set((s) => ({ views, selectedViewId, draftFilter: s.selectedViewId === selectedViewId ? s.draftFilter : null }));
  },
  selectView: async (viewId) => {
    set({ selectedViewId: viewId, draftFilter: null });
    await selectTicketView(viewId);
    await get().loadViews();
  },
  updateView: async (viewId, changes) => {
    set((s) => ({ views: s.views.map((v) => (v.id === viewId ? { ...v, ...changes } : v)) }));
    await updateTicketView(viewId, changes);
    await get().loadViews();
  },
  saveViewAs: async (name) => {
    const current = selectCurrentView(get());
    const view = await createTicketView({
      name,
      filter: get().draftFilter ?? current.filter,
      sort: current.sort,
      columns: current.columns,
      density: current.density,
      presentation: current.presentation,
    });
    await get().selectView(view.id);
  },
  deleteView: async (viewId) => {
    await deleteTicketView(viewId);
    if (get().selectedViewId === viewId) set({ selectedViewId: DEFAULT_VIEW_ID, draftFilter: null });
    await get().loadViews();
  },
  setDraftFilter: (draftFilter) => set({ draftFilter }),
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
    return found?.id ?? null;
  },
  focusHistory: (openedId, visibleIds) => {
    void hydrateTicketHistories({ openedId, visibleIds });
  },
}));

/** The tickets the list shows, in order; keyboard navigation walks the same list. */
export function selectVisibleTickets(
  state: Pick<TicketState, "data" | "views" | "selectedViewId" | "draftFilter">,
): TicketListItem[] {
  const view = selectCurrentView(state);
  return applyTicketView({ filter: state.draftFilter ?? view.filter, sort: view.sort }, state.data);
}

/** The selected view; falls back to All outstanding when it no longer exists. */
export function selectCurrentView(state: Pick<TicketState, "views" | "selectedViewId">): TicketView {
  return (
    state.views.find((v) => v.id === state.selectedViewId) ??
    state.views.find((v) => v.id === DEFAULT_VIEW_ID) ??
    (presetViews(false).find((v) => v.id === DEFAULT_VIEW_ID) as TicketView)
  );
}
