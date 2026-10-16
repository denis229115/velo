import { getDb } from "./connection";

/** How a remote write ended: never guessed; an unconfirmed write is settled by reconciliation */
export type JournalOutcome = "pending" | "confirmed" | "failed" | "unconfirmed";

export interface JournalEntry {
  entryId: number;
  ticketId: string;
  operation: string;
  /** The fields sent to Freshdesk */
  changes: Record<string, unknown>;
  outcome: JournalOutcome;
  errorMessage: string | null;
  createdAt: number;
  completedAt: number | null;
}

interface JournalRow {
  entry_id: number;
  ticket_id: string;
  operation: string;
  changes_json: string;
  outcome: JournalOutcome;
  error_message: string | null;
  created_at: number;
  completed_at: number | null;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Records a remote write before it is sent. */
export async function startJournalEntry(
  tenantId: string,
  ticketId: string,
  operation: string,
  changes: Record<string, unknown>,
): Promise<number> {
  const db = await getDb();
  const result = await db.execute(
    `INSERT INTO freshdesk_operation_journal (tenant_id, ticket_id, operation, changes_json, outcome, created_at)
     VALUES ($1, $2, $3, $4, 'pending', $5)`,
    [tenantId, ticketId, operation, JSON.stringify(changes), nowSeconds()],
  );
  return Number(result.lastInsertId);
}

export async function finishJournalEntry(entryId: number, outcome: JournalOutcome, errorMessage: string | null): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE freshdesk_operation_journal SET outcome = $1, error_message = $2, completed_at = $3 WHERE entry_id = $4",
    [outcome, errorMessage, nowSeconds(), entryId],
  );
}

/** A ticket's remote writes, oldest first. */
export async function getJournalEntries(tenantId: string, ticketId: string): Promise<JournalEntry[]> {
  const db = await getDb();
  const rows = await db.select<JournalRow[]>(
    "SELECT * FROM freshdesk_operation_journal WHERE tenant_id = $1 AND ticket_id = $2 ORDER BY entry_id",
    [tenantId, ticketId],
  );
  return rows.map((r) => ({
    entryId: r.entry_id,
    ticketId: r.ticket_id,
    operation: r.operation,
    changes: JSON.parse(r.changes_json) as Record<string, unknown>,
    outcome: r.outcome,
    errorMessage: r.error_message,
    createdAt: r.created_at,
    completedAt: r.completed_at,
  }));
}
