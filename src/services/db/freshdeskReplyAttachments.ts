import { getDb } from "./connection";

/**
 * Files waiting to go out with a ticket Reply or Internal note. The owner is a
 * draft (`draft:…`) or a Scheduled reply (`scheduled:<replyId>`); the bytes stay
 * here until Freshdesk has the reply.
 */
export interface StoredAttachment {
  attachmentId: string;
  name: string;
  contentType: string;
  size: number;
}

interface AttachmentRow {
  attachment_id: string;
  name: string;
  content_type: string;
  size: number;
  data_base64?: string;
}

const toStored = (r: AttachmentRow): StoredAttachment => ({
  attachmentId: r.attachment_id,
  name: r.name,
  contentType: r.content_type,
  size: r.size,
});

export async function getStoredAttachments(owner: string): Promise<StoredAttachment[]> {
  const db = await getDb();
  const rows = await db.select<AttachmentRow[]>(
    "SELECT attachment_id, name, content_type, size FROM freshdesk_reply_attachments WHERE owner = $1 ORDER BY position",
    [owner],
  );
  return rows.map(toStored);
}

export async function getStoredAttachmentsWithData(owner: string): Promise<(StoredAttachment & { dataBase64: string })[]> {
  const db = await getDb();
  const rows = await db.select<AttachmentRow[]>(
    "SELECT attachment_id, name, content_type, size, data_base64 FROM freshdesk_reply_attachments WHERE owner = $1 ORDER BY position",
    [owner],
  );
  return rows.map((r) => ({ ...toStored(r), dataBase64: r.data_base64 ?? "" }));
}

export async function insertStoredAttachment(
  owner: string,
  file: { name: string; contentType: string; size: number; dataBase64: string },
): Promise<StoredAttachment> {
  const db = await getDb();
  const attachmentId = crypto.randomUUID();
  await db.execute(
    `INSERT INTO freshdesk_reply_attachments (attachment_id, owner, position, name, content_type, size, data_base64, created_at)
     VALUES ($1, $2, (SELECT COALESCE(MAX(position), 0) + 1 FROM freshdesk_reply_attachments WHERE owner = $2), $3, $4, $5, $6, $7)`,
    [attachmentId, owner, file.name, file.contentType, file.size, file.dataBase64, Math.floor(Date.now() / 1000)],
  );
  return { attachmentId, name: file.name, contentType: file.contentType, size: file.size };
}

export async function deleteStoredAttachment(owner: string, attachmentId: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM freshdesk_reply_attachments WHERE owner = $1 AND attachment_id = $2", [owner, attachmentId]);
}

export async function deleteStoredAttachments(owner: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM freshdesk_reply_attachments WHERE owner = $1", [owner]);
}

/** Hands every file of one owner to another (a draft becoming a Scheduled reply and back) */
export async function moveStoredAttachments(from: string, to: string): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE freshdesk_reply_attachments SET owner = $2 WHERE owner = $1", [from, to]);
}
