import type { ActivitySummary, ConversationAttachment, ConversationKind, DecodedConversation } from "@/services/freshdesk/activity";
import { getDb, withTransaction } from "./connection";

/** A ticket's original request and how far its conversation history is loaded. Times are unix seconds. */
export interface StoredHistory {
  ticketId: string;
  ticketSource: number | null;
  descriptionHtml: string | null;
  descriptionText: string | null;
  attachments: ConversationAttachment[];
  /** Every conversation page was read */
  historyComplete: boolean;
  /** The ticket's updated_at when the history was read; a newer update makes it out of date */
  hydratedForUpdatedAt: number | null;
  hydratedAt: number | null;
  summary: ActivitySummary;
}

interface HistoryRow {
  ticket_id: string;
  ticket_source: number | null;
  description_html: string | null;
  description_text: string | null;
  attachments_json: string;
  history_complete: number;
  hydrated_for_updated_at: number | null;
  hydrated_at: number | null;
  last_answered_at: number | null;
  unverified_reply_at: number | null;
  last_customer_message_at: number | null;
  last_internal_note_at: number | null;
  last_activity_at: number | null;
}

interface ConversationRow {
  conversation_id: string;
  kind: ConversationKind;
  user_id: string | null;
  from_email: string | null;
  body_html: string | null;
  body_text: string | null;
  attachments_json: string;
  created_at: number;
  updated_at: number;
}

function parseAttachments(json: string): ConversationAttachment[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as ConversationAttachment[]) : [];
  } catch {
    return [];
  }
}

function toHistory(row: HistoryRow): StoredHistory {
  return {
    ticketId: row.ticket_id,
    ticketSource: row.ticket_source,
    descriptionHtml: row.description_html,
    descriptionText: row.description_text,
    attachments: parseAttachments(row.attachments_json),
    historyComplete: row.history_complete === 1,
    hydratedForUpdatedAt: row.hydrated_for_updated_at,
    hydratedAt: row.hydrated_at,
    summary: {
      lastAnsweredAt: row.last_answered_at,
      unverifiedReplyAt: row.unverified_reply_at,
      lastCustomerMessageAt: row.last_customer_message_at,
      lastInternalNoteAt: row.last_internal_note_at,
      lastActivityAt: row.last_activity_at,
    },
  };
}

/**
 * Stores what one hydration read. A complete read replaces the ticket's
 * conversations; a partial one adds what it got and leaves the history
 * marked incomplete.
 */
export async function saveTicketHistory(
  tenantId: string,
  history: Omit<StoredHistory, "summary"> & { summary: ActivitySummary },
  conversations: DecodedConversation[],
): Promise<void> {
  await withTransaction(async (db) => {
    const h = history;
    const s = h.summary;
    await db.execute(
      `INSERT INTO freshdesk_ticket_history (tenant_id, ticket_id, ticket_source, description_html, description_text,
         attachments_json, history_complete, hydrated_for_updated_at, hydrated_at, last_answered_at,
         unverified_reply_at, last_customer_message_at, last_internal_note_at, last_activity_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT(tenant_id, ticket_id) DO UPDATE SET
         ticket_source = excluded.ticket_source, description_html = excluded.description_html,
         description_text = excluded.description_text, attachments_json = excluded.attachments_json,
         history_complete = excluded.history_complete, hydrated_for_updated_at = excluded.hydrated_for_updated_at,
         hydrated_at = excluded.hydrated_at, last_answered_at = excluded.last_answered_at,
         unverified_reply_at = excluded.unverified_reply_at, last_customer_message_at = excluded.last_customer_message_at,
         last_internal_note_at = excluded.last_internal_note_at, last_activity_at = excluded.last_activity_at`,
      [
        tenantId, h.ticketId, h.ticketSource, h.descriptionHtml, h.descriptionText, JSON.stringify(h.attachments),
        h.historyComplete ? 1 : 0, h.hydratedForUpdatedAt, h.hydratedAt, s.lastAnsweredAt,
        s.unverifiedReplyAt, s.lastCustomerMessageAt, s.lastInternalNoteAt, s.lastActivityAt,
      ],
    );
    if (h.historyComplete) {
      await db.execute("DELETE FROM freshdesk_conversations WHERE tenant_id = $1 AND ticket_id = $2", [tenantId, h.ticketId]);
    }
    for (const c of conversations) {
      await db.execute(
        `INSERT INTO freshdesk_conversations (tenant_id, ticket_id, conversation_id, kind, user_id, from_email,
           body_html, body_text, attachments_json, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT(tenant_id, ticket_id, conversation_id) DO UPDATE SET
           kind = excluded.kind, user_id = excluded.user_id, from_email = excluded.from_email,
           body_html = excluded.body_html, body_text = excluded.body_text,
           attachments_json = excluded.attachments_json, created_at = excluded.created_at, updated_at = excluded.updated_at`,
        [
          tenantId, h.ticketId, c.conversationId, c.kind, c.userId, c.fromEmail, c.bodyHtml, c.bodyText,
          JSON.stringify(c.attachments), c.createdAt, c.updatedAt,
        ],
      );
    }
  });
}

/** Every stored history of the tenant, by ticket ID (without bodies). */
export async function getStoredHistories(tenantId: string): Promise<Map<string, StoredHistory>> {
  const db = await getDb();
  const rows = await db.select<HistoryRow[]>(
    `SELECT ticket_id, ticket_source, NULL AS description_html, NULL AS description_text, '[]' AS attachments_json,
       history_complete, hydrated_for_updated_at, hydrated_at, last_answered_at, unverified_reply_at,
       last_customer_message_at, last_internal_note_at, last_activity_at
     FROM freshdesk_ticket_history WHERE tenant_id = $1`,
    [tenantId],
  );
  return new Map(rows.map((r) => [r.ticket_id, toHistory(r)]));
}

export async function getStoredHistory(
  tenantId: string,
  ticketId: string,
): Promise<{ history: StoredHistory; conversations: DecodedConversation[] } | null> {
  const db = await getDb();
  const rows = await db.select<HistoryRow[]>(
    "SELECT * FROM freshdesk_ticket_history WHERE tenant_id = $1 AND ticket_id = $2",
    [tenantId, ticketId],
  );
  const row = rows[0];
  if (!row) return null;
  const conversations = await db.select<ConversationRow[]>(
    `SELECT * FROM freshdesk_conversations WHERE tenant_id = $1 AND ticket_id = $2
     ORDER BY created_at, CAST(conversation_id AS INTEGER)`,
    [tenantId, ticketId],
  );
  return {
    history: toHistory(row),
    conversations: conversations.map((c) => ({
      conversationId: c.conversation_id,
      kind: c.kind,
      userId: c.user_id,
      fromEmail: c.from_email,
      bodyHtml: c.body_html,
      bodyText: c.body_text,
      attachments: parseAttachments(c.attachments_json),
      createdAt: c.created_at,
      updatedAt: c.updated_at,
    })),
  };
}
