/**
 * Integration sync coordinator for Freshdesk tickets, and the read model the
 * ticket list shows.
 *
 * Scope: every outstanding ticket plus done tickets updated in the last 90
 * days; anything older is fetched on demand by ID. Polling is bounded (one
 * run at a time, at most every POLL_INTERVAL), honours Retry-After, and stops
 * on rejected credentials until the operator reconnects or retries by hand.
 */
import { createBackgroundChecker } from "@/services/backgroundCheckers";
import { withReadSnapshot } from "@/services/db/connection";
import {
  getAgents,
  getGroups,
  getFieldChoices,
  getIntegrationAccount,
  getStatusClasses,
  type StatusClass,
} from "@/services/db/freshdesk";
import {
  getCachedTickets,
  getTicketSyncState,
  pruneDoneTickets,
  saveTicketSyncState,
  setCustomerForRequester,
  upsertTickets,
  type TicketSyncState,
  type TicketSyncStateName,
} from "@/services/db/freshdeskTickets";
import { FreshdeskError, type HelpdeskCredentials } from "./client";
import { SAMPLE_TENANT_ID, currentCredentials } from "./connection";
import { SAMPLE_PRIORITIES, SAMPLE_STATUSES, SAMPLE_TICKETS, sampleHistory } from "./sampleData";
import { getStoredHistories } from "@/services/db/freshdeskHistory";
import { activityFrom, summarizeHistory, type TicketActivity } from "./activity";
import { historyStateOf, hydrateTicketHistories } from "./ticketHistory";
import { fetchContactName, fetchTicketById, listTicketsUpdatedSince, searchTicketsByStatus } from "./tickets";

const DAY_S = 86_400;
/** Done tickets updated within this window are kept locally. */
export const DONE_WINDOW_DAYS = 90;
/** Minimum gap between two background runs. */
export const POLL_INTERVAL_S = 5 * 60;
/** A full re-read (outstanding search + 90-day list) at most this often; other runs are deltas. */
const FULL_SYNC_INTERVAL_S = 6 * 60 * 60;
/** Last success older than this shows as stale. */
export const STALE_AFTER_S = 3 * POLL_INTERVAL_S;
/** Delta runs re-read a little before the last success to cover clock skew. */
const DELTA_OVERLAP_S = 5 * 60;
/** Requester names looked up per run for tickets found through search. */
const MAX_CONTACT_LOOKUPS = 20;
const MAX_BACKOFF_S = 60 * 60;

export type TicketSyncTrigger = "manual" | "poll";

export const AUTH_ERROR_MESSAGE =
  "Freshdesk rejected the API key; it may have expired or been revoked. Reconnect the helpdesk in Settings → Freshdesk.";
const RATE_LIMIT_MESSAGE = "Freshdesk asked Velo to slow down. Sync resumes automatically.";

/** A by-ID lookup is not retried for the operator, so it says when trying again can work. */
function lookupRateLimited(retryAfterUntil: number, now: number): FreshdeskError {
  const at = new Date(retryAfterUntil * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return new FreshdeskError(
    "rate_limited",
    `Freshdesk asked Velo to slow down. Try this lookup again after ${at}.`,
    429,
    retryAfterUntil - now,
  );
}

export interface TicketStatusInfo {
  id: string;
  /** Freshdesk's exact label; null when the status ID is not in the helpdesk's metadata */
  label: string | null;
  known: boolean;
  statusClass: StatusClass | null;
}

export interface TicketListItem {
  id: string;
  subject: string;
  customer: string | null;
  customerEmail: string | null;
  status: TicketStatusInfo;
  priority: { id: string; label: string } | null;
  assignee: string | null;
  assigneeId: string | null;
  group: { id: string; name: string } | null;
  companyId: string | null;
  tags: string[];
  /** Addresses copied on the ticket (cc_emails); valid addresses only */
  ccEmails: string[];
  /** Addresses copied on replies (reply_cc_emails) */
  replyCcEmails: string[];
  /** Addresses the ticket was forwarded to (fwd_emails) */
  fwdEmails: string[];
  /** Resolution due (SLA), unix ms */
  dueBy: number | null;
  /** Created, unix ms */
  createdAt: number;
  /** Last updated, unix ms */
  updatedAt: number;
  /** Not classified done; unknown statuses count as outstanding */
  outstanding: boolean;
  /** Derived from the conversation history; Unknown until it is fully loaded */
  activity: TicketActivity;
  fetchedOnDemand: boolean;
  isSample: boolean;
}

export interface TicketSyncStatus {
  state: TicketSyncStateName | "sample";
  /** Unix ms */
  lastSuccessAt: number | null;
  stale: boolean;
  /** When a rate-limit or error backoff ends, unix ms */
  retryAt: number | null;
  /** Actionable text for the operator; never contains credentials */
  message: string | null;
  coverage: {
    complete: boolean;
    outstandingTotal: number | null;
    outstandingDownloaded: number | null;
  };
}

export interface TicketListData {
  isSample: boolean;
  /** The verified agent ID of the operator; null in sample mode */
  meAgentId: string | null;
  tickets: TicketListItem[];
  sync: TicketSyncStatus;
}

const nowS = () => Math.floor(Date.now() / 1000);
const msOrNull = (s: number | null) => (s === null ? null : s * 1000);

// ---------- read model ----------

function syncStatusFrom(state: TicketSyncState, now: number): TicketSyncStatus {
  return {
    state: state.state,
    lastSuccessAt: msOrNull(state.lastSuccessAt),
    stale: state.lastSuccessAt === null || now - state.lastSuccessAt > STALE_AFTER_S,
    retryAt: state.retryAfterUntil !== null && state.retryAfterUntil > now ? state.retryAfterUntil * 1000 : null,
    message: state.errorMessage,
    coverage: {
      complete: state.coverageComplete,
      outstandingTotal: state.outstandingTotal,
      outstandingDownloaded: state.outstandingDownloaded,
    },
  };
}

function statusInfo(id: string, labels: Map<string, string>, classes: Map<string, StatusClass>): TicketStatusInfo {
  const label = labels.get(id) ?? null;
  return { id, label, known: label !== null, statusClass: label !== null ? (classes.get(id) ?? null) : null };
}

function sampleActivity(ticketId: string, outstanding: boolean, now: number): TicketActivity {
  const sample = sampleHistory(ticketId, now);
  if (!sample) return activityFrom(null, "not_loaded", outstanding);
  const [request, ...conversations] = sample.entries.map((e) => ({ kind: e.kind, createdAt: Math.floor(e.at / 1000) }));
  const summary = summarizeHistory(
    { createdAt: request?.createdAt ?? Math.floor(now / 1000), ticketSource: null },
    conversations.filter((c): c is { kind: Exclude<typeof c.kind, "request">; createdAt: number } => c.kind !== "request"),
  );
  return activityFrom(summary, sample.history, outstanding);
}

function sampleList(classes: Map<string, StatusClass>): TicketListData {
  const statusLabels = new Map(SAMPLE_STATUSES.map((s) => [s.id, s.label]));
  const priorityLabels = new Map(SAMPLE_PRIORITIES.map((p) => [p.id, p.label]));
  const now = Date.now();
  return {
    isSample: true,
    meAgentId: null,
    tickets: SAMPLE_TICKETS.map((t) => {
      const status = statusInfo(t.statusId, statusLabels, classes);
      const priorityLabel = priorityLabels.get(t.priorityId);
      return {
        id: t.id,
        subject: t.subject,
        customer: t.customerName,
        customerEmail: null,
        status,
        priority: priorityLabel ? { id: t.priorityId, label: priorityLabel } : null,
        assignee: t.assigneeName,
        assigneeId: null,
        group: null,
        companyId: null,
        tags: [],
        ccEmails: [],
        replyCcEmails: [],
        fwdEmails: [],
        dueBy: null,
        createdAt: now - (t.updatedMinutesAgo + 60) * 60_000,
        updatedAt: now - t.updatedMinutesAgo * 60_000,
        outstanding: status.statusClass !== "done",
        activity: sampleActivity(t.id, status.statusClass !== "done", now),
        fetchedOnDemand: false,
        isSample: true,
      };
    }),
    sync: {
      state: "sample",
      lastSuccessAt: null,
      stale: false,
      retryAt: null,
      message: null,
      coverage: { complete: false, outstandingTotal: null, outstandingDownloaded: null },
    },
  };
}

/** What the ticket list shows: cached tickets with exact labels, or marked sample data when not connected. */
export function getTicketList(): Promise<TicketListData> {
  return withReadSnapshot(readTicketList);
}

async function readTicketList(): Promise<TicketListData> {
  const account = await getIntegrationAccount("freshdesk");
  if (!account) return sampleList(await getStatusClasses(SAMPLE_TENANT_ID));

  const { tenantId } = account;
  const [tickets, statuses, priorities, agents, groups, classes, state, histories] = await Promise.all([
    getCachedTickets(tenantId),
    getFieldChoices(tenantId, "status"),
    getFieldChoices(tenantId, "priority"),
    getAgents(tenantId),
    getGroups(tenantId),
    getStatusClasses(tenantId),
    getTicketSyncState(tenantId),
    getStoredHistories(tenantId),
  ]);
  const statusLabels = new Map(statuses.map((c) => [c.choiceId, c.label]));
  const priorityLabels = new Map(priorities.map((c) => [c.choiceId, c.label]));
  const agentNames = new Map(agents.map((a) => [a.agentId, a.name]));
  const groupNames = new Map(groups.map((g) => [g.groupId, g.name]));

  return {
    isSample: false,
    meAgentId: account.me?.agentId ?? null,
    tickets: tickets.map((t) => {
      const status = statusInfo(t.statusId, statusLabels, classes);
      const priorityLabel = t.priorityId !== null ? priorityLabels.get(t.priorityId) : undefined;
      const outstanding = status.statusClass !== "done";
      const stored = histories.get(t.ticketId);
      return {
        id: t.ticketId,
        subject: t.subject,
        customer: t.customerName,
        customerEmail: t.customerEmail,
        status,
        priority: t.priorityId !== null ? { id: t.priorityId, label: priorityLabel ?? `Priority ${t.priorityId}` } : null,
        assignee: t.responderId !== null ? (agentNames.get(t.responderId) ?? `Agent ${t.responderId}`) : null,
        assigneeId: t.responderId,
        group: t.groupId !== null ? { id: t.groupId, name: groupNames.get(t.groupId) ?? `Group ${t.groupId}` } : null,
        companyId: t.companyId,
        tags: t.tags,
        ccEmails: t.ccEmails ?? [],
        replyCcEmails: t.replyCcEmails ?? [],
        fwdEmails: t.fwdEmails ?? [],
        dueBy: msOrNull(t.dueBy),
        createdAt: t.createdAt * 1000,
        updatedAt: t.updatedAt * 1000,
        outstanding,
        activity: activityFrom(stored?.summary ?? null, historyStateOf(t, stored), outstanding),
        fetchedOnDemand: t.fetchedOnDemand,
        isSample: false,
      };
    }),
    sync: syncStatusFrom(state, nowS()),
  };
}

// ---------- sync ----------

let inFlight: Promise<TicketSyncStatus> | null = null;

function backoffSeconds(failures: number): number {
  return Math.min(60 * 2 ** failures, MAX_BACKOFF_S);
}

async function hydrateCustomers(tenantId: string, credentials: HelpdeskCredentials): Promise<void> {
  const missing = [
    ...new Set(
      (await getCachedTickets(tenantId))
        .filter((t) => t.customerName === null && t.requesterId !== null)
        .map((t) => t.requesterId as string),
    ),
  ].slice(0, MAX_CONTACT_LOOKUPS);
  for (const requesterId of missing) {
    try {
      await setCustomerForRequester(tenantId, requesterId, await fetchContactName(credentials, requesterId));
    } catch (err) {
      // A requester can be an agent rather than a contact; leave the name unknown
      if (err instanceof FreshdeskError && err.kind === "not_found") continue;
      throw err;
    }
  }
}

async function runSync(trigger: TicketSyncTrigger): Promise<TicketSyncStatus> {
  const current = await currentCredentials();
  if (!current) return sampleList(new Map()).sync;
  const { tenantId, credentials } = current;
  const now = nowS();
  const state = await getTicketSyncState(tenantId);

  // Rejected credentials: background polling waits for a reconnect; a manual retry tries once
  if (state.state === "auth_error" && trigger === "poll") {
    return syncStatusFrom(state, now);
  }
  if (state.retryAfterUntil !== null && state.retryAfterUntil > now) return syncStatusFrom(state, now);
  // After a failure the backoff above decides; after a success, the poll interval
  if (trigger === "poll" && state.state === "ok" && state.lastAttemptAt !== null && now - state.lastAttemptAt < POLL_INTERVAL_S) {
    return syncStatusFrom(state, now);
  }

  const next: TicketSyncState = { ...state, lastAttemptAt: now };
  try {
    const full = state.lastFullSyncAt === null || state.lastSuccessAt === null || now - state.lastFullSyncAt >= FULL_SYNC_INTERVAL_S;
    if (full) {
      const recent = await listTicketsUpdatedSince(credentials, now - DONE_WINDOW_DAYS * DAY_S);
      const [statuses, classes] = await withReadSnapshot(() =>
        Promise.all([getFieldChoices(tenantId, "status"), getStatusClasses(tenantId)]),
      );
      const outstandingIds = statuses.filter((s) => classes.get(s.choiceId) !== "done").map((s) => s.choiceId);
      const doneIds = statuses.filter((s) => classes.get(s.choiceId) === "done").map((s) => s.choiceId);
      const outstanding = await searchTicketsByStatus(credentials, outstandingIds);
      await upsertTickets(tenantId, recent.tickets);
      await upsertTickets(tenantId, outstanding.tickets);
      await pruneDoneTickets(tenantId, doneIds, now - DONE_WINDOW_DAYS * DAY_S);
      next.lastFullSyncAt = now;
      next.outstandingTotal = outstanding.total;
      next.outstandingDownloaded = outstanding.tickets.length;
      next.coverageComplete = recent.complete && outstanding.tickets.length >= outstanding.total;
    } else {
      const changed = await listTicketsUpdatedSince(credentials, (state.lastSuccessAt as number) - DELTA_OVERLAP_S);
      await upsertTickets(tenantId, changed.tickets);
      if (!changed.complete) next.coverageComplete = false;
    }
    await hydrateCustomers(tenantId, credentials);
    Object.assign(next, {
      state: "ok",
      lastSuccessAt: now,
      retryAfterUntil: null,
      consecutiveFailures: 0,
      errorMessage: null,
    } satisfies Partial<TicketSyncState>);
  } catch (err) {
    const kind = err instanceof FreshdeskError ? err.kind : "network";
    console.warn(`[FreshdeskTickets] sync failed: ${kind}`);
    next.consecutiveFailures = state.consecutiveFailures + 1;
    if (kind === "auth") {
      Object.assign(next, { state: "auth_error", retryAfterUntil: null, errorMessage: AUTH_ERROR_MESSAGE });
    } else if (kind === "rate_limited") {
      const wait = (err as FreshdeskError).retryAfterSeconds ?? backoffSeconds(state.consecutiveFailures);
      Object.assign(next, { state: "rate_limited", retryAfterUntil: now + wait, errorMessage: RATE_LIMIT_MESSAGE });
    } else {
      Object.assign(next, {
        state: "error",
        retryAfterUntil: now + backoffSeconds(state.consecutiveFailures),
        errorMessage: kind === "network" ? "Couldn't reach Freshdesk. Velo will retry." : "Freshdesk sync failed. Velo will retry.",
      });
    }
  }
  await saveTicketSyncState(tenantId, next);
  return syncStatusFrom(next, now);
}

/**
 * Reads tickets from the helpdesk into the local cache. Concurrent calls share
 * one run. Background polls skip while a backoff, an auth failure or the poll
 * interval says to wait; a manual refresh skips only during Retry-After.
 */
export function syncTickets(opts: { trigger: TicketSyncTrigger }): Promise<TicketSyncStatus> {
  if (!inFlight) {
    inFlight = runSync(opts.trigger).finally(() => {
      inFlight = null;
    });
    void inFlight.then(() => window.dispatchEvent(new Event("velo-tickets-synced")));
  }
  return inFlight;
}

/**
 * Fetches one ticket outside the default scope (an older done ticket) by its
 * helpdesk ID and keeps it locally. Null when the helpdesk has no such ticket.
 */
export async function fetchOlderTicket(ticketId: string): Promise<TicketListItem | null> {
  const id = ticketId.trim().replace(/^#/, "");
  if (!/^\d+$/.test(id)) return null;
  const current = await currentCredentials();
  if (!current) return null;
  const { tenantId, credentials } = current;
  const state = await getTicketSyncState(tenantId);
  const now = nowS();
  if (state.retryAfterUntil !== null && state.retryAfterUntil > now) {
    throw lookupRateLimited(state.retryAfterUntil, now);
  }
  try {
    await upsertTickets(tenantId, [await fetchTicketById(credentials, id)]);
  } catch (err) {
    if (err instanceof FreshdeskError && err.kind === "not_found") return null;
    if (err instanceof FreshdeskError && err.kind === "rate_limited") {
      const wait = err.retryAfterSeconds ?? backoffSeconds(state.consecutiveFailures);
      await saveTicketSyncState(tenantId, { ...state, state: "rate_limited", retryAfterUntil: now + wait, errorMessage: RATE_LIMIT_MESSAGE });
      throw lookupRateLimited(now + wait, now);
    }
    throw err;
  }
  window.dispatchEvent(new Event("velo-tickets-synced"));
  return (await getTicketList()).tickets.find((t) => t.id === id) ?? null;
}

const ticketPoller = createBackgroundChecker(
  "FreshdeskTickets",
  async () => {
    await syncTickets({ trigger: "poll" });
    await hydrateTicketHistories();
  },
  60_000,
);
export const startTicketSync = ticketPoller.start;
export const stopTicketSync = ticketPoller.stop;
