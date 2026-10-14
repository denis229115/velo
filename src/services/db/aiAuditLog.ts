import { getDb } from "./connection";

export type AiAuditOutcome = "pending" | "ok" | "error";

export interface AiFlagCounts {
  secret: number;
  payment: number;
  contact: number;
}

export interface AiAuditLogEntry {
  id: string;
  created_at: number;
  feature: string;
  provider: string;
  model: string;
  payload_hash: string;
  /** JSON-encoded AiFlagCounts */
  flag_counts: string;
  outcome: AiAuditOutcome;
}

export async function insertAiAuditLog(entry: {
  feature: string;
  provider: string;
  model: string;
  payloadHash: string;
  flagCounts: AiFlagCounts;
}): Promise<string> {
  const db = await getDb();
  const id = crypto.randomUUID();
  await db.execute(
    `INSERT INTO ai_audit_log (id, created_at, feature, provider, model, payload_hash, flag_counts)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, Date.now(), entry.feature, entry.provider, entry.model, entry.payloadHash, JSON.stringify(entry.flagCounts)],
  );
  return id;
}

export async function setAiAuditOutcome(id: string, outcome: AiAuditOutcome): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE ai_audit_log SET outcome = $1 WHERE id = $2", [outcome, id]);
}

export async function listAiAuditLog(limit = 500): Promise<AiAuditLogEntry[]> {
  const db = await getDb();
  return db.select<AiAuditLogEntry[]>(
    "SELECT * FROM ai_audit_log ORDER BY created_at DESC LIMIT $1",
    [limit],
  );
}
