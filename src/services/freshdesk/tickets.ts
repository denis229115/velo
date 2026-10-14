import type { CachedTicket } from "@/services/db/freshdeskTickets";
import { FreshdeskError, freshdeskGet, type HelpdeskCredentials } from "./client";

/** Freshdesk caps a list page at 100 tickets. */
const LIST_PAGE_SIZE = 100;
/** Bounds one sync run: 50 pages of 100 tickets. Hitting it is reported as partial coverage. */
const MAX_LIST_PAGES = 50;
/** Ticket search answers 30 per page and refuses pages beyond 10. */
const SEARCH_PAGE_SIZE = 30;
const MAX_SEARCH_PAGES = 10;
/** Keeps each search query well under Freshdesk's 512-character limit. */
const STATUSES_PER_QUERY = 20;

function bad(what: string): never {
  throw new FreshdeskError("server", `Freshdesk returned an unexpected ${what}`);
}

const idOrNull = (v: unknown): string | null => (typeof v === "number" || typeof v === "string" ? String(v) : null);

function seconds(iso: unknown): number {
  const ms = typeof iso === "string" ? Date.parse(iso) : NaN;
  if (Number.isNaN(ms)) bad("ticket timestamp");
  return Math.floor(ms / 1000);
}

/** Decodes one ticket from /tickets, /tickets/:id or /search/tickets. */
export function decodeTicket(raw: unknown, fetchedOnDemand = false): CachedTicket {
  if (!raw || typeof raw !== "object") bad("ticket");
  const t = raw as Record<string, unknown>;
  if (typeof t.id !== "number" || typeof t.status !== "number") bad("ticket");
  const requester = t.requester && typeof t.requester === "object" ? (t.requester as Record<string, unknown>) : null;
  return {
    ticketId: String(t.id),
    subject: typeof t.subject === "string" ? t.subject : "",
    statusId: String(t.status),
    priorityId: idOrNull(t.priority),
    requesterId: idOrNull(t.requester_id),
    customerName: typeof requester?.name === "string" ? requester.name : null,
    customerEmail: typeof requester?.email === "string" ? requester.email : null,
    responderId: idOrNull(t.responder_id),
    groupId: idOrNull(t.group_id),
    companyId: idOrNull(t.company_id),
    tags: Array.isArray(t.tags) ? t.tags.filter((tag): tag is string => typeof tag === "string") : [],
    dueBy: typeof t.due_by === "string" && !Number.isNaN(Date.parse(t.due_by)) ? seconds(t.due_by) : null,
    createdAt: seconds(t.created_at),
    updatedAt: seconds(t.updated_at),
    fetchedOnDemand,
  };
}

export interface TicketPage {
  tickets: CachedTicket[];
  /** False when the run stopped at its page bound before reaching the end */
  complete: boolean;
}

/** Every ticket updated at or after `since` (unix seconds), newest first, with its requester. */
export async function listTicketsUpdatedSince(credentials: HelpdeskCredentials, since: number): Promise<TicketPage> {
  const sinceIso = new Date(since * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const tickets: CachedTicket[] = [];
  for (let page = 1; page <= MAX_LIST_PAGES; page++) {
    const batch = await freshdeskGet<unknown>(
      credentials,
      `/tickets?updated_since=${encodeURIComponent(sinceIso)}&include=requester&order_by=updated_at&order_type=desc&per_page=${LIST_PAGE_SIZE}&page=${page}`,
    );
    if (!Array.isArray(batch)) bad("ticket list");
    tickets.push(...batch.map((raw) => decodeTicket(raw)));
    if (batch.length < LIST_PAGE_SIZE) return { tickets, complete: true };
  }
  return { tickets, complete: false };
}

export interface TicketSearchResult {
  tickets: CachedTicket[];
  /** How many tickets Freshdesk says match, which can exceed what search lets us download */
  total: number;
}

/** Tickets in any of these statuses, through search (no requester names). */
export async function searchTicketsByStatus(
  credentials: HelpdeskCredentials,
  statusIds: string[],
): Promise<TicketSearchResult> {
  const tickets: CachedTicket[] = [];
  let total = 0;
  for (let i = 0; i < statusIds.length; i += STATUSES_PER_QUERY) {
    const query = `"${statusIds.slice(i, i + STATUSES_PER_QUERY).map((id) => `status:${id}`).join(" OR ")}"`;
    for (let page = 1; page <= MAX_SEARCH_PAGES; page++) {
      const body = await freshdeskGet<{ results?: unknown; total?: unknown }>(
        credentials,
        `/search/tickets?query=${encodeURIComponent(query)}&page=${page}`,
      );
      if (!Array.isArray(body?.results) || typeof body.total !== "number") bad("search result");
      if (page === 1) total += body.total;
      tickets.push(...body.results.map((raw) => decodeTicket(raw)));
      if (body.results.length < SEARCH_PAGE_SIZE || page * SEARCH_PAGE_SIZE >= body.total) break;
    }
  }
  return { tickets, total };
}

/** One ticket by its helpdesk ID, whatever its age or status. */
export async function fetchTicketById(credentials: HelpdeskCredentials, ticketId: string): Promise<CachedTicket> {
  const raw = await freshdeskGet<unknown>(credentials, `/tickets/${encodeURIComponent(ticketId)}?include=requester`);
  return decodeTicket(raw, true);
}

export async function fetchContactName(
  credentials: HelpdeskCredentials,
  contactId: string,
): Promise<{ name: string; email: string | null }> {
  const raw = await freshdeskGet<Record<string, unknown>>(credentials, `/contacts/${encodeURIComponent(contactId)}`);
  if (typeof raw?.name !== "string") bad("contact");
  return { name: raw.name, email: typeof raw.email === "string" ? raw.email : null };
}
