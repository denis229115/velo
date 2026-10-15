import { getDb } from "./connection";
import type { LinkKey } from "./taskLinks";

/** How a task creation ended: never guessed; an unconfirmed one is settled by reconciliation */
export type TaskOperationOutcome = "pending" | "confirmed" | "failed" | "unconfirmed";

/** One task creation in the Operation journal, keyed by the operation marker written into the task */
export interface TaskOperation {
  operationId: string;
  key: LinkKey;
  listId: string;
  taskName: string;
  /** What was sent to ClickUp */
  request: Record<string, unknown>;
  outcome: TaskOperationOutcome;
  taskId: string | null;
  errorMessage: string | null;
  /** Unix s */
  createdAt: number;
  completedAt: number | null;
}

interface OperationRow {
  operation_id: string;
  workspace_id: string;
  item_kind: LinkKey["itemKind"];
  scope_id: string;
  item_id: string;
  list_id: string;
  task_name: string;
  request_json: string;
  outcome: TaskOperationOutcome;
  task_id: string | null;
  error_message: string | null;
  created_at: number;
  completed_at: number | null;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

function operationFromRow(r: OperationRow): TaskOperation {
  return {
    operationId: r.operation_id,
    key: { itemKind: r.item_kind, scopeId: r.scope_id, itemId: r.item_id, workspaceId: r.workspace_id },
    listId: r.list_id,
    taskName: r.task_name,
    request: JSON.parse(r.request_json) as Record<string, unknown>,
    outcome: r.outcome,
    taskId: r.task_id,
    errorMessage: r.error_message,
    createdAt: r.created_at,
    completedAt: r.completed_at,
  };
}

/** Records a task creation before it is sent. */
export async function startTaskOperation(input: {
  operationId: string;
  key: LinkKey;
  listId: string;
  taskName: string;
  request: Record<string, unknown>;
}): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO clickup_task_operations
       (operation_id, workspace_id, item_kind, scope_id, item_id, list_id, task_name, request_json, outcome, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9)`,
    [
      input.operationId,
      input.key.workspaceId,
      input.key.itemKind,
      input.key.scopeId,
      input.key.itemId,
      input.listId,
      input.taskName,
      JSON.stringify(input.request),
      nowSeconds(),
    ],
  );
}

export async function finishTaskOperation(
  operationId: string,
  outcome: TaskOperationOutcome,
  result: { taskId?: string | null; errorMessage?: string | null } = {},
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE clickup_task_operations SET outcome = $1, task_id = COALESCE($2, task_id), error_message = $3, completed_at = $4
     WHERE operation_id = $5`,
    [outcome, result.taskId ?? null, result.errorMessage ?? null, nowSeconds(), operationId],
  );
}

export async function getTaskOperation(operationId: string): Promise<TaskOperation | null> {
  const db = await getDb();
  const rows = await db.select<OperationRow[]>("SELECT * FROM clickup_task_operations WHERE operation_id = $1", [operationId]);
  return rows[0] ? operationFromRow(rows[0]) : null;
}

/** An item's task creations whose outcome is not known yet, oldest first. */
export async function getUnsettledTaskOperations(key: LinkKey): Promise<TaskOperation[]> {
  const db = await getDb();
  const rows = await db.select<OperationRow[]>(
    `SELECT * FROM clickup_task_operations
     WHERE workspace_id = $1 AND item_kind = $2 AND scope_id = $3 AND item_id = $4 AND outcome IN ('pending', 'unconfirmed')
     ORDER BY created_at, operation_id`,
    [key.workspaceId, key.itemKind, key.scopeId, key.itemId],
  );
  return rows.map(operationFromRow);
}
