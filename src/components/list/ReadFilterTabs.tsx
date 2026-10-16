import { useUIStore } from "@/stores/uiStore";
import { ListTabs } from "./ListHeader";

const TABS = [
  { id: "all", label: "All" },
  { id: "unread", label: "Unread" },
];

/** All / Unread tabs bound to the persisted read filter. */
export function ReadFilterTabs() {
  const readFilter = useUIStore((s) => s.readFilter);
  const setReadFilter = useUIStore((s) => s.setReadFilter);
  return (
    <ListTabs
      label="Read filter"
      tabs={TABS}
      activeTab={readFilter === "unread" ? "unread" : "all"}
      onTabChange={(id) => setReadFilter(id === "unread" ? "unread" : "all")}
    />
  );
}
