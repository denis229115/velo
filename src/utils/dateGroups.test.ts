import { groupByDate } from "./dateGroups";

// Wednesday 14 October 2026, 15:00 local time
const NOW = new Date(2026, 9, 14, 15, 0).getTime();
const at = (y: number, m: number, d: number, h = 9) => ({ id: `${y}-${m}-${d}-${h}`, ts: new Date(y, m, d, h).getTime() });

function labels(items: { id: string; ts: number }[]) {
  return groupByDate(items, (i) => i.ts, NOW).map((g) => [g.label, g.items.map((i) => i.id)]);
}

describe("groupByDate", () => {
  it("groups mail into Today, Yesterday, weekdays for the past week, then months", () => {
    const items = [
      at(2026, 9, 14, 11),
      at(2026, 9, 14, 8),
      at(2026, 9, 13, 23),
      at(2026, 9, 12),
      at(2026, 9, 9),
      at(2026, 9, 2),
      at(2026, 8, 20),
      at(2025, 11, 3),
    ];
    expect(labels(items)).toEqual([
      ["Today", ["2026-9-14-11", "2026-9-14-8"]],
      ["Yesterday", ["2026-9-13-23"]],
      ["Monday", ["2026-9-12-9"]],
      ["Friday", ["2026-9-9-9"]],
      ["Earlier this month", ["2026-9-2-9"]],
      ["September", ["2026-8-20-9"]],
      ["December 2025", ["2025-11-3-9"]],
    ]);
  });

  it("keeps the input order and merges equal neighbouring groups only", () => {
    const items = [at(2026, 9, 14), at(2026, 9, 13), at(2026, 9, 14, 7)];
    expect(labels(items).map(([l]) => l)).toEqual(["Today", "Yesterday", "Today"]);
  });

  it("returns no groups for an empty list", () => {
    expect(groupByDate([], () => 0, NOW)).toEqual([]);
  });
});
