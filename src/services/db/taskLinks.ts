import { getDb } from "./connection";

export type LinkItemKind = "ticket" | "email";
/** How the link came about: an existing task linked by the operator, or a task created from the item */
export type LinkOrigin = "linked" | "created";

/** The item side of a link: a ticket of a helpdesk, or an email thread of an email account. */
export interface LinkKey {
  itemKind: LinkItemKind;
  /** The helpdesk tenant for tickets, the email account for email threads */
  scopeId: string;
  itemId: string;
  /** The ClickUp workspace tenant */
  workspaceId: string;
}

export interface TaskLink extends LinkKey {
  id: number;
  taskId: string;
  createdBy: string | null;
  /** Unix s */
  createdAt: number;
  origin: LinkOrigin;
  state: string;
}

interface LinkRow {
  id: number;
  item_kind: LinkItemKind;
  scope_id: string;
  item_id: string;
  workspace_id: string;
  task_id: string;
  created_by: string | null;
  created_at: number;
  origin: LinkOrigin;
  state: string;
}

function linkFromRow(r: LinkRow): TaskLink {
  return {
    id: r.id,
    itemKind: r.item_kind,
    scopeId: r.scope_id,
    itemId: r.item_id,
    workspaceId: r.workspace_id,
    taskId: r.task_id,
    createdBy: r.created_by,
    createdAt: r.created_at,
    origin: r.origin,
    state: r.state,
  };
}

/** Inserts the link; false when the same item already links this task (nothing is changed then). */
export async function insertTaskLink(
  key: LinkKey,
  link: { taskId: string; createdBy: string | null; origin: LinkOrigin },
): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute(
    `INSERT OR IGNORE INTO task_links (item_kind, scope_id, item_id, workspace_id, task_id, created_by, origin)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [key.itemKind, key.scopeId, key.itemId, key.workspaceId, link.taskId, link.createdBy, link.origin],
  );
  return result.rowsAffected > 0;
}

/** Removes only this item's link to the task; other items' links and the task stay. */
export async function deleteTaskLink(key: LinkKey, taskId: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    `DELETE FROM task_links WHERE item_kind = $1 AND scope_id = $2 AND item_id = $3 AND workspace_id = $4 AND task_id = $5`,
    [key.itemKind, key.scopeId, key.itemId, key.workspaceId, taskId],
  );
}

export async function getTaskLinks(key: LinkKey): Promise<TaskLink[]> {
  const db = await getDb();
  const rows = await db.select<LinkRow[]>(
    `SELECT * FROM task_links WHERE item_kind = $1 AND scope_id = $2 AND item_id = $3 AND workspace_id = $4
     ORDER BY created_at, id`,
    [key.itemKind, key.scopeId, key.itemId, key.workspaceId],
  );
  return rows.map(linkFromRow);
}

/** Every link of one kind within a scope and workspace (for list badges and the linked-work filter). */
export async function getTaskLinksInScope(
  itemKind: LinkItemKind,
  scopeId: string,
  workspaceId: string,
): Promise<TaskLink[]> {
  const db = await getDb();
  const rows = await db.select<LinkRow[]>(
    "SELECT * FROM task_links WHERE item_kind = $1 AND scope_id = $2 AND workspace_id = $3 ORDER BY item_id, created_at",
    [itemKind, scopeId, workspaceId],
  );
  return rows.map(linkFromRow);
}

/** Task IDs linked from anything in the workspace, oldest refresh first. */
export async function getLinkedTaskIds(workspaceId: string): Promise<string[]> {
  const db = await getDb();
  const rows = await db.select<{ task_id: string }[]>(
    `SELECT DISTINCT l.task_id FROM task_links l
     LEFT JOIN clickup_tasks t ON t.tenant_id = l.workspace_id AND t.task_id = l.task_id
     WHERE l.workspace_id = $1 ORDER BY COALESCE(t.refreshed_at, 0), l.task_id`,
    [workspaceId],
  );
  return rows.map((r) => r.task_id);
}

/** Keeps ticket links only for the given helpdesk (called when a different helpdesk is connected). */
export async function deleteTicketLinksOutsideScope(keepScopeId: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM task_links WHERE item_kind = 'ticket' AND scope_id != $1", [keepScopeId]);
}
