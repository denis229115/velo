import { useShortcutStore } from "@/stores/shortcutStore";
import { useUIStore } from "@/stores/uiStore";
import { Kbd } from "./Kbd";

export interface KeyHint {
  /** Shortcut IDs from the shortcut registry, shown in order */
  ids: string[];
  label: string;
}

export const MAIL_LIST_HINTS: KeyHint[] = [
  { ids: ["nav.next", "nav.prev"], label: "Navigate" },
  { ids: ["nav.open"], label: "Open" },
  { ids: ["app.help"], label: "Shortcuts" },
];

interface StatusBarProps {
  /** Sync progress or failure text; replaces the connection state while set */
  syncStatus?: string | null;
  hints?: KeyHint[];
}

type Tone = "ok" | "busy" | "error" | "offline";

const DOT_CLASS: Record<Tone, string> = {
  ok: "bg-status-success",
  busy: "bg-accent animate-pulse",
  error: "bg-status-error",
  offline: "bg-text-tertiary",
};

/** Slim footer: connection or sync state on the left, keyboard hints on the right. */
export function StatusBar({ syncStatus, hints = MAIL_LIST_HINTS }: StatusBarProps) {
  const isOnline = useUIStore((s) => s.isOnline);
  const keyMap = useShortcutStore((s) => s.keyMap);

  let tone: Tone;
  let text: string;
  if (syncStatus) {
    text = syncStatus;
    tone = syncStatus.startsWith("Sync failed") ? "error" : syncStatus === "Sync complete" ? "ok" : "busy";
  } else if (isOnline) {
    text = "Connected";
    tone = "ok";
  } else {
    text = "Offline";
    tone = "offline";
  }

  return (
    <footer className="no-select flex items-center justify-between gap-4 h-8 px-3 shrink-0 border-t border-border-secondary text-meta text-text-tertiary">
      <div role="status" className="flex items-center gap-1.5 min-w-0">
        <span data-tone={tone} aria-hidden className={`w-1.5 h-1.5 rounded-full shrink-0 ${DOT_CLASS[tone]}`} />
        <span className={`truncate ${tone === "error" ? "text-status-error" : ""}`}>{text}</span>
      </div>
      <ul aria-label="Keyboard hints" className="flex items-center gap-3 shrink-0">
        {hints.map((hint) => (
          <li key={hint.label} className="flex items-center gap-1">
            {hint.ids.map((id) => (
              <Kbd key={id} keys={keyMap[id] ?? ""} />
            ))}
            <span className="ml-0.5">{hint.label}</span>
          </li>
        ))}
      </ul>
    </footer>
  );
}
