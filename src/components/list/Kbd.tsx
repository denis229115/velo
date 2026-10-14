const KEY_SYMBOLS: Record<string, string> = {
  Enter: "↵",
  Escape: "Esc",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Backspace: "⌫",
  Delete: "Del",
};

/** Turns a shortcut-registry binding ("j", "Enter", "g then i", "Ctrl+K") into display parts. */
export function formatKeyBinding(keys: string): string[] {
  if (!keys) return [];
  return keys
    .split(" then ")
    .flatMap((step) => (step.length > 1 && step.includes("+") ? step.split("+") : [step]))
    .map((part) => KEY_SYMBOLS[part] ?? (part.length === 1 ? part.toUpperCase() : part));
}

/** A key chip for one shortcut binding; chords render one chip per key. */
export function Kbd({ keys }: { keys: string }) {
  return (
    <>
      {formatKeyBinding(keys).map((part, i) => (
        <kbd
          key={i}
          className="inline-flex items-center justify-center min-w-4 h-4 px-1 rounded-[4px] border border-border-primary bg-surface-subtle font-sans text-micro leading-none text-text-secondary"
        >
          {part}
        </kbd>
      ))}
    </>
  );
}
