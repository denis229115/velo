import { useRouterState } from "@tanstack/react-router";
import { useUIStore } from "@/stores/uiStore";
import { WifiOff } from "lucide-react";

export function OfflineBanner() {
  const isOnline = useUIStore((s) => s.isOnline);
  // Email changes queue and sync later; Freshdesk tickets are shared, so their changes never do
  const onFreshdesk = useRouterState({
    select: (s) => s.location.pathname === "/freshdesk" || s.location.pathname.startsWith("/freshdesk/"),
  });

  if (isOnline) return null;

  return (
    <div className="shrink-0 flex items-center justify-center gap-2 bg-warning text-white text-xs px-4 py-1.5">
      <WifiOff size={14} />
      <span>
        {onFreshdesk
          ? "You're offline — ticket changes need a connection and are not queued"
          : "You're offline — changes will sync when you reconnect"}
      </span>
    </div>
  );
}
