/**
 * Creating a ClickUp task from a ticket or an email thread. Remote creation
 * and backlinks are not one transaction: each stage is journalled, an
 * ambiguous timeout is settled by finding the operation marker in the task
 * description before anything is sent again, and a failed backlink is retried
 * on its own. A task from an email carries nothing about the email.
 */
import { withReadSnapshot } from "@/services/db/connection";
import { useUIStore } from "@/stores/uiStore";
import { getClickUpLists, getClickUpWorkspace, replaceTaskDestinations, replaceTaskListDetails, upsertCachedTask } from "@/services/db/clickup";
import {
  finishTaskOperation,
  getTaskOperation,
  getUnsettledTaskOperations,
  startTaskOperation,
  type TaskOperation,
} from "@/services/db/clickupOperations";
import { getCachedTickets } from "@/services/db/freshdeskTickets";
import { deleteSetting, getSetting, setSetting } from "@/services/db/settings";
import { getTaskLink, insertTaskLink, setLinkBacklink, type BacklinkStep, type LinkKey } from "@/services/db/taskLinks";
import { ClickUpError, clickupGet, clickupWrite } from "./client";
import { currentClickUpCredentials } from "./connection";
import { ticketIdFieldGap, ticketLine, writeBacklinks } from "./backlinks";
import {
  NEEDS_CONNECTION_MESSAGE,
  assertNotWaiting,
  backlinkTarget,
  failAction,
  getRelatedTasks,
  linkKey,
  nowS,
  scopeFor,
  type LinkedItem,
  type RelatedTask,
} from "./links";
import { fetchListMembers, fetchListStatuses, fetchListFields, fetchTaskDestinations, type ClickUpMember } from "./metadata";
import { cachedTaskFrom, type ApiTask } from "./tasks";

/** ClickUp's priorities: 1 urgent, 2 high, 3 normal, 4 low */
export type TaskPriority = 1 | 2 | 3 | 4;

export interface NewTaskInput {
  /** The drawer's workspace, so a connection switch cannot submit stale choices. */
  expectedTenantId?: string;
  listId: string;
  name: string;
  description: string;
  /** ClickUp user IDs, members of the list */
  assigneeIds: string[];
  priority: TaskPriority | null;
  /** A status name of the chosen list; the list's first status when null */
  status: string | null;
  /** A date-only deadline, YYYY-MM-DD */
  dueDate: string | null;
}

export type CreateTaskResult =
  | { outcome: "created"; task: RelatedTask }
  /** ClickUp did not answer; settled by reconcileTaskCreation, never by creating again */
  | { outcome: "unconfirmed"; operationId: string; message: string }
  | { outcome: "failed"; message: string }
  /** Nothing was sent: offline, no workspace, or a sample ticket. Never queued. */
  | { outcome: "unavailable"; message: string };

/** A creation whose outcome Velo does not know yet */
export interface PendingTaskCreation {
  operationId: string;
  taskName: string;
  message: string;
}

export const CREATE_UNCONFIRMED_MESSAGE =
  "ClickUp did not answer, so Velo can't tell yet whether the task was created. Velo looks for it in ClickUp instead of creating it again.";
const STILL_UNCONFIRMED_MESSAGE =
  "Velo could not read the list back from ClickUp yet. It will not create the task again until it knows what happened.";

const LAST_LIST_SETTING = "clickup_last_list_id";
/** Velo and ClickUp clocks may disagree a little when reading back tasks created since the attempt */
const CLOCK_SKEW_S = 300;
const RECONCILE_PAGES = 5;

/** The application-generated operation marker, written into the task description */
function newOperationId(): string {
  return `velo-op-${crypto.randomUUID()}`;
}

function markerLine(operationId: string): string {
  return `Velo reference: ${operationId}`;
}

/** A date-only deadline at noon UTC, so it shows on the picked day in every time zone */
export function dueDateMs(date: string): number | null {
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
  return new Date(ms).getUTCDate() === Number(m[3]) ? ms : null;
}

// ---------- what the dialog offers ----------

export interface CreateTaskList {
  listId: string;
  name: string;
  location: string;
  statuses: string[];
}

export interface CreateTaskOptions {
  tenantId: string | null;
  meUserId: string | null;
  discoveryRefreshedAt: number | null;
  discoveryComplete: boolean;
  lists: CreateTaskList[];
  /** The last list a task went to, else the default list */
  initialListId: string | null;
  /** The ticket's subject, as the task title; empty for emails, whose content stays in Velo */
  suggestedName: string;
}

/** The connected workspace's lists and the remembered destination. */
export async function getCreateTaskOptions(item: LinkedItem, config: { refresh?: boolean } = {}): Promise<CreateTaskOptions> {
  if (config.refresh) await refreshTaskDestinations();
  return withReadSnapshot(async () => {
    const workspace = await getClickUpWorkspace();
    if (!workspace) return { tenantId: null, meUserId: null, discoveryRefreshedAt: null, discoveryComplete: false, lists: [], initialListId: null, suggestedName: "" };
    const lists = (await getClickUpLists(workspace.tenantId)).map((l) => ({
      listId: l.listId,
      name: l.name,
      location: l.folderName ? `${l.spaceName} / ${l.folderName}` : l.spaceName,
      statuses: [...l.statuses].sort((a, b) => a.position - b.position).map((s) => s.name),
    }));
    const valid = (id: string | null) => (id && lists.some((l) => l.listId === id) ? id : null);
    const rememberedKey = `${LAST_LIST_SETTING}:${workspace.tenantId}`;
    let remembered = valid(await getSetting(rememberedKey));
    // Upgrade the old global preference only after verifying this workspace owns the list.
    if (!remembered) {
      const legacy = valid(await getSetting(LAST_LIST_SETTING));
      if (legacy) {
        await setSetting(rememberedKey, legacy);
        await deleteSetting(LAST_LIST_SETTING);
        remembered = legacy;
      }
    }
    const initialListId = remembered ?? valid(workspace.defaultListId) ?? lists[0]?.listId ?? null;
    let suggestedName = "";
    if (item.kind === "ticket") {
      const scope = await scopeFor(item);
      const ticket = scope ? (await getCachedTickets(scope)).find((t) => t.ticketId === item.ticketId) : undefined;
      suggestedName = ticket?.subject ?? "";
    }
    const discovery = await getSetting(`clickup_discovery:${workspace.tenantId}`);
    const stamp: { refreshedAt: number; complete: boolean } | null = discovery ? JSON.parse(discovery) : null;
    return { tenantId: workspace.tenantId, meUserId: workspace.me?.userId ?? null,
      discoveryRefreshedAt: stamp?.refreshedAt ?? (workspace.metadataRefreshedAt === null ? null : workspace.metadataRefreshedAt * 1000),
      discoveryComplete: stamp?.complete ?? false, lists, initialListId, suggestedName };
  });
}

/** Reject results from a disconnected/replaced token before caching or offering them. */
async function sameConnection(credentials: { tenantId: string; token: string }): Promise<void> {
  const current = await currentClickUpCredentials();
  if (current?.tenantId !== credentials.tenantId || current.token !== credentials.token) {
    throw new ClickUpError("not_in_workspace", "The ClickUp connection changed. Close and reopen the drawer.");
  }
}

const destinationReads = new Map<string, symbol>();
const listDetailReads = new Map<string, symbol>();

async function refreshTaskDestinations(): Promise<void> {
  if (!useUIStore.getState().isOnline) throw new Error(NEEDS_CONNECTION_MESSAGE);
  const current = await currentClickUpCredentials();
  if (!current) throw new Error("Connect a ClickUp workspace in Settings → ClickUp.");
  const generation = Symbol();
  destinationReads.set(current.tenantId, generation);
  await assertNotWaiting(current.tenantId);
  try {
    const result = await fetchTaskDestinations(current.token, current.workspaceId);
    await sameConnection(current);
    if (destinationReads.get(current.tenantId) !== generation) throw new ClickUpError("not_in_workspace", "List choices changed. Refresh again.");
    await replaceTaskDestinations(current.tenantId, result.lists, Date.now(), result.complete);
  } catch (err) { await sameConnection(current); return failAction(current.tenantId, err); }
}

export interface TaskListDetails {
  listId: string;
  members: ClickUpMember[];
  statuses: string[];
  fieldGap: string | null;
}

/** Authoritative choices for one selected destination, never workspace-wide members. */
export async function getTaskListDetails(listId: string, tenantId: string): Promise<TaskListDetails> {
  if (!useUIStore.getState().isOnline) throw new Error(NEEDS_CONNECTION_MESSAGE);
  const current = await currentClickUpCredentials();
  if (!current || current.tenantId !== tenantId) throw new Error("The ClickUp connection changed. Close and reopen the drawer.");
  if (!(await getClickUpLists(tenantId)).some((l) => l.listId === listId)) throw new Error("Choose a list in the connected workspace.");
  const readKey = `${tenantId}:${listId}`;
  const generation = Symbol();
  listDetailReads.set(readKey, generation);
  await assertNotWaiting(tenantId);
  try {
    const results = await Promise.allSettled([fetchListMembers(current.token, listId), fetchListStatuses(current.token, listId), fetchListFields(current.token, listId)]);
    await sameConnection(current);
    if (listDetailReads.get(readKey) !== generation) throw new ClickUpError("not_in_workspace", "List choices changed. Read the selected list again.");
    const failure = results.find((r) => r.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    const [members, statuses, fields] = results as [PromiseFulfilledResult<ClickUpMember[]>, PromiseFulfilledResult<Awaited<ReturnType<typeof fetchListStatuses>>>, PromiseFulfilledResult<Awaited<ReturnType<typeof fetchListFields>>>];
    await replaceTaskListDetails(tenantId, listId, statuses.value, fields.value);
    return { listId, members: members.value, statuses: statuses.value.sort((a, b) => a.position - b.position).map((s) => s.name), fieldGap: await ticketIdFieldGap(tenantId, listId) };
  } catch (err) { await sameConnection(current); return failAction(tenantId, err); }
}

/** Who can be assigned in the list, read from ClickUp. */
export async function getListMembers(listId: string): Promise<ClickUpMember[]> {
  const credentials = await currentClickUpCredentials();
  if (!credentials) return [];
  await assertNotWaiting(credentials.tenantId);
  try {
    return await fetchListMembers(credentials.token, listId);
  } catch (err) {
    return failAction(credentials.tenantId, err);
  }
}

// ---------- creating ----------

async function validate(input: NewTaskInput, tenantId: string, token: string): Promise<string | null> {
  if (!input.name.trim()) return "Give the task a name.";
  const list = (await getClickUpLists(tenantId)).find((l) => l.listId === input.listId);
  if (!list) return "That list is not in the connected workspace.";
  if (input.status !== null && !list.statuses.some((s) => s.name === input.status)) {
    return `“${input.status}” is not a status of the list “${list.name}”.`;
  }
  if (input.priority !== null && ![1, 2, 3, 4].includes(input.priority)) return "Choose a ClickUp priority.";
  if (input.dueDate !== null && dueDateMs(input.dueDate) === null) return "The due date is not a valid date.";
  if (input.assigneeIds.length > 0) {
    const members = new Set((await fetchListMembers(token, input.listId)).map((m) => m.userId));
    if (input.assigneeIds.some((id) => !members.has(id))) return `Someone chosen can't be assigned in the list “${list.name}”.`;
  }
  return null;
}

function itemOf(key: LinkKey): LinkedItem {
  return key.itemKind === "ticket"
    ? { kind: "ticket", ticketId: key.itemId }
    : { kind: "email", accountId: key.scopeId, threadId: key.itemId };
}

/** Once ClickUp holds the task: store it, link it, then write the ticket's remaining backlinks. */
async function completeCreation(op: TaskOperation, apiTask: ApiTask, credentials: { tenantId: string; token: string }, helpdeskGeneration?: string): Promise<CreateTaskResult> {
  await finishTaskOperation(op.operationId, "confirmed", { taskId: String(apiTask.id) });
  const cached = cachedTaskFrom(apiTask, nowS());
  await upsertCachedTask(credentials.tenantId, cached);
  const me = (await getClickUpWorkspace())?.me ?? null;
  await insertTaskLink(op.key, { taskId: cached.taskId, createdBy: me?.userId ?? null, origin: "created" });

  const item = itemOf(op.key);
  const target = await backlinkTarget(item, op.key, credentials, cached, helpdeskGeneration);
  if (target) {
    // The ticket link went out in the description of the create request itself
    await setLinkBacklink(op.key, cached.taskId, "description", { state: "done", message: null });
    await writeBacklinks(target, ["ticketIdField", "internalNote"], {}, { ...apiTask, custom_fields: [] });
  }
  window.dispatchEvent(new Event("velo-task-links-changed"));
  const task = (await getRelatedTasks(item)).tasks.find((t) => t.taskId === cached.taskId);
  if (!task) return { outcome: "failed", message: "The task was created in ClickUp, but its link could not be saved." };
  return { outcome: "created", task };
}

/**
 * Creates a task in the chosen list and links it to the item. From a ticket,
 * the description carries the ticket link, then the Ticket-ID field and an
 * internal note follow. From an email, nothing about the email is sent.
 */
export async function createTaskFromItem(item: LinkedItem, input: NewTaskInput): Promise<CreateTaskResult> {
  if (!useUIStore.getState().isOnline) return { outcome: "unavailable", message: NEEDS_CONNECTION_MESSAGE };
  const credentials = await currentClickUpCredentials();
  if (!credentials) return { outcome: "unavailable", message: "Connect a ClickUp workspace in Settings → ClickUp to create tasks." };
  if (input.expectedTenantId && input.expectedTenantId !== credentials.tenantId) {
    return { outcome: "unavailable", message: "The ClickUp connection changed. Close and reopen the drawer." };
  }
  const key = await linkKey(item, credentials.tenantId);
  if (!key) return { outcome: "unavailable", message: "Tasks can be created once a helpdesk is connected; sample tickets have no links." };

  const unsettled = (await getUnsettledTaskOperations(key))[0];
  if (unsettled) {
    return {
      outcome: "unconfirmed",
      operationId: unsettled.operationId,
      message: `Velo is still checking whether ClickUp created “${unsettled.taskName}”. Check ClickUp before creating another task.`,
    };
  }

  let ticketUrl: string | null = null;
  let helpdeskGeneration: string | undefined;
  if (item.kind === "ticket") {
    const target = await backlinkTarget(item, key, credentials, { taskId: "", url: "", name: "" });
    if (!target) return { outcome: "unavailable", message: "Tasks can be created once a helpdesk is connected; sample tickets have no links." };
    ticketUrl = target.ticketUrl;
    helpdeskGeneration = target.helpdesk.generation;
  }

  try {
    await assertNotWaiting(credentials.tenantId);
    const invalid = await validate(input, credentials.tenantId, credentials.token);
    if (invalid) return { outcome: "failed", message: invalid };
    await sameConnection(credentials);
    if (!useUIStore.getState().isOnline) return { outcome: "unavailable", message: NEEDS_CONNECTION_MESSAGE };
  } catch (err) {
    if (!(err instanceof ClickUpError)) throw err;
    return { outcome: "failed", message: await messageOf(credentials.tenantId, err) };
  }

  const operationId = newOperationId();
  const description = [
    input.description.trim(),
    item.kind === "ticket" ? ticketLine(item.ticketId, ticketUrl!) : "",
    markerLine(operationId),
  ]
    .filter(Boolean)
    .join("\n\n");
  const request: Record<string, unknown> = {
    name: input.name.trim(),
    markdown_content: description,
    assignees: input.assigneeIds.map(Number),
    ...(input.priority !== null && { priority: input.priority }),
    ...(input.status !== null && { status: input.status }),
    ...(input.dueDate !== null && { due_date: dueDateMs(input.dueDate), due_date_time: false }),
  };
  await startTaskOperation({ operationId, key, listId: input.listId, taskName: input.name.trim(), request });
  await setSetting(`${LAST_LIST_SETTING}:${credentials.tenantId}`, input.listId);

  let created: ApiTask;
  try {
    created = await clickupWrite<ApiTask>(credentials.token, "POST", `/list/${encodeURIComponent(input.listId)}/task`, request);
  } catch (err) {
    if (!(err instanceof ClickUpError)) throw err;
    if (err.kind === "network") {
      await finishTaskOperation(operationId, "unconfirmed", { errorMessage: CREATE_UNCONFIRMED_MESSAGE });
      return { outcome: "unconfirmed", operationId, message: CREATE_UNCONFIRMED_MESSAGE };
    }
    const message = await messageOf(credentials.tenantId, err);
    await finishTaskOperation(operationId, "failed", { errorMessage: message });
    return { outcome: "failed", message };
  }
  return completeCreation((await getTaskOperation(operationId))!, created, credentials, helpdeskGeneration);
}

async function messageOf(tenantId: string, err: ClickUpError): Promise<string> {
  try {
    await failAction(tenantId, err);
  } catch (mapped) {
    if (mapped instanceof Error) return mapped.message;
  }
  return err.message;
}

type ListedTask = ApiTask & { description?: string | null; markdown_description?: string | null; text_content?: string | null };

/**
 * Reconciliation of an unconfirmed creation: reads the list's tasks created
 * since the attempt and looks for the operation marker. Never creates again.
 */
export async function reconcileTaskCreation(operationId: string): Promise<CreateTaskResult> {
  const op = await getTaskOperation(operationId);
  if (!op) return { outcome: "failed", message: "Velo has no record of this task creation." };
  if (op.outcome === "failed") return { outcome: "failed", message: op.errorMessage ?? "The task was not created." };
  const credentials = await currentClickUpCredentials();
  if (!credentials || credentials.tenantId !== op.key.workspaceId) {
    return { outcome: "unavailable", message: "Connect the same ClickUp workspace to check this task." };
  }
  if (op.outcome === "confirmed" && op.taskId) {
    const task = (await getRelatedTasks(itemOf(op.key))).tasks.find((t) => t.taskId === op.taskId);
    if (task) return { outcome: "created", task };
  }
  if (!useUIStore.getState().isOnline) return { outcome: "unconfirmed", operationId, message: STILL_UNCONFIRMED_MESSAGE };

  const target = await backlinkTarget(itemOf(op.key), op.key, credentials, { taskId: "", url: "", name: "" });
  const helpdeskGeneration = target?.helpdesk.generation;
  const marker = markerLine(operationId);
  const since = (op.createdAt - CLOCK_SKEW_S) * 1000;
  try {
    await assertNotWaiting(credentials.tenantId);
    for (let page = 0; page < RECONCILE_PAGES; page++) {
      const { tasks, last_page } = await clickupGet<{ tasks: ListedTask[]; last_page?: boolean }>(
        credentials.token,
        `/list/${encodeURIComponent(op.listId)}/task?page=${page}&date_created_gt=${since}&include_closed=true&subtasks=true&include_markdown_description=true`,
      );
      const found = tasks.find((t) => [t.markdown_description, t.description, t.text_content].some((d) => d?.includes(marker)));
      if (found) return completeCreation(op, found, credentials, helpdeskGeneration);
      if (last_page !== false || tasks.length === 0) break;
    }
  } catch {
    return { outcome: "unconfirmed", operationId, message: STILL_UNCONFIRMED_MESSAGE };
  }
  const message = "ClickUp has no task from that attempt, so none was created. Create it again when ready.";
  await finishTaskOperation(operationId, "failed", { errorMessage: message });
  return { outcome: "failed", message };
}

/** The item's creations whose outcome is not known yet. */
export async function getPendingTaskCreations(item: LinkedItem): Promise<PendingTaskCreation[]> {
  const workspace = await getClickUpWorkspace();
  if (!workspace) return [];
  const key = await linkKey(item, workspace.tenantId);
  if (!key) return [];
  return (await getUnsettledTaskOperations(key)).map((op) => ({
    operationId: op.operationId,
    taskName: op.taskName,
    message: op.errorMessage ?? CREATE_UNCONFIRMED_MESSAGE,
  }));
}

// ---------- retrying backlinks ----------

/** Writes only the backlinks of a ticket link that are not done (failed, pending or unconfirmed). */
export async function retryMissingBacklinks(item: LinkedItem, taskId: string): Promise<RelatedTask> {
  if (!useUIStore.getState().isOnline) throw new Error(NEEDS_CONNECTION_MESSAGE);
  const credentials = await currentClickUpCredentials();
  if (!credentials) throw new Error("Connect a ClickUp workspace in Settings → ClickUp.");
  const key = await linkKey(item, credentials.tenantId);
  const link = key ? await getTaskLink(key, taskId) : null;
  if (!key || !link) throw new Error("This task is no longer linked here.");
  const related = (await getRelatedTasks(item)).tasks.find((t) => t.taskId === taskId)!;
  const missing = related.backlinks.filter((b) => b.state !== "done" && b.state !== "skipped").map((b) => b.step as BacklinkStep);
  const target = await backlinkTarget(item, key, credentials, { taskId, url: related.url, name: related.name });
  if (target && missing.length > 0) await writeBacklinks(target, missing, link.backlinks);
  window.dispatchEvent(new Event("velo-task-links-changed"));
  return (await getRelatedTasks(item)).tasks.find((t) => t.taskId === taskId) ?? related;
}
