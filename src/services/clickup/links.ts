import { createBackgroundChecker } from "@/services/backgroundCheckers";
import { getIntegrationAccount } from "@/services/db/freshdesk";
import {
  getCachedTasks,
  getClickUpSyncState,
  getClickUpWorkspace,
  markCachedTaskMissing,
  saveClickUpSyncState,
  upsertCachedTask,
  type CachedTask,
  type ClickUpSyncState,
} from "@/services/db/clickup";
import {
  deleteTaskLink,
  getLinkedTaskIds,
  getTaskLinks,
  getTaskLinksInScope,
  insertTaskLink,
  type LinkKey,
  type LinkOrigin,
} from "@/services/db/taskLinks";
import { ClickUpError } from "./client";
import { currentClickUpCredentials } from "./connection";
import {
  cachedTaskFrom,
  fetchVerifiedTask,
  isDoneStatusType,
  parseTaskReference,
  searchWorkspaceTasks,
  type TaskReference,
} from "./tasks";

/** A ticket of the connected helpdesk, or an email thread of one email account. */
export type LinkedItem =
  | { kind: "ticket"; ticketId: string }
  | { kind: "email"; accountId: string; threadId: string };

export interface RelatedTask {
  taskId: string;
  customId: string | null;
  name: string;
  /** ClickUp's own status name; ClickUp owns task status */
  status: string;
  statusColor: string | null;
  /** The task's status is of ClickUp's done or closed type */
  done: boolean;
  assignees: string[];
  /** Unix ms */
  dueAt: number | null;
  listName: string | null;
  url: string;
  /** When Velo last read the task from ClickUp, unix ms */
  refreshedAt: number | null;
  /** ClickUp no longer returns the task */
  missing: boolean;
  origin: LinkOrigin;
  /** Unix ms */
  linkedAt: number;
}

export interface TaskRefreshStatus {
  state: ClickUpSyncState["state"];
  /** Unix ms */
  lastSuccessAt: number | null;
  /** When a Retry-After or backoff wait ends, unix ms */
  retryAt: number | null;
  /** Actionable text for the operator; never contains credentials */
  message: string | null;
}

export type RelatedTasksState =
  /** Links work: a real item and a connected workspace */
  | "ready"
  | "no_workspace"
  /** A sample ticket (no helpdesk connected); links need real tickets */
  | "sample_item";

export interface RelatedTasksView {
  state: RelatedTasksState;
  tasks: RelatedTask[];
  refresh: TaskRefreshStatus;
}

export const CLICKUP_AUTH_MESSAGE =
  "ClickUp rejected the API token; it may have expired or been revoked. Reconnect the workspace in Settings → ClickUp.";
const RATE_LIMIT_MESSAGE = "ClickUp asked Velo to slow down. Task refresh resumes automatically.";

const nowS = () => Math.floor(Date.now() / 1000);
const MAX_BACKOFF_S = 60 * 60;
/** Tasks read per refresh run, so a large set of links never floods ClickUp */
const MAX_TASKS_PER_REFRESH = 25;
/** Opening an item re-reads its tasks only when they are older than this */
const OPEN_REFRESH_AFTER_S = 60;

function backoffSeconds(failures: number): number {
  return Math.min(60 * 2 ** failures, MAX_BACKOFF_S);
}

function timeOf(unixS: number): string {
  return new Date(unixS * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

async function scopeFor(item: LinkedItem): Promise<string | null> {
  if (item.kind === "email") return item.accountId;
  return (await getIntegrationAccount("freshdesk"))?.tenantId ?? null;
}

function itemId(item: LinkedItem): string {
  return item.kind === "ticket" ? item.ticketId : item.threadId;
}

async function linkKey(item: LinkedItem, workspaceTenantId: string): Promise<LinkKey | null> {
  const scopeId = await scopeFor(item);
  if (!scopeId) return null;
  return { itemKind: item.kind, scopeId, itemId: itemId(item), workspaceId: workspaceTenantId };
}

function refreshStatusFrom(s: ClickUpSyncState, now: number): TaskRefreshStatus {
  return {
    state: s.state,
    lastSuccessAt: s.lastSuccessAt === null ? null : s.lastSuccessAt * 1000,
    retryAt: s.retryAfterUntil !== null && s.retryAfterUntil > now ? s.retryAfterUntil * 1000 : null,
    message: s.errorMessage,
  };
}

const IDLE_REFRESH: TaskRefreshStatus = { state: "idle", lastSuccessAt: null, retryAt: null, message: null };

/** Records a failed ClickUp call: Retry-After or backoff for throttling, a reconnect prompt for rejected credentials. */
async function recordFailure(tenantId: string, err: unknown): Promise<ClickUpSyncState> {
  const now = nowS();
  const state = await getClickUpSyncState(tenantId);
  const kind = err instanceof ClickUpError ? err.kind : "network";
  console.warn(`[ClickUpTasks] request failed: ${kind}`);
  const next: ClickUpSyncState = { ...state, lastAttemptAt: now, consecutiveFailures: state.consecutiveFailures + 1 };
  if (kind === "auth") {
    Object.assign(next, { state: "auth_error", retryAfterUntil: null, errorMessage: CLICKUP_AUTH_MESSAGE });
  } else if (kind === "rate_limited") {
    const wait = (err as ClickUpError).retryAfterSeconds ?? backoffSeconds(state.consecutiveFailures);
    Object.assign(next, { state: "rate_limited", retryAfterUntil: now + wait, errorMessage: RATE_LIMIT_MESSAGE });
  } else {
    Object.assign(next, {
      state: "error",
      retryAfterUntil: now + backoffSeconds(state.consecutiveFailures),
      errorMessage: kind === "network" ? "Couldn't reach ClickUp. Velo will retry." : "Reading tasks from ClickUp failed. Velo will retry.",
    });
  }
  await saveClickUpSyncState(tenantId, next);
  return next;
}

async function recordSuccess(tenantId: string): Promise<void> {
  const now = nowS();
  const state = await getClickUpSyncState(tenantId);
  await saveClickUpSyncState(tenantId, {
    ...state,
    state: "ok",
    lastAttemptAt: now,
    lastSuccessAt: now,
    retryAfterUntil: null,
    consecutiveFailures: 0,
    errorMessage: null,
  });
}

/** Throws instead of calling ClickUp while a Retry-After wait runs. */
async function assertNotWaiting(tenantId: string): Promise<void> {
  const state = await getClickUpSyncState(tenantId);
  const now = nowS();
  if (state.retryAfterUntil !== null && state.retryAfterUntil > now) {
    throw new ClickUpError(
      "rate_limited",
      `ClickUp asked Velo to slow down. Try again after ${timeOf(state.retryAfterUntil)}.`,
      429,
      state.retryAfterUntil - now,
    );
  }
}

/** A user-facing error for a failed operator action, after recording it. */
async function failAction(tenantId: string, err: unknown): Promise<never> {
  if (err instanceof ClickUpError && (err.kind === "not_found" || err.kind === "not_in_workspace")) throw err;
  const recorded = await recordFailure(tenantId, err);
  if (recorded.state === "auth_error") throw new ClickUpError("auth", CLICKUP_AUTH_MESSAGE);
  if (recorded.state === "rate_limited" && recorded.retryAfterUntil !== null) {
    throw new ClickUpError("rate_limited", `ClickUp asked Velo to slow down. Try again after ${timeOf(recorded.retryAfterUntil)}.`, 429);
  }
  throw err;
}

async function requireLinkContext(item: LinkedItem) {
  const credentials = await currentClickUpCredentials();
  if (!credentials) throw new Error("Connect a ClickUp workspace in Settings → ClickUp to link tasks.");
  const key = await linkKey(item, credentials.tenantId);
  if (!key) throw new Error("Tasks can be linked once a helpdesk is connected; sample tickets have no links.");
  return { credentials, key };
}

/**
 * Links an existing task to the item. The pasted URL or ID (or a search
 * result's task ID) is verified through ClickUp first; nothing is written to
 * ClickUp or Freshdesk.
 */
export async function linkTask(item: LinkedItem, reference: string | { taskId: string }): Promise<RelatedTask> {
  const ref: TaskReference | null = typeof reference === "string" ? parseTaskReference(reference) : reference;
  if (!ref) throw new ClickUpError("not_found", "That is not a ClickUp task URL or ID.");
  const { credentials, key } = await requireLinkContext(item);
  await assertNotWaiting(credentials.tenantId);

  let verified;
  try {
    verified = await fetchVerifiedTask(credentials.token, credentials.workspaceId, ref);
  } catch (err) {
    return failAction(credentials.tenantId, err);
  }
  const cached = cachedTaskFrom(verified, nowS());
  await upsertCachedTask(credentials.tenantId, cached);

  const me = (await getClickUpWorkspace())?.me ?? null;
  const inserted = await insertTaskLink(key, { taskId: cached.taskId, createdBy: me?.userId ?? null, origin: "linked" });
  if (!inserted) throw new Error(`“${cached.name}” is already linked here.`);

  const related = (await getRelatedTasks(item)).tasks.find((t) => t.taskId === cached.taskId);
  if (!related) throw new Error("The link could not be saved.");
  return related;
}

/** Removes only this item's link. The task, and every other item's link to it, stay. */
export async function unlinkTask(item: LinkedItem, taskId: string): Promise<void> {
  const workspace = await getClickUpWorkspace();
  if (!workspace) return;
  const key = await linkKey(item, workspace.tenantId);
  if (!key) return;
  await deleteTaskLink(key, taskId);
}

function relatedFrom(link: { taskId: string; origin: LinkOrigin; createdAt: number }, task: CachedTask | undefined): RelatedTask {
  return {
    taskId: link.taskId,
    customId: task?.customId ?? null,
    name: task?.name ?? `Task ${link.taskId}`,
    status: task?.statusName ?? "not loaded yet",
    statusColor: task?.statusColor ?? null,
    done: task ? isDoneStatusType(task.statusType) : false,
    assignees: task?.assignees ?? [],
    dueAt: task?.dueAt ?? null,
    listName: task?.listName ?? null,
    url: task?.url ?? `https://app.clickup.com/t/${encodeURIComponent(link.taskId)}`,
    refreshedAt: task ? task.refreshedAt * 1000 : null,
    missing: task?.missing ?? false,
    origin: link.origin,
    linkedAt: link.createdAt * 1000,
  };
}

/** The item's Related tasks, from the local copy, within the connected workspace only. */
export async function getRelatedTasks(item: LinkedItem): Promise<RelatedTasksView> {
  const workspace = await getClickUpWorkspace();
  if (!workspace) return { state: "no_workspace", tasks: [], refresh: IDLE_REFRESH };
  const key = await linkKey(item, workspace.tenantId);
  if (!key) return { state: "sample_item", tasks: [], refresh: IDLE_REFRESH };
  const links = await getTaskLinks(key);
  const tasks = await getCachedTasks(workspace.tenantId, links.map((l) => l.taskId));
  const refresh = refreshStatusFrom(await getClickUpSyncState(workspace.tenantId), nowS());
  return { state: "ready", tasks: links.map((l) => relatedFrom(l, tasks.get(l.taskId))), refresh };
}

export type TaskRefreshTrigger = "open" | "manual" | "poll";

/**
 * Re-reads tasks from ClickUp into the local copy. Only reads: a completed
 * task never changes the ticket. Retry-After waits are always honoured; after
 * rejected credentials only a manual refresh tries again.
 */
async function refreshTasks(taskIds: string[], trigger: TaskRefreshTrigger): Promise<void> {
  const credentials = await currentClickUpCredentials();
  if (!credentials || taskIds.length === 0) return;
  const { tenantId, token, workspaceId } = credentials;
  const state = await getClickUpSyncState(tenantId);
  const now = nowS();
  if (state.state === "auth_error" && trigger !== "manual") return;
  if (state.retryAfterUntil !== null && state.retryAfterUntil > now) return;

  let ids = taskIds;
  if (trigger === "open") {
    const cached = await getCachedTasks(tenantId, taskIds);
    ids = taskIds.filter((id) => {
      const t = cached.get(id);
      return !t || now - t.refreshedAt >= OPEN_REFRESH_AFTER_S;
    });
    if (ids.length === 0) return;
  }

  try {
    for (const taskId of ids.slice(0, MAX_TASKS_PER_REFRESH)) {
      try {
        const task = await fetchVerifiedTask(token, workspaceId, { taskId });
        await upsertCachedTask(tenantId, cachedTaskFrom(task, nowS()));
      } catch (err) {
        if (err instanceof ClickUpError && (err.kind === "not_found" || err.kind === "not_in_workspace")) {
          await markCachedTaskMissing(tenantId, taskId, nowS());
          continue;
        }
        throw err;
      }
    }
    await recordSuccess(tenantId);
  } catch (err) {
    await recordFailure(tenantId, err);
  }
}

/** Refreshes the tasks linked from one item (on open, or when the operator asks). */
export async function refreshRelatedTasks(item: LinkedItem, opts: { trigger: TaskRefreshTrigger }): Promise<RelatedTasksView> {
  const before = await getRelatedTasks(item);
  if (before.state === "ready") await refreshTasks(before.tasks.map((t) => t.taskId), opts.trigger);
  const after = await getRelatedTasks(item);
  window.dispatchEvent(new Event("velo-task-links-changed"));
  return after;
}

/** Background refresh of every linked task, least recently read first. */
export async function refreshAllLinkedTasks(): Promise<void> {
  const workspace = await getClickUpWorkspace();
  if (!workspace) return;
  await refreshTasks(await getLinkedTaskIds(workspace.tenantId), "poll");
  window.dispatchEvent(new Event("velo-task-links-changed"));
}

export interface TaskSearchResult {
  taskId: string;
  name: string;
  status: string;
  done: boolean;
  listName: string | null;
  alreadyLinked: boolean;
}

/** Searches the workspace's tasks by name, for linking. Results are verified again when linked. */
export async function searchTasksToLink(item: LinkedItem, query: string): Promise<TaskSearchResult[]> {
  const { credentials, key } = await requireLinkContext(item);
  await assertNotWaiting(credentials.tenantId);
  let found;
  try {
    found = await searchWorkspaceTasks(credentials.token, credentials.workspaceId, query);
  } catch (err) {
    return failAction(credentials.tenantId, err);
  }
  const linked = new Set((await getTaskLinks(key)).map((l) => l.taskId));
  return found.map((t) => {
    const c = cachedTaskFrom(t, nowS());
    return {
      taskId: c.taskId,
      name: c.name,
      status: c.statusName,
      done: isDoneStatusType(c.statusType),
      listName: c.listName,
      alreadyLinked: linked.has(c.taskId),
    };
  });
}

export interface LinkedWorkSummary {
  /** Linked tasks */
  count: number;
  /** Of those, how many are done */
  done: number;
}

/** Linked-task counts per ticket of the connected helpdesk and workspace, for list badges and the linked-work filter. */
export async function getLinkedTicketSummary(): Promise<Map<string, LinkedWorkSummary>> {
  const workspace = await getClickUpWorkspace();
  const helpdesk = await getIntegrationAccount("freshdesk");
  if (!workspace || !helpdesk) return new Map();
  const links = await getTaskLinksInScope("ticket", helpdesk.tenantId, workspace.tenantId);
  const tasks = await getCachedTasks(workspace.tenantId, [...new Set(links.map((l) => l.taskId))]);
  const summary = new Map<string, LinkedWorkSummary>();
  for (const l of links) {
    const s = summary.get(l.itemId) ?? { count: 0, done: 0 };
    s.count += 1;
    const t = tasks.get(l.taskId);
    if (t && isDoneStatusType(t.statusType)) s.done += 1;
    summary.set(l.itemId, s);
  }
  return summary;
}

const FIVE_MINUTES = 5 * 60 * 1000;
const linkedTaskPoller = createBackgroundChecker("ClickUpLinkedTasks", refreshAllLinkedTasks, FIVE_MINUTES);
export const startLinkedTaskRefresh = linkedTaskPoller.start;
export const stopLinkedTaskRefresh = linkedTaskPoller.stop;
