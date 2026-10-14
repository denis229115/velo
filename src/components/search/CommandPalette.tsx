import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { CSSTransition } from "react-transition-group";
import { Search, Mail, ListFilter } from "lucide-react";
import { useUIStore } from "@/stores/uiStore";
import { useComposerStore } from "@/stores/composerStore";
import { useThreadStore } from "@/stores/threadStore";
import { useAccountStore } from "@/stores/accountStore";
import { useSmartFolderStore } from "@/stores/smartFolderStore";
import { getGmailClient } from "@/services/gmail/tokenManager";
import { getTemplatesForAccount, type DbTemplate } from "@/services/db/templates";
import { searchMessages, type SearchResult } from "@/services/db/search";
import { hasSearchOperators } from "@/services/search/searchParser";
import { useActiveLabel } from "@/hooks/useRouteNavigation";
import { navigateToLabel, navigateToThread, navigateBack, getActiveLabel, getSelectedThreadId } from "@/router/navigate";
import { formatShortcut } from "@/utils/shortcutLabel";
import { Kbd } from "@/components/list/Kbd";

interface Command {
  id: string;
  label: string;
  shortcut?: string;
  category: string;
  action: () => void;
}

/** One selectable row in the palette. Other sources (e.g. tickets) add their own group. */
interface PaletteItem {
  id: string;
  label: string;
  detail?: string;
  shortcut?: string;
  icon?: "thread" | "all-results";
  action: () => void;
}

interface PaletteGroup {
  name: string;
  items: PaletteItem[];
}

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
}

const MAX_THREAD_RESULTS = 8;
const SEARCH_DEBOUNCE_MS = 150;
/** Pages that have no mail list, so "show all results" opens the inbox list instead. */
const NON_MAIL_PAGES = new Set(["settings", "attachments", "scheduled", "tasks", "calendar", "help"]);

/** Local search hits grouped to one entry per thread, best match first. */
function useThreadSearch(query: string, accountId: string | null, enabled: boolean): SearchResult[] {
  const [hits, setHits] = useState<SearchResult[]>([]);

  useEffect(() => {
    const q = query.trim();
    if (!enabled || q.length < 2) {
      setHits([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      searchMessages(q, accountId ?? undefined, 50)
        .then((results) => {
          if (cancelled) return;
          const seen = new Set<string>();
          const threads: SearchResult[] = [];
          for (const r of results) {
            if (seen.has(r.thread_id)) continue;
            seen.add(r.thread_id);
            threads.push(r);
            if (threads.length === MAX_THREAD_RESULTS) break;
          }
          setHits(threads);
        })
        .catch(() => {
          if (!cancelled) setHits([]);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, accountId, enabled]);

  return hits;
}

/** Show a search in the mail list, like the old search bar's results. */
function openFullResults(query: string) {
  useThreadStore.getState().setSearch(query, null);
  const label = getActiveLabel();
  if (NON_MAIL_PAGES.has(label)) navigateToLabel("inbox");
  else if (getSelectedThreadId()) navigateBack();
}

export function CommandPalette({ isOpen, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const setTheme = useUIStore((s) => s.setTheme);
  const openComposer = useComposerStore((s) => s.openComposer);
  const activeLabel = useActiveLabel();
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const [templates, setTemplates] = useState<DbTemplate[]>([]);
  const smartFolders = useSmartFolderStore((s) => s.folders);

  useEffect(() => {
    if (!isOpen || !activeAccountId) return;
    getTemplatesForAccount(activeAccountId).then(setTemplates);
  }, [isOpen, activeAccountId]);

  const commands: Command[] = useMemo(() => [
    // Navigation
    { id: "go-inbox", label: "Go to Inbox", shortcut: "g i", category: "Navigation", action: () => { navigateToLabel("inbox"); onClose(); } },
    { id: "go-starred", label: "Go to Starred", shortcut: "g s", category: "Navigation", action: () => { navigateToLabel("starred"); onClose(); } },
    { id: "go-sent", label: "Go to Sent", shortcut: "g t", category: "Navigation", action: () => { navigateToLabel("sent"); onClose(); } },
    { id: "go-drafts", label: "Go to Drafts", shortcut: "g d", category: "Navigation", action: () => { navigateToLabel("drafts"); onClose(); } },
    { id: "go-snoozed", label: "Go to Snoozed", category: "Navigation", action: () => { navigateToLabel("snoozed"); onClose(); } },
    { id: "go-trash", label: "Go to Trash", category: "Navigation", action: () => { navigateToLabel("trash"); onClose(); } },
    { id: "go-all", label: "Go to All Mail", category: "Navigation", action: () => { navigateToLabel("all"); onClose(); } },

    // Actions
    { id: "compose", label: "Compose New Email", shortcut: "c", category: "Actions", action: () => { openComposer(); onClose(); } },
    { id: "deselect", label: "Close Thread", shortcut: "Esc", category: "Actions", action: () => { navigateBack(); onClose(); } },
    { id: "spam", label: activeLabel === "spam" ? "Not Spam" : "Report Spam", shortcut: "!", category: "Actions", action: async () => {
      onClose();
      const selectedId = getSelectedThreadId();
      const accountId = useAccountStore.getState().activeAccountId;
      if (!selectedId || !accountId) return;
      try {
        const client = await getGmailClient(accountId);
        if (activeLabel === "spam") {
          await client.modifyThread(selectedId, ["INBOX"], ["SPAM"]);
        } else {
          await client.modifyThread(selectedId, ["SPAM"], ["INBOX"]);
        }
        useThreadStore.getState().removeThread(selectedId);
      } catch (err) {
        console.error("Spam action failed:", err);
      }
    } },

    // Tasks
    { id: "task-create", label: "Create Task", category: "Tasks", action: () => {
      onClose();
      useUIStore.getState().setTaskSidebarVisible(true);
    } },
    { id: "task-extract", label: "Create Task from Email (AI)", shortcut: "t", category: "Tasks", action: () => {
      onClose();
      const threadId = getSelectedThreadId();
      if (threadId) {
        window.dispatchEvent(new CustomEvent("velo-extract-task", { detail: { threadId } }));
      }
    } },
    { id: "task-view", label: "View Tasks", shortcut: "g k", category: "Tasks", action: () => { navigateToLabel("tasks"); onClose(); } },
    { id: "task-toggle-panel", label: "Toggle Task Panel", category: "Tasks", action: () => { useUIStore.getState().toggleTaskSidebar(); onClose(); } },

    // AI
    { id: "ask-ai", label: "Ask AI about your inbox", category: "AI", action: () => { onClose(); window.dispatchEvent(new Event("velo-toggle-ask-inbox")); } },

    // Settings
    { id: "toggle-sidebar", label: "Toggle Sidebar", shortcut: "Ctrl+Shift+E", category: "Settings", action: () => { toggleSidebar(); onClose(); } },
    { id: "theme-light", label: "Switch to Light Theme", category: "Settings", action: () => { setTheme("light"); onClose(); } },
    { id: "theme-dark", label: "Switch to Dark Theme", category: "Settings", action: () => { setTheme("dark"); onClose(); } },
    { id: "theme-system", label: "Use System Theme", category: "Settings", action: () => { setTheme("system"); onClose(); } },

    // Smart folders (saved searches)
    ...smartFolders.map((folder) => ({
      id: `smart-folder-${folder.id}`,
      label: `Open ${folder.name}`,
      category: "Smart Folders",
      action: () => { navigateToLabel(`smart-folder:${folder.id}`); onClose(); },
    })),

    // Templates
    ...templates.map((tmpl) => ({
      id: `template-${tmpl.id}`,
      label: `Insert: ${tmpl.name}`,
      category: "Templates",
      action: () => {
        openComposer({
          mode: "new" as const,
          to: [],
          subject: tmpl.subject ?? "",
          bodyHtml: tmpl.body_html,
        });
        onClose();
      },
    })),
  ], [onClose, openComposer, activeLabel, toggleSidebar, setTheme, templates, smartFolders]);

  const trimmed = query.trim();
  const threadHits = useThreadSearch(query, activeAccountId, isOpen);

  const groups: PaletteGroup[] = useMemo(() => {
    if (!trimmed) {
      const categories = [...new Set(commands.map((c) => c.category))];
      return categories.map((name) => ({ name, items: commands.filter((c) => c.category === name) }));
    }
    const q = trimmed.toLowerCase();
    const matching = commands.filter(
      (c) => c.label.toLowerCase().includes(q) || c.category.toLowerCase().includes(q),
    );
    const threads: PaletteItem[] = threadHits.map((hit) => ({
      id: `thread-${hit.thread_id}`,
      label: hit.subject || "(no subject)",
      detail: hit.from_name || hit.from_address || undefined,
      icon: "thread",
      action: () => { navigateToThread(hit.thread_id); onClose(); },
    }));
    if (trimmed.length >= 2) {
      const allResults: PaletteItem = {
        id: "all-results",
        label: `Show all results for “${trimmed}”`,
        icon: "all-results",
        action: () => { openFullResults(trimmed); onClose(); },
      };
      // Operator queries rarely match a command, so the full list comes first for Enter
      if (hasSearchOperators(trimmed)) threads.unshift(allResults);
      else threads.push(allResults);
    }
    return [
      { name: "Commands", items: matching },
      { name: "Threads", items: threads },
    ].filter((g) => g.items.length > 0);
  }, [trimmed, commands, threadHits, onClose]);

  const items = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const activeIdx = Math.min(selectedIdx, Math.max(items.length - 1, 0));

  useEffect(() => {
    if (!isOpen) {
      setQuery("");
      setSelectedIdx(0);
    }
  }, [isOpen]);

  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: "nearest" });
  }, [activeIdx]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIdx(Math.min(activeIdx + 1, items.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIdx(Math.max(activeIdx - 1, 0));
      } else if (e.key === "Enter" && items[activeIdx]) {
        e.preventDefault();
        items[activeIdx].action();
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    },
    [items, activeIdx, onClose],
  );

  const optionId = (item: PaletteItem) => `palette-option-${item.id}`;
  let flatIdx = -1;

  return (
    <CSSTransition nodeRef={overlayRef} in={isOpen} timeout={200} classNames="modal" unmountOnExit>
    <div ref={overlayRef} className="fixed inset-0 z-[60] flex items-start justify-center pt-[15vh]">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-surface-overlay border border-separator rounded-lg overlay-shadow w-full max-w-lg overflow-hidden modal-panel">
        {/* Input */}
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-border-primary">
          <Search size={15} className="shrink-0 text-text-tertiary" aria-hidden />
          <input
            ref={inputRef}
            autoFocus
            type="text"
            role="combobox"
            aria-label="Search mail and commands"
            aria-expanded={items.length > 0}
            aria-controls="command-palette-results"
            aria-activedescendant={items[activeIdx] ? optionId(items[activeIdx]) : undefined}
            aria-autocomplete="list"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIdx(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Search mail or type a command… (from: to: has:attachment)"
            // The caret marks focus here; the global focus ring would box the whole field
            style={{ outline: "none" }}
            className="w-full bg-transparent text-sm text-text-primary placeholder:text-text-tertiary"
          />
        </div>

        {/* Results */}
        <div ref={listRef} id="command-palette-results" role="listbox" aria-label="Results" className="max-h-96 overflow-y-auto py-1">
          {items.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-text-tertiary">
              {trimmed.length >= 2 ? "No matching commands or mail" : "No commands found"}
            </div>
          ) : (
            groups.map((group) => (
              <div key={group.name} role="group" aria-labelledby={`palette-group-${group.name}`}>
                <div
                  id={`palette-group-${group.name}`}
                  className="px-4 pt-2 pb-1 text-[0.625rem] font-semibold uppercase tracking-wider text-text-tertiary"
                >
                  {group.name}
                </div>
                {group.items.map((item) => {
                  flatIdx += 1;
                  const idx = flatIdx;
                  const selected = idx === activeIdx;
                  return (
                    <div
                      key={item.id}
                      id={optionId(item)}
                      role="option"
                      aria-selected={selected}
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseMove={() => { if (!selected) setSelectedIdx(idx); }}
                      onClick={item.action}
                      className={`mx-1 px-3 py-1.5 rounded-md flex items-center gap-2.5 cursor-pointer text-sm ${
                        selected ? "bg-bg-hover" : ""
                      }`}
                    >
                      {item.icon === "thread" && <Mail size={14} className="shrink-0 text-text-tertiary" aria-hidden />}
                      {item.icon === "all-results" && <ListFilter size={14} className="shrink-0 text-accent" aria-hidden />}
                      <span className={`min-w-0 flex-1 truncate ${item.icon === "all-results" ? "text-accent" : "text-text-primary"}`}>
                        {item.label}
                      </span>
                      {item.detail && (
                        <span className="shrink-0 max-w-[40%] truncate text-xs text-text-tertiary">{item.detail}</span>
                      )}
                      {item.shortcut && (
                        <kbd className="shrink-0 text-[0.625rem] text-text-tertiary bg-bg-tertiary px-1.5 py-0.5 rounded">
                          {formatShortcut(item.shortcut)}
                        </kbd>
                      )}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* Keyboard hints */}
        <div className="flex items-center gap-3 px-4 py-2 border-t border-border-secondary text-micro text-text-tertiary">
          <span className="inline-flex items-center gap-1"><Kbd keys="ArrowUp" /><Kbd keys="ArrowDown" /> navigate</span>
          <span className="inline-flex items-center gap-1"><Kbd keys="Enter" /> open</span>
          <span className="inline-flex items-center gap-1"><Kbd keys="Escape" /> close</span>
        </div>
      </div>
    </div>
    </CSSTransition>
  );
}
