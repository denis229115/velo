import { useEffect } from "react";
import { ListFilter } from "lucide-react";
import { useTicketStore } from "@/stores/ticketStore";
import { useActiveLabel } from "@/hooks/useRouteNavigation";
import { navigateToLabel } from "@/router/navigate";

/** The ticket views (presets, then the operator's own) under Freshdesk in the sidebar. */
export function FreshdeskViewNav({ collapsed }: { collapsed: boolean }) {
  const views = useTicketStore((s) => s.views);
  const selectedViewId = useTicketStore((s) => s.selectedViewId);
  const loadViews = useTicketStore((s) => s.loadViews);
  const selectView = useTicketStore((s) => s.selectView);
  const onFreshdesk = useActiveLabel() === "freshdesk";

  useEffect(() => {
    void loadViews();
    // A metadata refresh or a new classification can add or drop Waiting on customer
    const reload = () => void loadViews();
    window.addEventListener("velo-tickets-synced", reload);
    return () => window.removeEventListener("velo-tickets-synced", reload);
  }, [loadViews]);

  if (collapsed) return null;

  return (
    <div role="group" aria-label="Freshdesk views" className="pt-0.5">
      {views.map((view) => {
        const active = onFreshdesk && view.id === selectedViewId;
        return (
          <button
            key={view.id}
            type="button"
            onClick={() => {
              void selectView(view.id);
              navigateToLabel("freshdesk");
            }}
            aria-current={active ? "page" : undefined}
            className={`flex items-center w-full gap-2 py-1.5 pl-9 pr-3 text-left text-meta transition-colors ${
              active ? "bg-accent/10 text-accent font-medium" : "hover:bg-sidebar-hover text-sidebar-text/80"
            }`}
          >
            {view.kind === "custom" && <ListFilter size={12} aria-hidden className="shrink-0 opacity-70" />}
            <span className="flex-1 truncate">{view.name}</span>
          </button>
        );
      })}
    </div>
  );
}
