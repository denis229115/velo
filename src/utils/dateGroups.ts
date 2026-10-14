export interface DateGroup<T> {
  /** Stable key for React lists */
  key: string;
  label: string;
  items: T[];
}

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function labelFor(ts: number, now: number): string {
  const date = new Date(ts);
  const today = startOfDay(now);
  // Calendar-day difference, robust to DST shifts
  const days = Math.round((today - startOfDay(ts)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return date.toLocaleDateString("en-US", { weekday: "long" });
  const current = new Date(now);
  if (date.getFullYear() === current.getFullYear()) {
    if (date.getMonth() === current.getMonth()) return "Earlier this month";
    return date.toLocaleDateString("en-US", { month: "long" });
  }
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

/**
 * Splits an already-sorted list into Today / Yesterday / weekday / month groups.
 * Order is preserved: only neighbouring items with the same label share a group.
 */
export function groupByDate<T>(items: T[], getTime: (item: T) => number, now = Date.now()): DateGroup<T>[] {
  const groups: DateGroup<T>[] = [];
  for (const item of items) {
    const label = labelFor(getTime(item), now);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.items.push(item);
    else groups.push({ key: `${label}-${groups.length}`, label, items: [item] });
  }
  return groups;
}
