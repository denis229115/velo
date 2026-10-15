/**
 * Ticket drafts: the unsent text and files for one ticket in one composer mode, kept
 * across restarts, offline and after a failed send. Sending goes through
 * here so a draft is discarded only once Freshdesk has it.
 */
import { withReadSnapshot } from "@/services/db/connection";
import { getIntegrationAccount } from "@/services/db/freshdesk";
import { deleteStoredDraft, getStoredDraft, putStoredDraft, type DraftKey } from "@/services/db/freshdeskDrafts";
import {
  deleteStoredAttachment,
  deleteStoredAttachments,
  getStoredAttachments,
  getStoredAttachmentsWithData,
  insertStoredAttachment,
  type StoredAttachment,
} from "@/services/db/freshdeskReplyAttachments";
import { attachmentLimitProblem, cleanAttachmentName, cleanContentType } from "./replyAttachments";
import { currentTenantId } from "./connection";
import {
  captureStalenessBaseline,
  reconcileTicketSend,
  sendTicketResponse,
  type ComposerMode,
  type StalenessBaseline,
  type TicketSendResult,
} from "./ticketSend";

export interface TicketDraft {
  ticketId: string;
  mode: ComposerMode;
  bodyHtml: string;
  ccEmails: string[];
  baseline: StalenessBaseline;
  /** Set while a send of this draft is Unconfirmed: the next send reconciles instead of posting */
  unconfirmedEntryId: number | null;
  /** Files going out with it, in the order attached */
  attachments: StoredAttachment[];
}

export type DraftAttachment = StoredAttachment;

/** Where a draft's files are kept */
export const draftAttachmentOwner = (k: DraftKey): string => `draft:${k.tenantId}|${k.agentId}|${k.ticketId}|${k.mode}`;

async function keyFor(ticketId: string, mode: ComposerMode): Promise<DraftKey> {
  const [tenantId, account] = await Promise.all([currentTenantId(), getIntegrationAccount("freshdesk")]);
  return { tenantId, agentId: account?.me?.agentId ?? "", ticketId, mode };
}

export async function loadTicketDraft(ticketId: string, mode: ComposerMode): Promise<TicketDraft | null> {
  return withReadSnapshot(async () => {
    const key = await keyFor(ticketId, mode);
    const stored = await getStoredDraft(key);
    if (!stored) return null;
    return {
      ticketId,
      mode,
      bodyHtml: stored.bodyHtml,
      ccEmails: stored.ccEmails,
      baseline: { startedAt: stored.startedAt, assigneeId: stored.assigneeAtStart },
      unconfirmedEntryId: stored.unconfirmedEntryId,
      attachments: await getStoredAttachments(draftAttachmentOwner(key)),
    };
  });
}

/** Saves the operator's text; works offline. The first save starts the draft's Staleness check baseline. */
export async function saveTicketDraft(
  ticketId: string,
  mode: ComposerMode,
  content: { bodyHtml: string; ccEmails?: string[] },
  baseline?: StalenessBaseline,
): Promise<void> {
  const existing = await loadTicketDraft(ticketId, mode);
  const start = baseline ?? existing?.baseline ?? (await captureStalenessBaseline(ticketId));
  await putStoredDraft(await withReadSnapshot(() => keyFor(ticketId, mode)), {
    bodyHtml: content.bodyHtml,
    ccEmails: content.ccEmails ?? existing?.ccEmails ?? [],
    startedAt: start.startedAt,
    assigneeAtStart: start.assigneeId,
    unconfirmedEntryId: existing?.unconfirmedEntryId ?? null,
    updatedAt: Math.floor(Date.now() / 1000),
  });
}

export async function discardTicketDraft(ticketId: string, mode: ComposerMode): Promise<void> {
  const key = await withReadSnapshot(() => keyFor(ticketId, mode));
  await deleteStoredAttachments(draftAttachmentOwner(key));
  await deleteStoredDraft(key);
}

/** Bytes in a base64 string, without decoding it */
const decodedSize = (b64: string): number => Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);

export type AttachResult = { ok: true; attachment: DraftAttachment } | { ok: false; message: string };

/**
 * Keeps a file with the draft (works offline). Its name and type are cleaned
 * here; a file that would take the draft over Freshdesk's limit is refused.
 */
export async function attachToTicketDraft(
  ticketId: string,
  mode: ComposerMode,
  file: { name: string; contentType: string; dataBase64: string },
): Promise<AttachResult> {
  const draft = await loadTicketDraft(ticketId, mode);
  if (!draft) await saveTicketDraft(ticketId, mode, { bodyHtml: "" });
  const name = cleanAttachmentName(file.name);
  const size = decodedSize(file.dataBase64);
  const problem = attachmentLimitProblem([...(draft?.attachments ?? []), { size }]);
  if (problem) return { ok: false, message: `${name} was not attached. ${problem.replace(/ Remove files to send\.$/, "")}` };
  const key = await withReadSnapshot(() => keyFor(ticketId, mode));
  const attachment = await insertStoredAttachment(draftAttachmentOwner(key), {
    name,
    contentType: cleanContentType(file.contentType),
    size,
    dataBase64: file.dataBase64,
  });
  return { ok: true, attachment };
}

export async function removeTicketDraftAttachment(ticketId: string, mode: ComposerMode, attachmentId: string): Promise<void> {
  await deleteStoredAttachment(draftAttachmentOwner(await withReadSnapshot(() => keyFor(ticketId, mode))), attachmentId);
}

async function setUnconfirmed(draft: TicketDraft, entryId: number | null): Promise<void> {
  await putStoredDraft(await withReadSnapshot(() => keyFor(draft.ticketId, draft.mode)), {
    bodyHtml: draft.bodyHtml,
    ccEmails: draft.ccEmails,
    startedAt: draft.baseline.startedAt,
    assigneeAtStart: draft.baseline.assigneeId,
    unconfirmedEntryId: entryId,
    updatedAt: Math.floor(Date.now() / 1000),
  });
}

export interface SendDraftOptions {
  /** Reply and set status: a status classified Done */
  thenStatusId?: string;
  /** The baseline a `stale` result returned, once the operator has seen the changes ("Send anyway") */
  acknowledged?: StalenessBaseline;
}

/**
 * Sends the stored draft. While an earlier send of it is Unconfirmed this
 * reconciles instead (A10): Velo never posts the same draft twice blindly.
 */
export async function sendTicketDraft(
  ticketId: string,
  mode: ComposerMode,
  options: SendDraftOptions = {},
): Promise<TicketSendResult> {
  const draft = await loadTicketDraft(ticketId, mode);
  if (!draft) return { outcome: "failed", message: "There is nothing to send." };

  if (draft.unconfirmedEntryId !== null) {
    const result = await reconcileTicketSend(ticketId, draft.unconfirmedEntryId);
    if (result.outcome === "sent") await discardTicketDraft(ticketId, mode);
    else if (result.outcome === "failed") await setUnconfirmed(draft, null);
    return result;
  }

  if (options.acknowledged) await saveTicketDraft(ticketId, mode, draft, options.acknowledged);
  const files = await getStoredAttachmentsWithData(draftAttachmentOwner(await withReadSnapshot(() => keyFor(ticketId, mode))));
  const result = await sendTicketResponse({
    ticketId,
    mode,
    bodyHtml: draft.bodyHtml,
    ccEmails: draft.ccEmails,
    ...(files.length > 0 && { attachments: files }),
    baseline: options.acknowledged ?? draft.baseline,
    ...(options.thenStatusId !== undefined && { thenStatusId: options.thenStatusId }),
  });
  if (result.outcome === "sent") await discardTicketDraft(ticketId, mode);
  if (result.outcome === "unconfirmed") await setUnconfirmed(draft, result.entryId);
  return result;
}
