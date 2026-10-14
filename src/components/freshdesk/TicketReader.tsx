import { useEffect, useState } from "react";
import { Lock, Paperclip } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { EmptyState } from "@/components/ui/EmptyState";
import { ReadingPaneIllustration } from "@/components/ui/illustrations";
import { Timestamp } from "@/components/ui/Timestamp";
import { EmailRenderer } from "@/components/email/EmailRenderer";
import { useTicketStore } from "@/stores/ticketStore";
import type { TicketListItem } from "@/services/freshdesk/ticketSync";
import { getTicketHistory, type HistoryEntry, type TicketHistoryView } from "@/services/freshdesk/ticketHistory";
import type { ConversationAttachment } from "@/services/freshdesk/activity";
import { EntryKindBadge } from "./TicketActivity";
import { TicketEditError, useTicketEditor } from "./useTicketEditor";
import { useTicketEditControls } from "./TicketEditControls";
import { TicketHeader } from "./TicketHeader";
import { FreshdeskWriteReason } from "./useFreshdeskWritable";
import { TicketComposer } from "./TicketComposer";
import type { ComposerMode } from "@/services/freshdesk/ticketSend";

function formatSize(bytes: number | null): string | null {
  if (bytes === null) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Attachments are untrusted: name and size as text only; opening one hands an https link to the browser. */
function Attachments({ attachments }: { attachments: ConversationAttachment[] }) {
  if (attachments.length === 0) return null;
  return (
    <ul aria-label="Attachments" className="flex flex-wrap gap-1.5 mt-2">
      {attachments.map((a, i) => {
        const safeUrl = a.url && /^https:\/\//i.test(a.url) ? a.url : null;
        const size = formatSize(a.size);
        return (
          <li key={`${a.name}-${i}`}>
            <button
              type="button"
              disabled={!safeUrl}
              onClick={() => safeUrl && void openUrl(safeUrl)}
              title={safeUrl ? "Open in your browser" : "This attachment has no safe link"}
              className="inline-flex items-center gap-1.5 max-w-[18rem] rounded-md border border-border-primary px-2 py-1 text-meta text-text-secondary hover:bg-bg-hover disabled:opacity-60"
            >
              <Paperclip size={12} aria-hidden className="shrink-0" />
              <span className="truncate">{a.name}</span>
              {size && <span className="text-text-tertiary shrink-0">{size}</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Entry({ entry }: { entry: HistoryEntry }) {
  const internal = entry.visibility === "internal";
  return (
    <li>
      <article
        aria-label={`${entry.kind === "request" ? "Original request" : "Conversation"} by ${entry.author}`}
        className={`rounded-lg border px-4 py-3 ${
          internal ? "border-status-warning/40 bg-status-warning/5" : "border-border-primary bg-surface-reader"
        }`}
      >
        <header className="flex items-center gap-2 mb-2 min-w-0">
          <span className="text-row font-medium text-text-primary truncate">{entry.author}</span>
          <EntryKindBadge kind={entry.kind} />
          {internal && (
            <span className="inline-flex items-center gap-1 text-micro text-text-tertiary">
              <Lock size={10} aria-hidden />
              Agents only
            </span>
          )}
          <span className="ml-auto shrink-0 text-meta text-text-tertiary">
            <Timestamp at={entry.at} />
          </span>
        </header>
        {entry.bodyHtml ? (
          <EmailRenderer html={entry.bodyHtml} text={entry.bodyText} blockImages />
        ) : (
          <p className="text-row text-text-primary whitespace-pre-wrap">{entry.bodyText ?? ""}</p>
        )}
        <Attachments attachments={entry.attachments} />
      </article>
    </li>
  );
}

/** Long histories show the request and the latest conversations; earlier ones load on request. */
const RECENT_ENTRIES = 20;

function History({ entries }: { entries: HistoryEntry[] }) {
  const [expanded, setExpanded] = useState(false);
  const [request, ...conversations] = entries;
  const hidden = expanded ? 0 : Math.max(0, conversations.length - RECENT_ENTRIES);
  return (
    <ol aria-label="Conversation history" className="flex flex-col gap-3 max-w-4xl">
      {request && <Entry entry={request} />}
      {hidden > 0 && (
        <li>
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="w-full rounded-lg border border-dashed border-border-primary px-4 py-2 text-meta text-text-secondary hover:bg-bg-hover"
          >
            Show {hidden} earlier {hidden === 1 ? "conversation" : "conversations"}
          </button>
        </li>
      )}
      {conversations.slice(hidden).map((entry) => (
        <Entry key={entry.id} entry={entry} />
      ))}
    </ol>
  );
}

function HistoryNotice({ view }: { view: TicketHistoryView | null }) {
  if (view && view.history === "complete") return null;
  const text =
    !view || view.history === "not_loaded"
      ? "Loading conversation history…"
      : "History partly loaded. Metrics show Unknown until every conversation is read.";
  return <p role="status" className="text-meta text-text-tertiary mb-3">{text}</p>;
}

function useTicketHistory(ticketId: string | null): TicketHistoryView | null {
  const version = useTicketStore((s) => s.version);
  const [view, setView] = useState<TicketHistoryView | null>(null);
  useEffect(() => {
    if (!ticketId) return;
    let cancelled = false;
    void getTicketHistory(ticketId).then((v) => {
      if (!cancelled) setView(v);
    });
    return () => {
      cancelled = true;
    };
  }, [ticketId, version]);
  return view && view.ticketId === ticketId ? view : null;
}

/** The ticket open on the right of the list. Status, priority and assignee are edited in its header; Reply and Internal note open the composer under it. */
export function TicketReader({ ticket, ticketId }: { ticket: TicketListItem | null; ticketId: string | null }) {
  const view = useTicketHistory(ticket ? ticketId : null);
  const a = ticket?.activity;
  const editor = useTicketEditor();
  const edit = useTicketEditControls(ticket, editor);
  const editError = editor.error && editor.error.ticketId === ticket?.id ? editor.error : null;
  const [composing, setComposing] = useState<{ ticketId: string; mode: ComposerMode } | null>(null);
  const composerMode = composing && composing.ticketId === ticket?.id ? composing.mode : null;
  const compose = (mode: ComposerMode) => ticket && setComposing({ ticketId: ticket.id, mode });
  return (
    <section aria-label="Ticket reader" className="flex-1 min-w-0 flex flex-col bg-surface-reader">
      {!ticket || !a ? (
        <EmptyState
          illustration={ReadingPaneIllustration}
          title="Freshdesk"
          subtitle={ticketId ? `Ticket #${ticketId} is not in the local copy` : "Select a ticket to read"}
        />
      ) : (
        <div className="overflow-y-auto px-8 py-6">
          <TicketHeader
            ticket={ticket}
            channel={view?.channel ?? null}
            edit={edit}
            onReply={() => compose("reply")}
            onInternalNote={() => compose("note")}
            notice={
              (edit.blocked || editError) && (
                <div className="space-y-1.5">
                  <FreshdeskWriteReason writable={edit.writable} />
                  {editError && <TicketEditError text={editError.text} onDismiss={editor.clearError} />}
                </div>
              )
            }
          />
          {editor.element}
          {composerMode && (
            <TicketComposer ticket={ticket} mode={composerMode} onModeChange={compose} onClose={() => setComposing(null)} />
          )}
          <HistoryNotice view={view} />
          {view && view.entries.length > 0 && <History key={view.ticketId} entries={view.entries} />}
        </div>
      )}
    </section>
  );
}
