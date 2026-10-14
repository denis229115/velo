import { getDb } from "./connection";

/**
 * AI results keyed by the source item, its content revision, the model and the
 * prompt version, so a changed message, model or prompt never serves a stale result.
 */
export interface AiResultCacheKey {
  /** Owner of the source item: an email account ID, or a tenant */
  scope: string;
  sourceId: string;
  feature: string;
  contentRevision: string;
  model: string;
  promptVersion: string;
}

export async function getAiResult(key: AiResultCacheKey): Promise<string | null> {
  const db = await getDb();
  const rows = await db.select<{ content: string }[]>(
    `SELECT content FROM ai_result_cache
     WHERE scope = $1 AND source_id = $2 AND feature = $3
       AND content_revision = $4 AND model = $5 AND prompt_version = $6`,
    [key.scope, key.sourceId, key.feature, key.contentRevision, key.model, key.promptVersion],
  );
  return rows[0]?.content ?? null;
}

export async function setAiResult(key: AiResultCacheKey, content: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO ai_result_cache (id, scope, source_id, feature, content_revision, model, prompt_version, content)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT(scope, source_id, feature, content_revision, model, prompt_version)
     DO UPDATE SET content = $8, created_at = unixepoch()`,
    [crypto.randomUUID(), key.scope, key.sourceId, key.feature, key.contentRevision, key.model, key.promptVersion, content],
  );
}

/** Drop every cached result for one source item and feature (used by "regenerate"). */
export async function deleteAiResults(scope: string, sourceId: string, feature: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    "DELETE FROM ai_result_cache WHERE scope = $1 AND source_id = $2 AND feature = $3",
    [scope, sourceId, feature],
  );
}
