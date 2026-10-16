/**
 * Backlinks: the pointers Velo writes into ClickUp and Freshdesk when a ticket
 * is linked to a task. Each step is recorded on the link before and after it
 * runs, so a failed step stays pending and a retry writes only what is missing.
 * Email links have none.
 */
import { getClickUpCustomFields, getClickUpLists, getClickUpWorkspace } from "@/services/db/clickup";
import { finishJournalEntry, getJournalEntries, startJournalEntry } from "@/services/db/freshdeskJournal";
import { setLinkBacklink, type BacklinkRecord, type BacklinkStep, type Backlinks, type LinkKey } from "@/services/db/taskLinks";
import { FreshdeskError, freshdeskPost } from "@/services/freshdesk/client";
import { currentCredentials } from "@/services/freshdesk/connection";
import { refreshTicketHistory } from "@/services/freshdesk/ticketHistory";
import { sanitizeHtml } from "@/utils/sanitize";
import { ClickUpError, clickupGet, clickupWrite } from "./client";
import { assertNotWaiting, failAction } from "./links";
import type { ApiTask } from "./tasks";

export const BACKLINK_LABELS: Record<BacklinkStep, string> = {
  description: "Ticket link in the task description",
  ticketIdField: "Ticket-ID field",
  internalNote: "Internal note on the ticket",
};

/** What a ticket link's backlinks point at */
export interface BacklinkTarget {
  key: LinkKey;
  helpdesk: NonNullable<Awaited<ReturnType<typeof currentCredentials>>>;
  credentials: { tenantId: string; token: string };
  ticketId: string;
  ticketUrl: string;
  taskId: string;
  taskUrl: string;
  taskName: string;
}

/** The task as ClickUp holds it: its list, description and custom field values */
type RemoteTask = ApiTask & {
  description?: string | null;
  markdown_description?: string | null;
  custom_fields?: { id: string; value?: unknown }[];
};

export const NOTE_UNCONFIRMED_MESSAGE =
  "Freshdesk did not answer, so Velo can't tell yet whether the internal note was added. Retrying checks the ticket first.";

/** The description line that points at the ticket */
export function ticketLine(ticketId: string, ticketUrl: string): string {
  return `Freshdesk ticket #${ticketId}: ${ticketUrl}`;
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The internal note's HTML; the task name is untrusted and shown only as text */
function noteBody(t: BacklinkTarget): string {
  const url = escapeHtml(t.taskUrl);
  return sanitizeHtml(`<p>Linked ClickUp task: <a href="${url}">${escapeHtml(t.taskName)}</a><br>${url}</p>`);
}

async function clickupMessage(tenantId: string, err: unknown): Promise<string> {
  try {
    await failAction(tenantId, err);
  } catch (mapped) {
    if (mapped instanceof Error) return mapped.message;
  }
  return "ClickUp did not take the change.";
}

const freshdeskMessage = (error: FreshdeskError) =>
  error.detail?.message ? `${error.message.replace(/\.$/, "")}: ${error.detail.message}` : error.message;

/** Why the Ticket-ID field is not written for a task in this list; null when it is */
export async function ticketIdFieldGap(tenantId: string, listId: string | null): Promise<string | null> {
  const fieldId = (await getClickUpWorkspace())?.ticketIdFieldId ?? null;
  if (!fieldId) return "No Ticket-ID field is selected in Settings → ClickUp, so only the ticket link and the internal note are written.";
  const fields = await getClickUpCustomFields(tenantId);
  if (listId && fields.some((f) => f.listId === listId && f.fieldId === fieldId)) return null;
  const listName = (await getClickUpLists(tenantId)).find((l) => l.listId === listId)?.name;
  return `${listName ? `The list “${listName}”` : "This task's list"} has no Ticket-ID field. The ticket link and the internal note are still written.`;
}

async function readTask(t: BacklinkTarget): Promise<RemoteTask> {
  await assertNotWaiting(t.credentials.tenantId);
  return clickupGet<RemoteTask>(t.credentials.token, `/task/${encodeURIComponent(t.taskId)}?include_markdown_description=true`);
}

async function writeDescription(t: BacklinkTarget, task: RemoteTask): Promise<BacklinkRecord> {
  const current = task.markdown_description ?? task.description ?? "";
  if (current.includes(t.ticketUrl)) return { state: "done", message: null };
  const next = `${current.trimEnd()}${current.trim() ? "\n\n" : ""}${ticketLine(t.ticketId, t.ticketUrl)}`;
  await assertNotWaiting(t.credentials.tenantId);
  await clickupWrite(t.credentials.token, "PUT", `/task/${encodeURIComponent(t.taskId)}`, { markdown_content: next });
  return { state: "done", message: null };
}

async function writeTicketIdField(t: BacklinkTarget, task: RemoteTask): Promise<BacklinkRecord> {
  const { tenantId, token } = t.credentials;
  const gap = await ticketIdFieldGap(tenantId, task.list?.id ? String(task.list.id) : null);
  if (gap) return { state: "skipped", message: gap };
  const fieldId = (await getClickUpWorkspace())!.ticketIdFieldId!;
  const held = task.custom_fields?.find((f) => f.id === fieldId)?.value;
  if (held !== undefined && held !== null && held !== "") {
    if (String(held) === t.ticketId) return { state: "done", message: null };
    // One field holds one ticket: a task shared by several tickets keeps the first
    return { state: "skipped", message: `The Ticket-ID field already holds ticket ${String(held).slice(0, 40)}; Velo left it unchanged.` };
  }
  const type = (await getClickUpCustomFields(tenantId)).find((f) => f.fieldId === fieldId)?.type;
  const value = type === "number" ? Number(t.ticketId) : t.ticketId;
  await assertNotWaiting(tenantId);
  await clickupWrite(token, "POST", `/task/${encodeURIComponent(t.taskId)}/field/${encodeURIComponent(fieldId)}`, { value });
  return { state: "done", message: null };
}

/** A reconnect invalidates captured credentials, including reconnects to the same host. */
async function sameHelpdesk(t: BacklinkTarget): Promise<boolean> {
  const current = await currentCredentials();
  return current?.tenantId === t.key.scopeId && current.generation === t.helpdesk.generation;
}

/** Reads the original helpdesk; null when absence cannot be established safely. */
async function noteLanded(t: BacklinkTarget, entryId: number): Promise<boolean | null> {
  if (!(await sameHelpdesk(t))) return null;
  const current = t.helpdesk;
  const entry = (await getJournalEntries(current.tenantId, t.ticketId)).find((e) => e.entryId === entryId);
  if (entry?.outcome === "confirmed") return true;
  try {
    const fresh = await refreshTicketHistory(current.tenantId, current.credentials, t.ticketId);
    if (!(await sameHelpdesk(t))) return null;
    const landed = fresh.conversations.some((c) => c.kind === "internal_note" && (c.bodyText ?? "").includes(t.taskUrl));
    if (!landed && !fresh.complete) return null;
    await finishJournalEntry(entryId, landed ? "confirmed" : "failed", landed ? null : "Freshdesk has no record of this note.");
    return landed;
  } catch {
    return null;
  }
}

async function writeInternalNote(t: BacklinkTarget, previous: BacklinkRecord | undefined): Promise<BacklinkRecord> {
  if (previous?.state === "unconfirmed" && previous.entryId !== undefined) {
    const landed = await noteLanded(t, previous.entryId);
    if (landed === null) return previous;
    if (landed) return { state: "done", message: null, entryId: previous.entryId };
  }
  if (!(await sameHelpdesk(t))) return { state: "failed", message: "The helpdesk connection changed. Reopen the ticket before adding its internal note." };
  const current = t.helpdesk;
  const { tenantId, credentials } = current;
  // The task itself stays out of the helpdesk's journal: the link record knows it
  const entryId = await startJournalEntry(tenantId, t.ticketId, "add_task_backlink_note", { private: true });
  if (!(await sameHelpdesk(t))) {
    const message = "The helpdesk connection changed before adding the internal note.";
    await finishJournalEntry(entryId, "failed", message);
    return { state: "failed", message, entryId };
  }
  try {
    await freshdeskPost<unknown>(credentials, `/tickets/${encodeURIComponent(t.ticketId)}/notes`, { body: noteBody(t), private: true });
  } catch (error) {
    if (!(error instanceof FreshdeskError)) throw error;
    if (error.kind === "network" || (error.status ?? 0) >= 500) {
      await finishJournalEntry(entryId, "unconfirmed", NOTE_UNCONFIRMED_MESSAGE);
      return { state: "unconfirmed", message: NOTE_UNCONFIRMED_MESSAGE, entryId };
    }
    const message = freshdeskMessage(error);
    await finishJournalEntry(entryId, "failed", message);
    return { state: "failed", message, entryId };
  }
  await finishJournalEntry(entryId, "confirmed", null);
  return { state: "done", message: null, entryId };
}

/**
 * Writes the given backlink steps, one after another, recording each on the
 * link. `known` is the task as just created, which saves reading it back.
 */
export async function writeBacklinks(
  t: BacklinkTarget,
  steps: BacklinkStep[],
  previous: Backlinks,
  known?: RemoteTask,
): Promise<void> {
  let task: RemoteTask | undefined = known;
  for (const step of steps) {
    let record: BacklinkRecord;
    try {
      if (step === "internalNote") {
        record = await writeInternalNote(t, previous.internalNote);
      } else {
        task ??= await readTask(t);
        record = step === "description" ? await writeDescription(t, task) : await writeTicketIdField(t, task);
      }
    } catch (err) {
      if (!(err instanceof ClickUpError)) throw err;
      record = { state: "failed", message: await clickupMessage(t.credentials.tenantId, err) };
    }
    await setLinkBacklink(t.key, t.taskId, step, record);
  }
}
