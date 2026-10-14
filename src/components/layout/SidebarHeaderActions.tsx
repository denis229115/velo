import { Pencil, Search } from "lucide-react";
import { useComposerStore } from "@/stores/composerStore";
import { useShortcutStore } from "@/stores/shortcutStore";
import { shortcutTooltip } from "@/utils/shortcutTooltip";
import { openSearch } from "../search/openSearch";

/** Search and Compose icon buttons in the sidebar header row. */
export function SidebarHeaderActions({ collapsed }: { collapsed: boolean }) {
  const openComposer = useComposerStore((s) => s.openComposer);
  const searchKey = useShortcutStore((s) => s.keyMap["app.search"]);
  const composeKey = useShortcutStore((s) => s.keyMap["action.compose"]);

  return (
    <div className={`flex shrink-0 items-center gap-0.5 ${collapsed ? "flex-col" : ""}`}>
      <button
        type="button"
        onClick={openSearch}
        aria-label="Search"
        title={shortcutTooltip("Search", searchKey)}
        className="w-8 h-8 flex items-center justify-center rounded-md text-sidebar-text/70 hover:bg-sidebar-hover hover:text-sidebar-text transition-colors"
      >
        <Search size={16} />
      </button>
      <button
        type="button"
        onClick={() => openComposer()}
        aria-label="Compose"
        title={shortcutTooltip("Compose", composeKey)}
        className="w-8 h-8 flex items-center justify-center rounded-md text-accent hover:bg-accent/10 transition-colors"
      >
        <Pencil size={16} />
      </button>
    </div>
  );
}
