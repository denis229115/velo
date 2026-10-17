import { useUIStore } from "@/stores/uiStore";
import { withReadSnapshot } from "@/services/db/connection";
import { getFieldChoices, getTicketFields } from "@/services/db/freshdesk";
import { upsertTickets, type CachedTicket } from "@/services/db/freshdeskTickets";
import { finishJournalEntry, getJournalEntries, startJournalEntry, type JournalEntry } from "@/services/db/freshdeskJournal";
import { FreshdeskError, freshdeskGet, freshdeskPut } from "./client";
import { currentCredentials, currentTenantId, refreshMetadataAfterInvalidValue } from "./connection";
import { decodeTicket } from "./tickets";

/** The fields Velo edits on a ticket. IDs are Freshdesk's. Omit a field to leave it unchanged. */
export interface TicketChanges {
  statusId?: string;
  priorityId?: string;
  /** null unassigns */
  assigneeId?: string | null;
  /** null clears the group */
  groupId?: string | null;
  /** null clears the type */
  ticketType?: string | null;
  tags?: string[];
  /** Custom fields keyed by Freshdesk's name. null clears one field. */
  customFields?: Record<string, string | number | boolean | null>;
}

/** A field Freshdesk demands before it accepts the change (for example one required for closure) */
export interface RequiredField {
  name: string;
  label: string;
  /** Freshdesk's own reason */
  message: string;
  /** The values to choose from, when the field is a dropdown */
  choices: { value: string; label: string }[] | null;
}

export type TicketEditResult =
  | { outcome: "confirmed" }
  | { outcome: "needs_fields"; fields: RequiredField[] }
  | { outcome: "rejected"; message: string }
  | { outcome: "unconfirmed"; message: string }
  /** Not sent at all: offline or sample data. Remote writes are never queued. */
  | { outcome: "unavailable"; message: string };

export const OFFLINE_MESSAGE = "Changing a ticket needs a connection to Freshdesk.";
export const SAMPLE_MESSAGE = "Sample tickets can't be changed. Connect a helpdesk to change tickets.";

function sameList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function payloadFor(changes: TicketChanges, requiredFields: Record<string, string>): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (changes.statusId !== undefined) payload.status = Number(changes.statusId);
  if (changes.priorityId !== undefined) payload.priority = Number(changes.priorityId);
  if (changes.assigneeId !== undefined) payload.responder_id = changes.assigneeId === null ? null : Number(changes.assigneeId);
  if (changes.groupId !== undefined) payload.group_id = changes.groupId === null ? null : Number(changes.groupId);
  if (changes.ticketType !== undefined) payload.type = changes.ticketType;
  if (changes.tags !== undefined) payload.tags = changes.tags;
  // Freshdesk names custom fields cf_*; they travel under custom_fields
  const custom: Record<string, string | number | boolean | null> = { ...(changes.customFields ?? {}) };
  for (const [name, value] of Object.entries(requiredFields)) {
    if (name.startsWith("cf_")) custom[name] = value;
    else payload[name] = value;
  }
  if (Object.keys(custom).length > 0) payload.custom_fields = custom;
  return payload;
}

/** True when the ticket as Freshdesk now has it carries every change */
function applied(ticket: CachedTicket, changes: TicketChanges): boolean {
  const customOk =
    changes.customFields === undefined ||
    Object.entries(changes.customFields).every(([name, value]) => (ticket.customFields?.[name] ?? null) === value);
  return (
    (changes.statusId === undefined || ticket.statusId === changes.statusId) &&
    (changes.priorityId === undefined || ticket.priorityId === changes.priorityId) &&
    (changes.assigneeId === undefined || ticket.responderId === changes.assigneeId) &&
    (changes.groupId === undefined || ticket.groupId === changes.groupId) &&
    (changes.ticketType === undefined || ticket.ticketType === changes.ticketType) &&
    (changes.tags === undefined || sameList(ticket.tags, changes.tags)) &&
    customOk
  );
}

function requiredFieldsFor(tenantId: string, error: FreshdeskError): Promise<RequiredField[]> {
  const missing = error.detail?.fieldErrors ?? [];
  return withReadSnapshot(async () => {
    const definitions = await getTicketFields(tenantId);
    return Promise.all(
      missing.map(async (e) => {
        const definition = definitions.find((d) => d.name === e.field);
        const choices = await getFieldChoices(tenantId, e.field);
        return {
          name: e.field,
          label: definition?.label ?? e.field,
          message: e.message,
          choices: choices.length > 0 ? choices.map((c) => ({ value: c.label, label: c.label })) : null,
        };
      }),
    );
  });
}

function rejectionMessage(error: FreshdeskError, ticketId: string): string {
  const reasons = (error.detail?.fieldErrors ?? []).map((e) => (e.field ? `${e.message} (${e.field})` : e.message));
  switch (error.kind) {
    case "permission":
      return error.detail?.message ? `${error.message.replace(/\.$/, "")}: ${error.detail.message}` : error.message;
    case "invalid_value":
    case "validation":
      return reasons.length > 0 ? `Freshdesk did not accept the change: ${reasons.join("; ")}` : error.message;
    case "rate_limited":
      return error.retryAfterSeconds
        ? `Freshdesk is rate limiting requests. Try again in ${error.retryAfterSeconds} seconds.`
        : "Freshdesk is rate limiting requests. Try again shortly.";
    case "not_found":
      return `Freshdesk could not find ticket #${ticketId}.`;
    default:
      return error.message;
  }
}

/** A change that belonged to a send whose helpdesk has since been replaced. */
const CONNECTION_CHANGED_MESSAGE = "The helpdesk connection changed.";

function sameHelpdesk(
  current: { tenantId: string; generation: string },
  helpdesk: { tenantId: string; generation: string },
): boolean {
  return current.tenantId === helpdesk.tenantId && current.generation === helpdesk.generation;
}

/**
 * Changes a ticket in Freshdesk (a remote write,
 * journalled), then updates the local copy with what Freshdesk returns. Nothing
 * is written locally unless Freshdesk confirms, so a rejection needs no undo here.
 * `requiredFields` carries values the operator gave after a `needs_fields` result.
 * `helpdesk`, when set, is the connection a send just confirmed on: a reconnect,
 * including to the same host, skips the write. An operator edit omits it and uses
 * the helpdesk connected now.
 */
export async function updateTicket(
  ticketId: string,
  changes: TicketChanges,
  requiredFields: Record<string, string> = {},
  helpdesk?: { tenantId: string; generation: string },
): Promise<TicketEditResult> {
  if (!useUIStore.getState().isOnline) return { outcome: "unavailable", message: OFFLINE_MESSAGE };
  const current = await currentCredentials();
  if (!current) return { outcome: "unavailable", message: SAMPLE_MESSAGE };
  if (helpdesk && !sameHelpdesk(current, helpdesk)) return { outcome: "unavailable", message: CONNECTION_CHANGED_MESSAGE };
  const { tenantId, credentials } = current;

  const payload = payloadFor(changes, requiredFields);
  const entryId = await startJournalEntry(tenantId, ticketId, "update_ticket", payload);
  if (helpdesk) {
    const pinned = await currentCredentials();
    if (!pinned || !sameHelpdesk(pinned, helpdesk)) {
      await finishJournalEntry(entryId, "failed", CONNECTION_CHANGED_MESSAGE);
      return { outcome: "unavailable", message: CONNECTION_CHANGED_MESSAGE };
    }
  }
  const path = `/tickets/${encodeURIComponent(ticketId)}`;
  try {
    const raw = await freshdeskPut<unknown>(credentials, path, payload);
    await upsertTickets(tenantId, [decodeTicket(raw)]);
    await finishJournalEntry(entryId, "confirmed", null);
    return { outcome: "confirmed" };
  } catch (error) {
    if (!(error instanceof FreshdeskError)) throw error;
    if (error.kind === "network" || (error.status ?? 0) >= 500) {
      await finishJournalEntry(entryId, "unconfirmed", "Freshdesk did not confirm the change. Velo is reading the ticket back.");
      return reconcile(tenantId, entryId, credentials, path, changes);
    }

    const missing = error.detail?.fieldErrors ?? [];
    if (error.kind === "validation" && missing.length > 0 && missing.every((e) => e.code === "missing_field")) {
      await finishJournalEntry(entryId, "failed", "Freshdesk requires more fields");
      return { outcome: "needs_fields", fields: await requiredFieldsFor(tenantId, error) };
    }
    const message = rejectionMessage(error, ticketId);
    await finishJournalEntry(entryId, "failed", message);
    // A stale status, priority or agent ID means the metadata changed in Freshdesk
    void refreshMetadataAfterInvalidValue(error).catch(() => {});
    return { outcome: "rejected", message };
  }
}

/** The answer never arrived: read the ticket back instead of sending again (A10). */
async function reconcile(
  tenantId: string,
  entryId: number,
  credentials: Parameters<typeof freshdeskGet>[0],
  path: string,
  changes: TicketChanges,
): Promise<TicketEditResult> {
  let ticket: CachedTicket;
  try {
    ticket = decodeTicket(await freshdeskGet<unknown>(credentials, `${path}?include=requester`));
  } catch {
    const message = "Velo could not confirm whether Freshdesk applied the change. The next sync will show the ticket as it is.";
    await finishJournalEntry(entryId, "unconfirmed", message);
    return { outcome: "unconfirmed", message };
  }
  await upsertTickets(tenantId, [ticket]);
  if (applied(ticket, changes)) {
    await finishJournalEntry(entryId, "confirmed", null);
    return { outcome: "confirmed" };
  }
  const message = "The connection dropped and Freshdesk did not apply the change.";
  await finishJournalEntry(entryId, "failed", message);
  return { outcome: "rejected", message };
}

/** The connected helpdesk's journal entries for a ticket, oldest first. */
export async function getOperationJournal(ticketId: string): Promise<JournalEntry[]> {
  return withReadSnapshot(async () => getJournalEntries(await currentTenantId(), ticketId));
}
