import type { StatusClass } from "@/services/db/freshdesk";
import type { EmailDensity } from "@/stores/uiStore";
import type { TicketListData, TicketListItem } from "./ticketSync";

/**
 * The ticket view engine: pure filter and sort predicates shared by every
 * presentation of a ticket view (list now, board later), so both always show
 * exactly the same tickets.
 *
 * Filters match status IDs and status classes, never display names. Fields
 * combine with AND; the values within one field combine with OR.
 */

/** "outstanding" matches every status not classified done, unknown statuses included. */
export type StatusClassFilter = StatusClass | "outstanding";

/** "me" is the verified agent identity, "unassigned" no agent; anything else is an agent ID. */
export type AssigneeFilter = "me" | "unassigned" | (string & {});

export interface TicketViewFilter {
  statusIds?: string[];
  statusClasses?: StatusClassFilter[];
  assignees?: AssigneeFilter[];
  groupIds?: string[];
  priorityIds?: string[];
  companyIds?: string[];
  tags?: string[];
  /** Created or last updated within the last N days */
  dates?: { field: "created" | "updated"; withinDays: number };
  needsReply?: boolean;
}

/** Filters Freshdesk's ticket search can apply itself */
export type ServerTicketFilter = Pick<TicketViewFilter, "statusIds" | "groupIds" | "priorityIds" | "companyIds" | "tags" | "dates"> & {
  agentIds?: string[];
  unassigned?: boolean;
};

/** Filters only Velo can apply: they need the operator's classification, identity or the loaded history */
export type LocalTicketFilter = Pick<TicketViewFilter, "statusClasses" | "needsReply"> & { me?: boolean };

export type TicketSortKey = "priority" | "customer_waiting" | "updated" | "created";
export type OptionalTicketColumn = "company_group" | "sla_due";
export type TicketPresentation = "list" | "board";

export interface TicketView {
  id: string;
  kind: "preset" | "custom";
  name: string;
  filter: TicketViewFilter;
  sort: TicketSortKey;
  columns: OptionalTicketColumn[];
  density: EmailDensity;
  presentation: TicketPresentation;
  /** Board column state, kept for the board presentation */
  board: { collapsedStatusIds?: string[] };
}

export const SORT_LABELS: Record<TicketSortKey, string> = {
  priority: "Priority, then oldest",
  customer_waiting: "Customer waiting longest",
  updated: "Last updated",
  created: "Oldest first",
};

export const DEFAULT_VIEW_ID = "preset:all-outstanding";

const preset = (id: string, name: string, filter: TicketViewFilter, sort: TicketSortKey = "priority"): TicketView => ({
  id: `preset:${id}`,
  kind: "preset",
  name,
  filter,
  sort,
  columns: [],
  density: "compact",
  presentation: "list",
  board: {},
});

/** The preset views, seeded from the status classification. */
export function presetViews(hasWaitingStatus: boolean): TicketView[] {
  return [
    preset("my-open", "My open tickets", { assignees: ["me"], statusClasses: ["open"] }),
    preset("my-outstanding", "My outstanding tickets", { assignees: ["me"], statusClasses: ["outstanding"] }),
    preset("needs-reply", "Needs reply", { statusClasses: ["outstanding"], needsReply: true }, "customer_waiting"),
    preset("unassigned", "Unassigned", { assignees: ["unassigned"], statusClasses: ["outstanding"] }),
    preset("all-outstanding", "All outstanding", { statusClasses: ["outstanding"] }),
    ...(hasWaitingStatus ? [preset("waiting", "Waiting on customer", { statusClasses: ["waiting"] })] : []),
  ];
}

export function splitTicketFilter(filter: TicketViewFilter): { server: ServerTicketFilter; local: LocalTicketFilter } {
  const { statusClasses, needsReply, assignees, ...rest } = filter;
  const agentIds = assignees?.filter((a) => a !== "me" && a !== "unassigned");
  return {
    server: {
      ...rest,
      ...(agentIds?.length ? { agentIds } : {}),
      ...(assignees?.includes("unassigned") ? { unassigned: true } : {}),
    },
    local: {
      ...(statusClasses?.length ? { statusClasses } : {}),
      ...(needsReply !== undefined ? { needsReply } : {}),
      ...(assignees?.includes("me") ? { me: true } : {}),
    },
  };
}

const DAY_MS = 86_400_000;

function anyOf<T>(values: T[] | undefined, match: (v: T) => boolean): boolean {
  return !values?.length || values.some(match);
}

function matchesExceptNeedsReply(t: TicketListItem, f: TicketViewFilter, meAgentId: string | null, now: number): boolean {
  return (
    anyOf(f.statusIds, (id) => t.status.id === id) &&
    anyOf(f.statusClasses, (c) => (c === "outstanding" ? t.outstanding : t.status.statusClass === c)) &&
    anyOf(f.assignees, (a) =>
      a === "me" ? meAgentId !== null && t.assigneeId === meAgentId : a === "unassigned" ? t.assigneeId === null : t.assigneeId === a,
    ) &&
    anyOf(f.groupIds, (id) => t.group?.id === id) &&
    anyOf(f.priorityIds, (id) => t.priority?.id === id) &&
    anyOf(f.companyIds, (id) => t.companyId === id) &&
    anyOf(f.tags, (tag) => t.tags.includes(tag)) &&
    (!f.dates || (f.dates.field === "created" ? t.createdAt : t.updatedAt) >= now - f.dates.withinDays * DAY_MS)
  );
}

function matches(t: TicketListItem, f: TicketViewFilter, meAgentId: string | null, now: number): boolean {
  if (!matchesExceptNeedsReply(t, f, meAgentId, now)) return false;
  // Unknown needs-reply (history still loading) matches neither yes nor no; coverage says so
  return f.needsReply === undefined || t.activity.needsReply === f.needsReply;
}

const priorityRank = (t: TicketListItem) => (t.priority ? Number(t.priority.id) || 0 : 0);
const waitingSince = (t: TicketListItem) =>
  t.activity.needsReply === true && t.activity.lastCustomerMessage.state === "known" ? t.activity.lastCustomerMessage.at : Infinity;

const byPriorityThenOldest = (a: TicketListItem, b: TicketListItem) =>
  priorityRank(b) - priorityRank(a) || a.createdAt - b.createdAt || Number(a.id) - Number(b.id);

const COMPARATORS: Record<TicketSortKey, (a: TicketListItem, b: TicketListItem) => number> = {
  priority: byPriorityThenOldest,
  customer_waiting: (a, b) => waitingSince(a) - waitingSince(b) || byPriorityThenOldest(a, b),
  updated: (a, b) => b.updatedAt - a.updatedAt || Number(b.id) - Number(a.id),
  created: (a, b) => a.createdAt - b.createdAt || Number(a.id) - Number(b.id),
};

/** The tickets a view shows, in its sort order. */
export function applyTicketView(
  view: Pick<TicketView, "filter" | "sort">,
  data: TicketListData | null,
  now = Date.now(),
): TicketListItem[] {
  if (!data) return [];
  return data.tickets.filter((t) => matches(t, view.filter, data.meAgentId, now)).sort(COMPARATORS[view.sort]);
}

export interface ViewCoverage {
  complete: boolean;
  /** Why the local copy may not hold every ticket the view asks for */
  reasons: string[];
}

/** True when the filter can only match outstanding tickets, the part of the helpdesk Velo downloads in full. */
function outstandingOnly(f: TicketViewFilter): boolean {
  return !!f.statusClasses?.length && f.statusClasses.every((c) => c !== "done");
}

/** Whether the local copy holds every ticket the view asks for; partial or stale coverage is always named. */
export function viewCoverage(view: Pick<TicketView, "filter">, data: TicketListData, now = Date.now()): ViewCoverage {
  if (data.isSample) return { complete: false, reasons: ["sample data"] };
  const reasons: string[] = [];
  const { coverage, stale } = data.sync;
  if (!coverage.complete) {
    reasons.push(
      coverage.outstandingTotal === null
        ? "coverage unknown until the first full sync"
        : `${coverage.outstandingDownloaded ?? 0} of ${coverage.outstandingTotal} outstanding tickets downloaded`,
    );
  }
  if (stale) reasons.push("last sync is out of date");
  if (!outstandingOnly(view.filter)) reasons.push("done tickets only from the last 90 days");
  if (view.filter.needsReply !== undefined) {
    const loading = data.tickets.filter(
      (t) => t.activity.needsReply === null && matchesExceptNeedsReply(t, view.filter, data.meAgentId, now),
    ).length;
    if (loading > 0) reasons.push(`history still loading for ${loading} ticket${loading === 1 ? "" : "s"}`);
  }
  return { complete: reasons.length === 0, reasons };
}

/** Optional columns are offered only when Freshdesk provides their data. */
export function availableOptionalColumns(data: TicketListData | null): OptionalTicketColumn[] {
  const tickets = data?.tickets ?? [];
  return [
    ...(tickets.some((t) => t.group !== null || t.companyId !== null) ? (["company_group"] as const) : []),
    ...(tickets.some((t) => t.dueBy !== null) ? (["sla_due"] as const) : []),
  ];
}
