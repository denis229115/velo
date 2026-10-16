import { getDb } from "./connection";

/** Where a Ticket draft lives: one per helpdesk, agent identity, ticket and composer mode */
export interface DraftKey {
  tenantId: string;
  /** The agent the draft is written as ("" before the identity is known) */
  agentId: string;
  ticketId: string;
  mode: "reply" | "note";
}

export interface StoredDraft {
  bodyHtml: string;
  ccEmails: string[];
  /** Unix seconds: when the draft started, for the Staleness check */
  startedAt: number;
  assigneeAtStart: string | null;
  /** The journal entry of a send still Unconfirmed */
  unconfirmedEntryId: number | null;
  updatedAt: number;
}

interface DraftRow {
  body_html: string;
  cc_json: string;
  started_at: number;
  assignee_at_start: string | null;
  unconfirmed_entry_id: number | null;
  updated_at: number;
}

const WHERE = "tenant_id = $1 AND agent_id = $2 AND ticket_id = $3 AND mode = $4";
const keyParams = (k: DraftKey) => [k.tenantId, k.agentId, k.ticketId, k.mode];

export async function getStoredDraft(key: DraftKey): Promise<StoredDraft | null> {
  const db = await getDb();
  const rows = await db.select<DraftRow[]>(`SELECT * FROM freshdesk_ticket_drafts WHERE ${WHERE}`, keyParams(key));
  const row = rows[0];
  if (!row) return null;
  let ccEmails: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.cc_json);
    if (Array.isArray(parsed)) ccEmails = parsed.filter((e): e is string => typeof e === "string");
  } catch {
    // A damaged CC list reads as empty; the body is what matters
  }
  return {
    bodyHtml: row.body_html,
    ccEmails,
    startedAt: row.started_at,
    assigneeAtStart: row.assignee_at_start,
    unconfirmedEntryId: row.unconfirmed_entry_id,
    updatedAt: row.updated_at,
  };
}

/** Writes the draft; the start time and assignee are kept from the first save. */
export async function putStoredDraft(key: DraftKey, draft: StoredDraft): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO freshdesk_ticket_drafts
       (tenant_id, agent_id, ticket_id, mode, body_html, cc_json, started_at, assignee_at_start, unconfirmed_entry_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT(tenant_id, agent_id, ticket_id, mode) DO UPDATE SET body_html = $5, cc_json = $6, started_at = $7,
       assignee_at_start = $8, unconfirmed_entry_id = $9, updated_at = $10`,
    [
      ...keyParams(key),
      draft.bodyHtml,
      JSON.stringify(draft.ccEmails),
      draft.startedAt,
      draft.assigneeAtStart,
      draft.unconfirmedEntryId,
      draft.updatedAt,
    ],
  );
}

export async function deleteStoredDraft(key: DraftKey): Promise<void> {
  const db = await getDb();
  await db.execute(`DELETE FROM freshdesk_ticket_drafts WHERE ${WHERE}`, keyParams(key));
}
