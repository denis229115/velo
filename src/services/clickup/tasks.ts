import type { CachedTask } from "@/services/db/clickup";
import { ClickUpError, clickupGet } from "./client";

/** What the operator pasted, once recognised as a task URL or ID. Still unverified. */
export type TaskReference = { taskId: string } | { customId: string; workspaceId: string | null };

const TASK_ID = /^[a-z0-9]{3,20}$/i;
const CUSTOM_ID = /^[a-z][a-z0-9_]*-\d+$/i;

/**
 * Recognises a ClickUp task URL (app.clickup.com/t/<id> or /t/<workspace>/<custom id>),
 * a task ID or a custom task ID. Null for anything else. Recognition says
 * nothing about whether the task exists: that is verified through the API.
 */
export function parseTaskReference(input: string): TaskReference | null {
  const text = input.trim().replace(/^#/, "");
  if (!text) return null;

  if (/^https?:\/\//i.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return null;
    }
    if (url.hostname !== "app.clickup.com") return null;
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== "t") return null;
    if (parts.length === 2 && TASK_ID.test(parts[1]!)) return { taskId: parts[1]! };
    if (parts.length === 3 && /^\d+$/.test(parts[1]!) && CUSTOM_ID.test(parts[2]!)) {
      return { customId: parts[2]!, workspaceId: parts[1]! };
    }
    return null;
  }

  if (CUSTOM_ID.test(text)) return { customId: text, workspaceId: null };
  // A bare ID carries at least one digit, so a plain search word is not taken for one
  if (TASK_ID.test(text) && /\d/.test(text)) return { taskId: text };
  return null;
}

export function describeReference(ref: TaskReference): string {
  return "taskId" in ref ? ref.taskId : ref.customId;
}

// ---------- untrusted remote text ----------

// C0/C1 controls and bidirectional overrides/isolates, which can disguise text
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;
const MAX_TEXT = 300;

/** Task text from ClickUp is untrusted: shown only as plain text, without control or direction characters. */
export function sanitizeText(value: unknown, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  const clean = value.replace(UNSAFE_CHARS, "").replace(/\s+/g, " ").trim();
  if (!clean) return fallback;
  return clean.length > MAX_TEXT ? `${clean.slice(0, MAX_TEXT - 1)}…` : clean;
}

/** Only a ClickUp https URL is ever opened; anything else falls back to the canonical task URL. */
export function safeTaskUrl(value: unknown, taskId: string): string {
  if (typeof value === "string") {
    try {
      const url = new URL(value);
      if (url.protocol === "https:" && url.hostname === "app.clickup.com") return url.href;
    } catch {
      // fall through
    }
  }
  return `https://app.clickup.com/t/${encodeURIComponent(taskId)}`;
}

function safeColor(value: unknown): string | null {
  return typeof value === "string" && /^#[0-9a-f]{3,8}$/i.test(value) ? value : null;
}

function msOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export interface ApiTask {
  id: string;
  custom_id?: string | null;
  name?: string;
  status?: { status?: string; type?: string; color?: string };
  assignees?: { id: number | string; username?: string | null; email?: string | null }[];
  due_date?: string | number | null;
  date_updated?: string | number | null;
  url?: string;
  list?: { id?: string; name?: string };
  team_id?: string | number;
}

/** A task as Velo keeps it: sanitised, with ClickUp's own status name and type. */
export function cachedTaskFrom(task: ApiTask, refreshedAt: number): Omit<CachedTask, "missing"> {
  const taskId = String(task.id);
  return {
    taskId,
    customId: task.custom_id ? sanitizeText(task.custom_id) || null : null,
    name: sanitizeText(task.name, `Task ${taskId}`),
    statusName: sanitizeText(task.status?.status, "unknown status"),
    statusType: sanitizeText(task.status?.type, "unknown"),
    statusColor: safeColor(task.status?.color),
    assignees: (task.assignees ?? [])
      .map((a) => sanitizeText(a.username) || sanitizeText(a.email) || `User ${a.id}`),
    dueAt: msOrNull(task.due_date),
    listId: task.list?.id ? String(task.list.id) : null,
    listName: task.list?.name ? sanitizeText(task.list.name) : null,
    url: safeTaskUrl(task.url, taskId),
    updatedAt: msOrNull(task.date_updated),
    refreshedAt,
  };
}

/** ClickUp's done and closed status types mean the task is complete. */
export function isDoneStatusType(type: string): boolean {
  return type === "done" || type === "closed";
}

/**
 * Reads one task by reference and checks it belongs to the connected
 * workspace. Unknown or foreign tasks are rejected with an explanation.
 */
export async function fetchVerifiedTask(token: string, workspaceId: string, ref: TaskReference): Promise<ApiTask> {
  const label = describeReference(ref);
  if ("customId" in ref && ref.workspaceId !== null && ref.workspaceId !== workspaceId) {
    throw new ClickUpError("not_in_workspace", `Task ${label} is not in the connected workspace.`);
  }
  const path =
    "taskId" in ref
      ? `/task/${encodeURIComponent(ref.taskId)}`
      : `/task/${encodeURIComponent(ref.customId)}?custom_task_ids=true&team_id=${encodeURIComponent(workspaceId)}`;
  let task: ApiTask;
  try {
    task = await clickupGet<ApiTask>(token, path);
  } catch (err) {
    if (err instanceof ClickUpError && err.kind === "not_found") {
      throw new ClickUpError("not_found", `No task ${label} in the connected workspace.`, err.status);
    }
    if (err instanceof ClickUpError && err.kind === "not_in_workspace") {
      throw new ClickUpError("not_in_workspace", `Task ${label} is not in the connected workspace.`, err.status);
    }
    throw err;
  }
  if (!task || typeof task.id !== "string" || (task.team_id !== undefined && String(task.team_id) !== workspaceId)) {
    throw new ClickUpError("not_in_workspace", `Task ${label} is not in the connected workspace.`);
  }
  return task;
}

const SEARCH_PAGES = 3;
const MAX_RESULTS = 20;

/**
 * Finds tasks whose name contains the query. ClickUp's v2 task listing has no
 * name filter, so Velo reads a bounded number of recently updated pages and
 * matches locally.
 */
export async function searchWorkspaceTasks(token: string, workspaceId: string, query: string): Promise<ApiTask[]> {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const found: ApiTask[] = [];
  for (let page = 0; page < SEARCH_PAGES && found.length < MAX_RESULTS; page++) {
    const { tasks, last_page } = await clickupGet<{ tasks: ApiTask[]; last_page?: boolean }>(
      token,
      `/team/${encodeURIComponent(workspaceId)}/task?page=${page}&include_closed=true&subtasks=true&order_by=updated`,
    );
    for (const t of tasks) {
      if (found.length >= MAX_RESULTS) break;
      if (sanitizeText(t.name).toLowerCase().includes(needle)) found.push(t);
    }
    if (last_page !== false || tasks.length === 0) break;
  }
  return found;
}
