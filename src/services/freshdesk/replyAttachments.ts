/**
 * Files on a ticket Reply or Internal note. They go to Freshdesk only, inside
 * the one multipart request that posts the reply. A file's name and type come
 * from the operator's disk and are untrusted text.
 */

/** A file attached to a reply or note, with its bytes (base64) */
export interface ReplyAttachment {
  name: string;
  contentType: string;
  size: number;
  dataBase64: string;
}

/**
 * Freshdesk API v2: "The total size of these attachments cannot exceed 20MB"
 * (Sprout and trial plans allow 15 MB). Freshdesk documents no count limit.
 */
export const MAX_ATTACHMENT_TOTAL_BYTES = 20 * 1024 * 1024;

const MAX_NAME_LENGTH = 200;
const FALLBACK_TYPE = "application/octet-stream";

/**
 * A file name safe to show and send: no path, no control or direction-changing
 * characters, a bounded length, and never empty.
 */
export function cleanAttachmentName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const visible = base.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, "").trim();
  if (visible.length <= MAX_NAME_LENGTH) return visible || "attachment";
  const dot = visible.lastIndexOf(".");
  const ext = dot > 0 && visible.length - dot <= 16 ? visible.slice(dot) : "";
  return `${visible.slice(0, MAX_NAME_LENGTH - ext.length)}${ext}`;
}

/** A MIME type as `type/subtype`, or the generic binary type when it is anything else */
export function cleanContentType(raw: string): string {
  const type = raw.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(type) ? type : FALLBACK_TYPE;
}

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Why these files can't go out with one reply, or null when they can */
export function attachmentLimitProblem(files: readonly { size: number }[]): string | null {
  const total = files.reduce((sum, f) => sum + f.size, 0);
  if (total <= MAX_ATTACHMENT_TOTAL_BYTES) return null;
  return `The attachments add up to ${formatAttachmentSize(total)}. Freshdesk accepts at most ${formatAttachmentSize(MAX_ATTACHMENT_TOTAL_BYTES)} per reply or note. Remove files to send.`;
}

function blobOf(file: ReplyAttachment): Blob {
  const binary = atob(file.dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: cleanContentType(file.contentType) });
}

/** The multipart body of a reply or note: its fields, then each file as `attachments[]` */
export function multipartBody(fields: Record<string, string | string[]>, files: readonly ReplyAttachment[]): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) for (const v of value) form.append(`${key}[]`, v);
    else form.append(key, value);
  }
  for (const file of files) form.append("attachments[]", blobOf(file), cleanAttachmentName(file.name));
  return form;
}
