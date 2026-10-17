/**
 * Parse a key binding string and check if it matches a keyboard event.
 * Supports formats like: "j", "#", "Ctrl+K", "Ctrl+Shift+E", "Ctrl+Enter".
 * "Ctrl" and "Cmd" both match either the Control or the Command key.
 */
export function matchesKey(binding: string, e: KeyboardEvent): boolean {
  const parts = binding.split("+");
  const key = parts[parts.length - 1]!;
  const needsCtrl = parts.some((p) => p === "Ctrl" || p === "Cmd");
  const needsShift = parts.some((p) => p === "Shift");
  const needsAlt = parts.some((p) => p === "Alt");

  const ctrlMatch = needsCtrl ? (e.ctrlKey || e.metaKey) : !(e.ctrlKey || e.metaKey);
  const shiftMatch = needsShift ? e.shiftKey : !e.shiftKey;
  const altMatch = needsAlt ? e.altKey : !e.altKey;

  // For single character keys, compare case-insensitively
  const keyMatch = key.length === 1
    ? e.key === key || e.key === key.toLowerCase() || e.key === key.toUpperCase()
    : e.key === key;

  return ctrlMatch && shiftMatch && altMatch && keyMatch;
}

/** Whether a binding includes Ctrl/Cmd or Alt, so it can't be typed as text. */
export function hasCommandModifier(binding: string): boolean {
  return binding.split("+").some((p) => p === "Ctrl" || p === "Cmd" || p === "Alt");
}

/**
 * Canonical form of a binding for comparison: Cmd and Ctrl are the same key,
 * modifier order doesn't matter and letters are case-insensitive.
 */
export function normalizeBinding(binding: string): string {
  if (binding.includes(" then ")) {
    return binding
      .split(" then ")
      .map((k) => (k.trim().length === 1 ? k.trim().toLowerCase() : k.trim()))
      .join(" then ");
  }
  const parts = binding.split("+");
  const key = parts[parts.length - 1]!;
  const modifiers = new Set(
    parts.slice(0, -1).map((p) => (p === "Cmd" ? "Ctrl" : p)),
  );
  const ordered = ["Ctrl", "Alt", "Shift"].filter((m) => modifiers.has(m));
  return [...ordered, key.length === 1 ? key.toLowerCase() : key].join("+");
}

/**
 * Map each action ID whose binding is shared with another action to the IDs
 * of the other actions using the same key.
 */
export function findShortcutConflicts(
  keyMap: Record<string, string>,
): Map<string, string[]> {
  const byBinding = new Map<string, string[]>();
  for (const [id, keys] of Object.entries(keyMap)) {
    if (!keys) continue;
    const normalized = normalizeBinding(keys);
    byBinding.set(normalized, [...(byBinding.get(normalized) ?? []), id]);
  }

  const conflicts = new Map<string, string[]>();
  for (const ids of byBinding.values()) {
    if (ids.length < 2) continue;
    for (const id of ids) {
      const others = ids.filter((other) => other !== id && !contextScoped(id, other));
      if (others.length > 0) conflicts.set(id, others);
    }
  }
  return conflicts;
}

/**
 * Ticket status, priority and assign share s, p and a with mail, but only on
 * the Freshdesk page. Those pairs are not shown as conflicts.
 */
function contextScoped(left: string, right: string): boolean {
  const pairs = new Set([
    "ticket.status|action.star",
    "ticket.priority|action.pin",
    "ticket.assignee|action.replyAll",
  ]);
  return pairs.has(`${left}|${right}`) || pairs.has(`${right}|${left}`);
}
