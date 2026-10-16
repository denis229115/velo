import { getDb, withTransaction } from "./connection";
import type {
  ClickUpCustomField,
  ClickUpList,
  ClickUpMember,
  ClickUpStatus,
  ClickUpWorkspaceMetadata,
} from "@/services/clickup/metadata";

export interface ClickUpWorkspaceRow {
  tenantId: string;
  workspaceId: string;
  workspaceName: string;
  me: ClickUpMember | null;
  connectedAt: number;
  metadataRefreshedAt: number | null;
  defaultListId: string | null;
  ticketIdFieldId: string | null;
}

/** A task as last read from ClickUp. Text fields are already sanitised. */
export interface CachedTask {
  taskId: string;
  customId: string | null;
  name: string;
  statusName: string;
  statusType: string;
  statusColor: string | null;
  assignees: string[];
  /** Unix ms */
  dueAt: number | null;
  listId: string | null;
  listName: string | null;
  url: string;
  /** Unix ms, ClickUp's date_updated */
  updatedAt: number | null;
  /** Unix s, when Velo last read the task */
  refreshedAt: number;
  /** ClickUp no longer returns the task (deleted or moved out of the workspace) */
  missing: boolean;
}

export type ClickUpSyncStateName = "idle" | "ok" | "rate_limited" | "auth_error" | "error";

export interface ClickUpSyncState {
  state: ClickUpSyncStateName;
  lastSuccessAt: number | null;
  lastAttemptAt: number | null;
  retryAfterUntil: number | null;
  consecutiveFailures: number;
  errorMessage: string | null;
}

/** Every table holding data scoped to a ClickUp workspace, with its workspace column. */
const CLICKUP_TENANT_TABLES = [
  ["clickup_lists", "tenant_id"],
  ["clickup_statuses", "tenant_id"],
  ["clickup_members", "tenant_id"],
  ["clickup_custom_fields", "tenant_id"],
  ["clickup_tasks", "tenant_id"],
  ["clickup_sync_state", "tenant_id"],
  ["task_links", "workspace_id"],
  ["clickup_task_operations", "workspace_id"],
] as const;

interface WorkspaceRow {
  tenant_id: string;
  workspace_id: string;
  workspace_name: string;
  me_user_id: string | null;
  me_name: string | null;
  me_email: string | null;
  connected_at: number;
  metadata_refreshed_at: number | null;
  default_list_id: string | null;
  ticket_id_field_id: string | null;
}

export async function getClickUpWorkspace(): Promise<ClickUpWorkspaceRow | null> {
  const db = await getDb();
  const rows = await db.select<WorkspaceRow[]>("SELECT * FROM clickup_workspace WHERE id = 1");
  const row = rows[0];
  if (!row) return null;
  return {
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    me: row.me_user_id ? { userId: row.me_user_id, name: row.me_name ?? "", email: row.me_email } : null,
    connectedAt: row.connected_at,
    metadataRefreshedAt: row.metadata_refreshed_at,
    defaultListId: row.default_list_id,
    ticketIdFieldId: row.ticket_id_field_id,
  };
}

/** Stores the connected workspace. Reconnecting the same workspace keeps its default list and Ticket-ID field. */
export async function saveClickUpWorkspace(input: {
  tenantId: string;
  workspaceId: string;
  workspaceName: string;
  me: ClickUpMember;
}): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO clickup_workspace (id, tenant_id, workspace_id, workspace_name, me_user_id, me_name, me_email, connected_at)
     VALUES (1, $1, $2, $3, $4, $5, $6, unixepoch())
     ON CONFLICT(id) DO UPDATE SET
       default_list_id = CASE WHEN tenant_id = $1 THEN default_list_id END,
       ticket_id_field_id = CASE WHEN tenant_id = $1 THEN ticket_id_field_id END,
       tenant_id = $1, workspace_id = $2, workspace_name = $3, me_user_id = $4, me_name = $5, me_email = $6,
       connected_at = unixepoch(), metadata_refreshed_at = NULL`,
    [input.tenantId, input.workspaceId, input.workspaceName, input.me.userId, input.me.name, input.me.email],
  );
}

export async function deleteClickUpWorkspace(): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM clickup_workspace WHERE id = 1");
}

export async function setWorkspaceChoice(column: "default_list_id" | "ticket_id_field_id", value: string | null): Promise<void> {
  const db = await getDb();
  await db.execute(`UPDATE clickup_workspace SET ${column} = $1 WHERE id = 1`, [value]);
}

/** Removes every ClickUp-scoped row (cache and links) that does not belong to `keepTenantId`. */
export async function deleteClickUpDataExcept(keepTenantId: string): Promise<void> {
  await withTransaction(async (db) => {
    for (const [table, column] of CLICKUP_TENANT_TABLES) {
      await db.execute(`DELETE FROM ${table} WHERE ${column} != $1`, [keepTenantId]);
    }
  });
}

/** Replaces the workspace's lists, statuses, members and custom fields with a fresh read, in one step. */
export async function replaceWorkspaceMetadata(tenantId: string, metadata: ClickUpWorkspaceMetadata): Promise<void> {
  await withTransaction(async (db) => {
    for (const table of ["clickup_lists", "clickup_statuses", "clickup_members", "clickup_custom_fields"]) {
      await db.execute(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId]);
    }
    for (const l of metadata.lists) {
      await db.execute(
        `INSERT OR REPLACE INTO clickup_lists (tenant_id, list_id, name, space_name, folder_name, position)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [tenantId, l.listId, l.name, l.spaceName, l.folderName, l.position],
      );
      for (const s of l.statuses) {
        await db.execute(
          `INSERT OR REPLACE INTO clickup_statuses (tenant_id, list_id, name, type, color, position)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [tenantId, l.listId, s.name, s.type, s.color, s.position],
        );
      }
    }
    for (const m of metadata.members) {
      await db.execute(
        "INSERT OR REPLACE INTO clickup_members (tenant_id, user_id, name, email) VALUES ($1, $2, $3, $4)",
        [tenantId, m.userId, m.name, m.email],
      );
    }
    for (const f of metadata.customFields) {
      await db.execute(
        "INSERT OR REPLACE INTO clickup_custom_fields (tenant_id, list_id, field_id, name, type) VALUES ($1, $2, $3, $4, $5)",
        [tenantId, f.listId, f.fieldId, f.name, f.type],
      );
    }
    await db.execute("DELETE FROM settings WHERE key = $1", [`clickup_discovery:${tenantId}`]);
    await db.execute("UPDATE clickup_workspace SET metadata_refreshed_at = unixepoch() WHERE tenant_id = $1", [tenantId]);
  });
}

export async function getClickUpLists(tenantId: string): Promise<ClickUpList[]> {
  const db = await getDb();
  const lists = await db.select<
    { list_id: string; name: string; space_name: string; folder_name: string | null; position: number }[]
  >("SELECT * FROM clickup_lists WHERE tenant_id = $1 ORDER BY position, list_id", [tenantId]);
  const statuses = await db.select<
    { list_id: string; name: string; type: string; color: string | null; position: number }[]
  >("SELECT * FROM clickup_statuses WHERE tenant_id = $1 ORDER BY position, name", [tenantId]);
  return lists.map((l) => ({
    listId: l.list_id,
    name: l.name,
    spaceName: l.space_name,
    folderName: l.folder_name,
    position: l.position,
    statuses: statuses
      .filter((s) => s.list_id === l.list_id)
      .map((s): ClickUpStatus => ({ name: s.name, type: s.type, color: s.color, position: s.position })),
  }));
}

export async function getClickUpMembers(tenantId: string): Promise<ClickUpMember[]> {
  const db = await getDb();
  const rows = await db.select<{ user_id: string; name: string; email: string | null }[]>(
    "SELECT user_id, name, email FROM clickup_members WHERE tenant_id = $1 ORDER BY name, user_id",
    [tenantId],
  );
  return rows.map((r) => ({ userId: r.user_id, name: r.name, email: r.email }));
}

export async function getClickUpCustomFields(tenantId: string): Promise<ClickUpCustomField[]> {
  const db = await getDb();
  const rows = await db.select<{ list_id: string; field_id: string; name: string; type: string }[]>(
    "SELECT list_id, field_id, name, type FROM clickup_custom_fields WHERE tenant_id = $1 ORDER BY name, field_id",
    [tenantId],
  );
  return rows.map((r) => ({ listId: r.list_id, fieldId: r.field_id, name: r.name, type: r.type }));
}

// ---------- task cache ----------

interface TaskRow {
  task_id: string;
  custom_id: string | null;
  name: string;
  status_name: string;
  status_type: string;
  status_color: string | null;
  assignees_json: string;
  due_at: number | null;
  list_id: string | null;
  list_name: string | null;
  url: string;
  updated_at: number | null;
  refreshed_at: number;
  missing: number;
}

function taskFromRow(r: TaskRow): CachedTask {
  let assignees: string[] = [];
  try {
    const parsed: unknown = JSON.parse(r.assignees_json);
    if (Array.isArray(parsed)) assignees = parsed.filter((a): a is string => typeof a === "string");
  } catch {
    // keep none
  }
  return {
    taskId: r.task_id,
    customId: r.custom_id,
    name: r.name,
    statusName: r.status_name,
    statusType: r.status_type,
    statusColor: r.status_color,
    assignees,
    dueAt: r.due_at,
    listId: r.list_id,
    listName: r.list_name,
    url: r.url,
    updatedAt: r.updated_at,
    refreshedAt: r.refreshed_at,
    missing: r.missing === 1,
  };
}

export async function upsertCachedTask(tenantId: string, t: Omit<CachedTask, "missing">): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO clickup_tasks (tenant_id, task_id, custom_id, name, status_name, status_type, status_color,
       assignees_json, due_at, list_id, list_name, url, updated_at, refreshed_at, missing)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 0)
     ON CONFLICT(tenant_id, task_id) DO UPDATE SET custom_id = $3, name = $4, status_name = $5, status_type = $6,
       status_color = $7, assignees_json = $8, due_at = $9, list_id = $10, list_name = $11, url = $12,
       updated_at = $13, refreshed_at = $14, missing = 0`,
    [tenantId, t.taskId, t.customId, t.name, t.statusName, t.statusType, t.statusColor, JSON.stringify(t.assignees),
      t.dueAt, t.listId, t.listName, t.url, t.updatedAt, t.refreshedAt],
  );
}

export async function markCachedTaskMissing(tenantId: string, taskId: string, refreshedAt: number): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE clickup_tasks SET missing = 1, refreshed_at = $3 WHERE tenant_id = $1 AND task_id = $2",
    [tenantId, taskId, refreshedAt],
  );
}

export async function getCachedTasks(tenantId: string, taskIds: string[]): Promise<Map<string, CachedTask>> {
  if (taskIds.length === 0) return new Map();
  const db = await getDb();
  const placeholders = taskIds.map((_, i) => `$${i + 2}`).join(", ");
  const rows = await db.select<TaskRow[]>(
    `SELECT * FROM clickup_tasks WHERE tenant_id = $1 AND task_id IN (${placeholders})`,
    [tenantId, ...taskIds],
  );
  return new Map(rows.map((r) => [r.task_id, taskFromRow(r)]));
}

// ---------- refresh state ----------

export async function getClickUpSyncState(tenantId: string): Promise<ClickUpSyncState> {
  const db = await getDb();
  const rows = await db.select<
    {
      state: ClickUpSyncStateName; last_success_at: number | null; last_attempt_at: number | null;
      retry_after_until: number | null; consecutive_failures: number; error_message: string | null;
    }[]
  >("SELECT * FROM clickup_sync_state WHERE tenant_id = $1", [tenantId]);
  const r = rows[0];
  if (!r) {
    return { state: "idle", lastSuccessAt: null, lastAttemptAt: null, retryAfterUntil: null, consecutiveFailures: 0, errorMessage: null };
  }
  return {
    state: r.state,
    lastSuccessAt: r.last_success_at,
    lastAttemptAt: r.last_attempt_at,
    retryAfterUntil: r.retry_after_until,
    consecutiveFailures: r.consecutive_failures,
    errorMessage: r.error_message,
  };
}

export async function saveClickUpSyncState(tenantId: string, s: ClickUpSyncState): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO clickup_sync_state (tenant_id, state, last_success_at, last_attempt_at, retry_after_until,
       consecutive_failures, error_message)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT(tenant_id) DO UPDATE SET state = $2, last_success_at = $3, last_attempt_at = $4,
       retry_after_until = $5, consecutive_failures = $6, error_message = $7`,
    [tenantId, s.state, s.lastSuccessAt, s.lastAttemptAt, s.retryAfterUntil, s.consecutiveFailures, s.errorMessage],
  );
}

/** Drawer discovery replaces only hierarchy. Members and field caches keep their own scope. */
export async function replaceTaskDestinations(tenantId: string, lists: ClickUpList[], refreshedAt: number, complete: boolean): Promise<void> {
  await withTransaction(async (db) => {
    const current = await db.select<{ tenant_id: string }[]>("SELECT tenant_id FROM clickup_workspace WHERE id = 1");
    if (current[0]?.tenant_id !== tenantId) return;
    await db.execute("DELETE FROM clickup_lists WHERE tenant_id = $1", [tenantId]);
    await db.execute("DELETE FROM clickup_statuses WHERE tenant_id = $1", [tenantId]);
    for (const l of lists) {
      await db.execute("INSERT INTO clickup_lists (tenant_id, list_id, name, space_name, folder_name, position) VALUES ($1, $2, $3, $4, $5, $6)", [tenantId, l.listId, l.name, l.spaceName, l.folderName, l.position]);
      for (const s of l.statuses) await db.execute("INSERT INTO clickup_statuses (tenant_id, list_id, name, type, color, position) VALUES ($1, $2, $3, $4, $5, $6)", [tenantId, l.listId, s.name, s.type, s.color, s.position]);
    }
    await db.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ($1, $2)", [`clickup_discovery:${tenantId}`, JSON.stringify({ refreshedAt, complete })]);
  });
}

export async function replaceTaskListDetails(tenantId: string, listId: string, statuses: ClickUpStatus[], fields: ClickUpCustomField[]): Promise<void> {
  await withTransaction(async (db) => {
    const current = await db.select<{ tenant_id: string }[]>("SELECT tenant_id FROM clickup_workspace WHERE id = 1");
    if (current[0]?.tenant_id !== tenantId) return;
    await db.execute("DELETE FROM clickup_statuses WHERE tenant_id = $1 AND list_id = $2", [tenantId, listId]);
    await db.execute("DELETE FROM clickup_custom_fields WHERE tenant_id = $1 AND list_id = $2", [tenantId, listId]);
    for (const s of statuses) await db.execute("INSERT INTO clickup_statuses (tenant_id, list_id, name, type, color, position) VALUES ($1, $2, $3, $4, $5, $6)", [tenantId, listId, s.name, s.type, s.color, s.position]);
    for (const f of fields) await db.execute("INSERT INTO clickup_custom_fields (tenant_id, list_id, field_id, name, type) VALUES ($1, $2, $3, $4, $5)", [tenantId, listId, f.fieldId, f.name, f.type]);
  });
}
