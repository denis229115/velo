/**
 * Sending a ticket response: a Reply to the customer or an Internal note,
 * always through Freshdesk's own API (never Gmail/SMTP). Every send is a
 * journalled remote write; it needs a connection and is never queued.
 */
import { useUIStore } from "@/stores/uiStore";
import { withReadSnapshot } from "@/services/db/connection";
import { getIntegrationAccount } from "@/services/db/freshdesk";
import { getCachedTickets } from "@/services/db/freshdeskTickets";
import { finishJournalEntry, startJournalEntry } from "@/services/db/freshdeskJournal";
import { sanitizeHtml } from "@/utils/sanitize";
import { FreshdeskError, freshdeskPost, type HelpdeskCredentials } from "./client";
import { currentCredentials, currentTenantId } from "./connection";
import { refreshTicketHistory } from "./ticketHistory";
import { OFFLINE_MESSAGE as EDIT_OFFLINE_MESSAGE, SAMPLE_MESSAGE as EDIT_SAMPLE_MESSAGE } from "./ticketEdits";

/** The two composer modes; a note can never go out as a reply */
export type ComposerMode = "reply" | "note";

/** What the operator had seen when the draft started, for the Staleness check */
export interface StalenessBaseline {
  /** Unix seconds */
  startedAt: number;
  assigneeId: string | null;
}

export interface TicketSendRequest {
  ticketId: string;
  mode: ComposerMode;
  /** Editor HTML; sanitised again here */
  bodyHtml: string;
  ccEmails?: string[];
  baseline: StalenessBaseline;
}

export type TicketSendResult =
  | { outcome: "sent" }
  | { outcome: "failed"; message: string }
  /** Not sent at all: offline or sample data. Sends are never queued. */
  | { outcome: "unavailable"; message: string };

export const OFFLINE_MESSAGE = EDIT_OFFLINE_MESSAGE.replace("Changing a ticket", "Sending");
export const SAMPLE_MESSAGE = EDIT_SAMPLE_MESSAGE;

const nowS = () => Math.floor(Date.now() / 1000);

/** The baseline for a draft that starts now, from the cached ticket */
export async function captureStalenessBaseline(ticketId: string): Promise<StalenessBaseline> {
  const ticket = await withReadSnapshot(async () =>
    (await getCachedTickets(await currentTenantId())).find((t) => t.ticketId === ticketId),
  );
  return { startedAt: nowS(), assigneeId: ticket?.responderId ?? null };
}

/** The HTML Freshdesk receives: the sanitised draft, plus my signature on a reply */
async function outgoingBody(mode: ComposerMode, bodyHtml: string): Promise<string> {
  const body = sanitizeHtml(bodyHtml);
  if (mode === "note") return body;
  const signature = (await withReadSnapshot(() => getIntegrationAccount("freshdesk")))?.me?.signature;
  return signature ? `${body}${sanitizeHtml(signature)}` : body;
}

export async function sendTicketResponse(request: TicketSendRequest): Promise<TicketSendResult> {
  if (!useUIStore.getState().isOnline) return { outcome: "unavailable", message: OFFLINE_MESSAGE };
  const current = await currentCredentials();
  if (!current) return { outcome: "unavailable", message: SAMPLE_MESSAGE };
  const { tenantId, credentials } = current;
  const { ticketId, mode } = request;

  const body = await outgoingBody(mode, request.bodyHtml);
  const cc = mode === "reply" ? (request.ccEmails ?? []) : [];
  const payload = mode === "reply" ? { body, ...(cc.length > 0 && { cc_emails: cc }) } : { body, private: true };
  const entryId = await startJournalEntry(tenantId, ticketId, mode === "reply" ? "send_reply" : "add_note", {
    sentAfter: nowS(),
  });
  try {
    await freshdeskPost<unknown>(credentials, `/tickets/${encodeURIComponent(ticketId)}/${mode === "reply" ? "reply" : "notes"}`, payload);
    await finishJournalEntry(entryId, "confirmed", null);
    await refreshAfterSend(tenantId, credentials, ticketId);
    return { outcome: "sent" };
  } catch (error) {
    if (!(error instanceof FreshdeskError)) throw error;
    await finishJournalEntry(entryId, "failed", error.message);
    return { outcome: "failed", message: error.message };
  }
}

/** Reads the ticket back so the reader and Last answered show the send; a failed read leaves it to the next sync */
async function refreshAfterSend(tenantId: string, credentials: HelpdeskCredentials, ticketId: string): Promise<void> {
  try {
    await refreshTicketHistory(tenantId, credentials, ticketId);
  } catch {
    // Sent all the same; the next hydration run reads the ticket again
  }
}

export async function reconcileTicketSend(_entryId: number): Promise<TicketSendResult> {
  return { outcome: "failed", message: "not implemented" };
}
