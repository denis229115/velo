import { useRef } from "react";
import { Paperclip, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { LOWER_PLAN_ATTACHMENT_LIMIT, MAX_ATTACHMENT_TOTAL_BYTES, formatAttachmentSize } from "@/services/freshdesk/replyAttachments";
import type { DraftAttachment } from "@/services/freshdesk/ticketDrafts";

/**
 * The files of a ticket draft: attach, list, remove. Attaching works offline
 * (the files stay with the draft); only sending needs Freshdesk. File names
 * are untrusted text and are only ever rendered as text.
 */
export function TicketAttachments({
  attachments,
  error,
  locked,
  onAdd,
  onRemove,
}: {
  attachments: DraftAttachment[];
  error: string | null;
  /** While a send is Unconfirmed the files stay as sent */
  locked: boolean;
  onAdd: (files: File[]) => void;
  onRemove: (attachmentId: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const total = attachments.reduce((sum, a) => sum + a.size, 0);
  return (
    <div className="mx-3 mt-2 space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          type="file"
          multiple
          aria-label="Attach files"
          className="hidden"
          disabled={locked}
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            if (files.length > 0) onAdd(files);
          }}
        />
        <Button variant="ghost" size="xs" icon={<Paperclip size={13} aria-hidden />} disabled={locked} onClick={() => inputRef.current?.click()}>
          Attach
        </Button>
        <span className="text-micro text-text-tertiary">
          Files go to Freshdesk only, up to {formatAttachmentSize(MAX_ATTACHMENT_TOTAL_BYTES)} in total. {LOWER_PLAN_ATTACHMENT_LIMIT}
          {attachments.length > 0 && ` · ${formatAttachmentSize(total)} used`}
        </span>
      </div>
      {attachments.length > 0 && (
        <ul aria-label="Attached files" className="flex flex-wrap gap-1.5">
          {attachments.map((a) => (
            <li
              key={a.attachmentId}
              className="flex max-w-full items-center gap-1.5 rounded-md border border-border-secondary bg-bg-secondary px-2 py-1 text-meta"
            >
              <Paperclip size={12} aria-hidden className="shrink-0 text-text-tertiary" />
              <span className="min-w-0 max-w-[16rem] truncate text-text-primary" title={a.name}>
                {a.name}
              </span>
              <span className="shrink-0 text-text-tertiary">{formatAttachmentSize(a.size)}</span>
              {!locked && (
                <button
                  type="button"
                  aria-label={`Remove ${a.name}`}
                  title="Remove"
                  onClick={() => onRemove(a.attachmentId)}
                  className="shrink-0 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover"
                >
                  <X size={12} aria-hidden />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="rounded-md border border-status-error/40 bg-status-error/10 px-2.5 py-1.5 text-meta text-status-error">
          {error}
        </p>
      )}
    </div>
  );
}
