/**
 * Conversation history: bounded background hydration of each ticket's
 * original request and conversations, and the read model the ticket reader
 * shows.
 *
 * Hydration reads the opened ticket first, then the visible ones, then the
 * rest; at most MAX_TICKETS_PER_RUN tickets per run, one run at a time. A
 * ticket is read again only when Freshdesk reports a newer update. A 429
 * stops the run and sets the shared Retry-After wait the ticket sync honours
 * too; a history cut short stays incomplete, so its metrics show Unknown.
 */
import { getAgents, getIntegrationAccount, getStatusClasses } from "@/services/db/freshdesk";
import { getCachedTickets, getTicketSyncState, saveTicketSyncState, upsertTickets, type CachedTicket } from "@/services/db/freshdeskTickets";
import { getStoredHistories, getStoredHistory, saveTicketHistory, type StoredHistory } from "@/services/db/freshdeskHistory";
import {
  TICKET_SOURCE_OUTBOUND_EMAIL,
  decodeAttachments,
  decodeConversation,
  summarizeHistory,
  type ConversationAttachment,
  type ConversationKind,
  type DecodedConversation,
  type HistoryState,
} from "./activity";
import { FreshdeskError, freshdeskGet, type HelpdeskCredentials } from "./client";
import { currentCredentials } from "./connection";
import { sampleHistory } from "./sampleData";
import { decodeTicket } from "./tickets";

/** Tickets read per hydration run. */
export const MAX_TICKETS_PER_RUN = 8;
/** Freshdesk's largest conversation page. */
const CONVERSATION_PAGE_SIZE = 100;
/** Bounds one ticket's read; a longer history stays incomplete (Unknown). */
const MAX_CONVERSATION_PAGES = 10;
/** A ticket whose read failed (other than rate limiting) is skipped for this long. */
const FAILURE_COOLDOWN_S = 5 * 60;
const MAX_BACKOFF_S = 60 * 60;
const RATE_LIMIT_MESSAGE = "Freshdesk asked Velo to slow down. Sync resumes automatically.";

const nowS = () => Math.floor(Date.now() / 1000);

/** not_loaded, incomplete (partly read, or the ticket changed since) or complete. */
export function historyStateOf(ticket: Pick<CachedTicket, "updatedAt">, stored: StoredHistory | undefined): HistoryState {
  if (!stored) return "not_loaded";
  const current = stored.hydratedForUpdatedAt !== null && stored.hydratedForUpdatedAt >= ticket.updatedAt;
  return stored.historyComplete && current ? "complete" : "incomplete";
}

function needsHydration(ticket: CachedTicket, stored: StoredHistory | undefined): boolean {
  return !stored || stored.hydratedForUpdatedAt === null || stored.hydratedForUpdatedAt < ticket.updatedAt;
}

// ---------- hydration ----------

export interface HydrationFocus {
  /** The ticket open in the reader */
  openedId?: string | null;
  /** The tickets the list shows, top first */
  visibleIds?: string[];
}

let focus: { openedId: string | null; visibleIds: string[] } = { openedId: null, visibleIds: [] };
let inFlight: Promise<string[]> | null = null;
let focusChangedDuringRun = false;
const failedAt = new Map<string, number>();

async function readHistory(
  tenantId: string,
  credentials: HelpdeskCredentials,
  ticketId: string,
  humanAgentIds: ReadonlySet<string>,
): Promise<void> {
  const raw = await freshdeskGet<Record<string, unknown>>(credentials, `/tickets/${encodeURIComponent(ticketId)}`);
  const ticket = decodeTicket(raw);
  await upsertTickets(tenantId, [ticket]);
  const request = {
    ticketId,
    ticketSource: typeof raw.source === "number" ? raw.source : null,
    descriptionHtml: typeof raw.description === "string" ? raw.description : null,
    descriptionText: typeof raw.description_text === "string" ? raw.description_text : null,
    attachments: decodeAttachments(raw.attachments),
  };

  const conversations: DecodedConversation[] = [];
  const save = (complete: boolean, hydratedFor: number | null) =>
    saveTicketHistory(
      tenantId,
      {
        ...request,
        historyComplete: complete,
        hydratedForUpdatedAt: hydratedFor,
        hydratedAt: nowS(),
        summary: summarizeHistory({ createdAt: ticket.createdAt, ticketSource: request.ticketSource }, conversations),
      },
      conversations,
    );

  for (let page = 1; page <= MAX_CONVERSATION_PAGES; page++) {
    let batch: unknown;
    try {
      batch = await freshdeskGet<unknown>(
        credentials,
        `/tickets/${encodeURIComponent(ticketId)}/conversations?per_page=${CONVERSATION_PAGE_SIZE}&page=${page}`,
      );
      if (!Array.isArray(batch)) throw new FreshdeskError("server", "Freshdesk returned an unexpected conversation list");
    } catch (err) {
      // Keep what was read; with no hydrated-for mark the next run reads it again
      await save(false, null);
      throw err;
    }
    for (const rawConversation of batch) {
      const decoded = decodeConversation(rawConversation, humanAgentIds);
      if (decoded) conversations.push(decoded);
    }
    if (batch.length < CONVERSATION_PAGE_SIZE) {
      await save(true, ticket.updatedAt);
      return;
    }
  }
  // Longer than one run may read: incomplete until the ticket changes
  await save(false, ticket.updatedAt);
}

async function runHydration(): Promise<string[]> {
  const current = await currentCredentials();
  if (!current) return [];
  const { tenantId, credentials } = current;
  const now = nowS();
  const state = await getTicketSyncState(tenantId);
  if (state.state === "auth_error") return [];
  if (state.retryAfterUntil !== null && state.retryAfterUntil > now) return [];

  const [tickets, histories, agents, classes] = await Promise.all([
    getCachedTickets(tenantId),
    getStoredHistories(tenantId),
    getAgents(tenantId),
    getStatusClasses(tenantId),
  ]);
  const byId = new Map(tickets.map((t) => [t.ticketId, t]));
  const outstanding = tickets.filter((t) => classes.get(t.statusId) !== "done");
  const order = [
    ...(focus.openedId ? [focus.openedId] : []),
    ...focus.visibleIds,
    ...outstanding.map((t) => t.ticketId),
    ...tickets.map((t) => t.ticketId),
  ];
  const queue = [...new Set(order)]
    .filter((id) => {
      const ticket = byId.get(id);
      const failed = failedAt.get(id);
      return ticket && needsHydration(ticket, histories.get(id)) && (failed === undefined || now - failed >= FAILURE_COOLDOWN_S);
    })
    .slice(0, MAX_TICKETS_PER_RUN);

  const humanAgentIds = new Set(agents.map((a) => a.agentId));
  const hydrated: string[] = [];
  for (const ticketId of queue) {
    try {
      await readHistory(tenantId, credentials, ticketId, humanAgentIds);
      failedAt.delete(ticketId);
      hydrated.push(ticketId);
    } catch (err) {
      const kind = err instanceof FreshdeskError ? err.kind : "network";
      console.warn(`[FreshdeskHistory] read failed: ${kind}`);
      hydrated.push(ticketId);
      if (kind === "rate_limited") {
        const latest = await getTicketSyncState(tenantId);
        const wait = (err as FreshdeskError).retryAfterSeconds ?? Math.min(60 * 2 ** latest.consecutiveFailures, MAX_BACKOFF_S);
        await saveTicketSyncState(tenantId, { ...latest, state: "rate_limited", retryAfterUntil: nowS() + wait, errorMessage: RATE_LIMIT_MESSAGE });
        break;
      }
      if (kind === "auth" || kind === "network") break;
      failedAt.set(ticketId, now);
    }
  }
  return hydrated;
}

/**
 * Reads conversation histories in the background, the opened and visible
 * tickets first. Concurrent calls share one run; a focus change during a run
 * triggers one more. Resolves to the tickets whose stored history changed.
 */
export function hydrateTicketHistories(next?: HydrationFocus): Promise<string[]> {
  if (next) {
    focus = { openedId: next.openedId ?? null, visibleIds: next.visibleIds ?? [] };
    if (inFlight) focusChangedDuringRun = true;
  }
  if (!inFlight) {
    inFlight = (async () => {
      const changed: string[] = [];
      do {
        focusChangedDuringRun = false;
        changed.push(...(await runHydration()));
      } while (focusChangedDuringRun);
      return changed;
    })().finally(() => {
      inFlight = null;
    });
    void inFlight.then((changed) => {
      if (changed.length > 0) window.dispatchEvent(new Event("velo-tickets-synced"));
    });
  }
  return inFlight;
}

/** Forgets failure cooldowns (tests and reconnects). */
export function resetHydrationState(): void {
  failedAt.clear();
  focus = { openedId: null, visibleIds: [] };
}

// ---------- reader ----------

export type EntryKind = ConversationKind | "request";

export interface HistoryEntry {
  /** "request" for the original request, else the conversation ID */
  id: string;
  kind: EntryKind;
  /** Internal notes are visible to agents only */
  visibility: "public" | "internal";
  author: string;
  /** Unix ms */
  at: number;
  /** Untrusted HTML from the helpdesk; render only through the sanitising renderer */
  bodyHtml: string | null;
  bodyText: string | null;
  attachments: ConversationAttachment[];
}

export interface TicketHistoryView {
  ticketId: string;
  isSample: boolean;
  history: HistoryState;
  /** The original request, then conversations, oldest first */
  entries: HistoryEntry[];
}

function authorOf(
  kind: EntryKind,
  userId: string | null,
  fromEmail: string | null,
  ticket: CachedTicket,
  agentNames: Map<string, string>,
): string {
  const agent = userId !== null ? agentNames.get(userId) : undefined;
  const customer = ticket.customerName ?? ticket.customerEmail ?? "Customer";
  switch (kind) {
    case "customer_message":
      return userId !== null && userId === ticket.requesterId ? customer : (fromEmail ?? "Customer");
    case "automated_reply":
      return agent ? `Automation (as ${agent})` : "Automation";
    case "unverified_reply":
      return `Unverified author${userId ? ` (ID ${userId})` : ""}`;
    default:
      return agent ?? (userId !== null ? `Agent ${userId}` : "Agent");
  }
}

/** The opened ticket's history as stored, or the marked sample history in sample mode. */
export async function getTicketHistory(ticketId: string): Promise<TicketHistoryView | null> {
  const account = await getIntegrationAccount("freshdesk");
  if (!account) {
    const sample = sampleHistory(ticketId, Date.now());
    return sample ? { ticketId, isSample: true, ...sample } : null;
  }
  const { tenantId } = account;
  const ticket = (await getCachedTickets(tenantId)).find((t) => t.ticketId === ticketId);
  if (!ticket) return null;
  const stored = await getStoredHistory(tenantId, ticketId);
  if (!stored) return { ticketId, isSample: false, history: "not_loaded", entries: [] };

  const agentNames = new Map((await getAgents(tenantId)).map((a) => [a.agentId, a.name]));
  const { history, conversations } = stored;
  const outbound = history.ticketSource === TICKET_SOURCE_OUTBOUND_EMAIL;
  const request: HistoryEntry = {
    id: "request",
    kind: "request",
    visibility: "public",
    author: outbound
      ? (ticket.responderId !== null ? (agentNames.get(ticket.responderId) ?? "Agent") : "Agent")
      : (ticket.customerName ?? ticket.customerEmail ?? "Customer"),
    at: ticket.createdAt * 1000,
    bodyHtml: history.descriptionHtml,
    bodyText: history.descriptionText,
    attachments: history.attachments,
  };
  return {
    ticketId,
    isSample: false,
    history: historyStateOf(ticket, history),
    entries: [
      request,
      ...conversations.map((c) => ({
        id: c.conversationId,
        kind: c.kind,
        visibility: c.kind === "internal_note" ? ("internal" as const) : ("public" as const),
        author: authorOf(c.kind, c.userId, c.fromEmail, ticket, agentNames),
        at: c.createdAt * 1000,
        bodyHtml: c.bodyHtml,
        bodyText: c.bodyText,
        attachments: c.attachments,
      })),
    ],
  };
}
