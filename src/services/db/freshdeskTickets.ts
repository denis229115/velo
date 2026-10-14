import { getDb, withTransaction } from "./connection";

/** A ticket as cached locally. IDs are the helpdesk's, stored as strings; times are unix seconds. */
export interface CachedTicket {
  ticketId: string;
  subject: string;
  statusId: string;
  priorityId: string | null;
  requesterId: string | null;
  customerName: string | null;
  customerEmail: string | null;
  responderId: string | null;
  groupId: string | null;
  createdAt: number;
  updatedAt: number;
  /** Outside the default scope; fetched because the operator asked for it */
  fetchedOnDemand: boolean;
}

interface TicketRow {
  ticket_id: string;
  subject: string;
  status_id: string;
  priority_id: string | null;
  requester_id: string | null;
  customer_name: string | null;
  customer_email: string | null;
  responder_id: string | null;
  group_id: string | null;
  created_at: number;
  updated_at: number;
  fetched_on_demand: number;
}

export type TicketSyncStateName = "idle" | "ok" | "rate_limited" | "auth_error" | "error";

export interface TicketSyncState {
  state: TicketSyncStateName;
  lastSuccessAt: number | null;
  lastFullSyncAt: number | null;
  lastAttemptAt: number | null;
  retryAfterUntil: number | null;
  consecutiveFailures: number;
  errorMessage: string | null;
  outstandingTotal: number | null;
  outstandingDownloaded: number | null;
  coverageComplete: boolean;
}

interface SyncStateRow {
  state: TicketSyncStateName;
  last_success_at: number | null;
  last_full_sync_at: number | null;
  last_attempt_at: number | null;
  retry_after_until: number | null;
  consecutive_failures: number;
  error_message: string | null;
  outstanding_total: number | null;
  outstanding_downloaded: number | null;
  coverage_complete: number;
}

const EMPTY_SYNC_STATE: TicketSyncState = {
  state: "idle",
  lastSuccessAt: null,
  lastFullSyncAt: null,
  lastAttemptAt: null,
  retryAfterUntil: null,
  consecutiveFailures: 0,
  errorMessage: null,
  outstandingTotal: null,
  outstandingDownloaded: null,
  coverageComplete: false,
};

function toTicket(row: TicketRow): CachedTicket {
  return {
    ticketId: row.ticket_id,
    subject: row.subject,
    statusId: row.status_id,
    priorityId: row.priority_id,
    requesterId: row.requester_id,
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    responderId: row.responder_id,
    groupId: row.group_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    fetchedOnDemand: row.fetched_on_demand === 1,
  };
}

/**
 * Inserts or updates tickets. A known customer name is kept when the incoming
 * copy has none (search results carry only the requester ID), and a ticket
 * once fetched on demand keeps that mark.
 */
export async function upsertTickets(tenantId: string, tickets: CachedTicket[]): Promise<void> {
  if (tickets.length === 0) return;
  await withTransaction(async (db) => {
    for (const t of tickets) {
      await db.execute(
        `INSERT INTO freshdesk_tickets (tenant_id, ticket_id, subject, status_id, priority_id, requester_id,
           customer_name, customer_email, responder_id, group_id, created_at, updated_at, fetched_on_demand)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT(tenant_id, ticket_id) DO UPDATE SET
           subject = excluded.subject, status_id = excluded.status_id, priority_id = excluded.priority_id,
           requester_id = excluded.requester_id,
           customer_name = CASE WHEN excluded.requester_id IS freshdesk_tickets.requester_id
             THEN COALESCE(excluded.customer_name, freshdesk_tickets.customer_name) ELSE excluded.customer_name END,
           customer_email = CASE WHEN excluded.requester_id IS freshdesk_tickets.requester_id
             THEN COALESCE(excluded.customer_email, freshdesk_tickets.customer_email) ELSE excluded.customer_email END,
           responder_id = excluded.responder_id, group_id = excluded.group_id,
           created_at = excluded.created_at, updated_at = excluded.updated_at,
           fetched_on_demand = MAX(freshdesk_tickets.fetched_on_demand, excluded.fetched_on_demand)`,
        [
          tenantId, t.ticketId, t.subject, t.statusId, t.priorityId, t.requesterId,
          t.customerName, t.customerEmail, t.responderId, t.groupId, t.createdAt, t.updatedAt,
          t.fetchedOnDemand ? 1 : 0,
        ],
      );
    }
  });
}

export async function getCachedTickets(tenantId: string): Promise<CachedTicket[]> {
  const db = await getDb();
  const rows = await db.select<TicketRow[]>(
    "SELECT * FROM freshdesk_tickets WHERE tenant_id = $1 ORDER BY updated_at DESC, CAST(ticket_id AS INTEGER) DESC",
    [tenantId],
  );
  return rows.map(toTicket);
}

/** Fills in customer names for tickets whose requester was looked up separately. */
export async function setCustomerForRequester(
  tenantId: string,
  requesterId: string,
  customer: { name: string; email: string | null },
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE freshdesk_tickets SET customer_name = $1, customer_email = $2 WHERE tenant_id = $3 AND requester_id = $4",
    [customer.name, customer.email, tenantId, requesterId],
  );
}

/**
 * Drops done tickets that fell out of the default window. Tickets fetched on
 * demand stay until the tenant changes.
 */
export async function pruneDoneTickets(tenantId: string, doneStatusIds: string[], updatedBefore: number): Promise<void> {
  if (doneStatusIds.length === 0) return;
  const db = await getDb();
  const placeholders = doneStatusIds.map((_, i) => `$${i + 3}`).join(", ");
  await db.execute(
    `DELETE FROM freshdesk_tickets WHERE tenant_id = $1 AND fetched_on_demand = 0 AND updated_at < $2
       AND status_id IN (${placeholders})`,
    [tenantId, updatedBefore, ...doneStatusIds],
  );
}

export async function getTicketSyncState(tenantId: string): Promise<TicketSyncState> {
  const db = await getDb();
  const rows = await db.select<SyncStateRow[]>("SELECT * FROM freshdesk_sync_state WHERE tenant_id = $1", [tenantId]);
  const row = rows[0];
  if (!row) return { ...EMPTY_SYNC_STATE };
  return {
    state: row.state,
    lastSuccessAt: row.last_success_at,
    lastFullSyncAt: row.last_full_sync_at,
    lastAttemptAt: row.last_attempt_at,
    retryAfterUntil: row.retry_after_until,
    consecutiveFailures: row.consecutive_failures,
    errorMessage: row.error_message,
    outstandingTotal: row.outstanding_total,
    outstandingDownloaded: row.outstanding_downloaded,
    coverageComplete: row.coverage_complete === 1,
  };
}

export async function saveTicketSyncState(tenantId: string, s: TicketSyncState): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO freshdesk_sync_state (tenant_id, state, last_success_at, last_full_sync_at, last_attempt_at,
       retry_after_until, consecutive_failures, error_message, outstanding_total,
       outstanding_downloaded, coverage_complete)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT(tenant_id) DO UPDATE SET
       state = excluded.state, last_success_at = excluded.last_success_at,
       last_full_sync_at = excluded.last_full_sync_at, last_attempt_at = excluded.last_attempt_at,
       retry_after_until = excluded.retry_after_until, consecutive_failures = excluded.consecutive_failures,
       error_message = excluded.error_message,
       outstanding_total = excluded.outstanding_total, outstanding_downloaded = excluded.outstanding_downloaded,
       coverage_complete = excluded.coverage_complete`,
    [
      tenantId, s.state, s.lastSuccessAt, s.lastFullSyncAt, s.lastAttemptAt, s.retryAfterUntil,
      s.consecutiveFailures, s.errorMessage, s.outstandingTotal,
      s.outstandingDownloaded, s.coverageComplete ? 1 : 0,
    ],
  );
}

/** A reconnect supplies new credentials, so a sync blocked by rejected ones may try again. */
export async function clearTicketSyncAuthBlock(tenantId: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE freshdesk_sync_state SET state = 'idle', error_message = NULL WHERE tenant_id = $1 AND state = 'auth_error'",
    [tenantId],
  );
}
