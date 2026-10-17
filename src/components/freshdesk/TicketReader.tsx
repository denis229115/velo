import { useShortcutAction } from "@/hooks/useShortcutAction";
import { useEffect, useRef, useState } from "react";
import { Lock, Paperclip } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
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
import { TicketInspector } from "./TicketInspector";
import { FreshdeskWriteReason } from "./useFreshdeskWritable";
import { TicketComposer } from "./TicketComposer";
import { TicketSummaryCard, TICKET_ENTRY_REVEAL_EVENT, ticketEntryAnchor } from "./TicketSummaryCard";
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

function authorInitial(author: string): string {
  const letter = author.trim().charAt(0).toUpperCase();
  return letter || "?";
}

/** One line of the conversation, shown while its row is collapsed. */
function entrySnippet(entry: HistoryEntry): string {
  const text = (entry.bodyText ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= 160) return text;
  return `${text.slice(0, 160).trimEnd()}…`;
}

/** One message of the history; `n` is its number, which summary references cite */
function Entry({ entry, n, expanded, onToggle }: { entry: HistoryEntry; n: number; expanded: boolean; onToggle: () => void }) {
  const internal = entry.visibility === "internal";
  const accent = internal ? "bg-status-warning" : entry.kind === "reply" ? "bg-accent/40" : null;
  const snippet = entrySnippet(entry);
  return (
    <li id={ticketEntryAnchor(entry.id)} className="scroll-mt-4 border-b border-border-secondary last:border-b-0">
      <article
        aria-label={`${entry.kind === "request" ? "Original request" : "Conversation"} by ${entry.author}`}
        className="relative"
      >
        {accent && <span aria-hidden className={`absolute inset-y-0 left-0 w-0.5 ${accent}`} />}
        <div className="flex items-start">
          <button
            type="button"
            aria-expanded={expanded}
            onClick={onToggle}
            className="flex-1 min-w-0 text-left px-4 py-3 hover:bg-bg-hover transition-colors"
          >
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-7 h-7 rounded-full bg-accent/20 text-accent flex items-center justify-center shrink-0 text-micro font-medium">
                {authorInitial(entry.author)}
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-row font-medium text-text-primary truncate">{entry.author}</span>
                  <EntryKindBadge kind={entry.kind} />
                  {internal && (
                    <span className="inline-flex items-center gap-1 text-micro text-text-tertiary shrink-0">
                      <Lock size={10} aria-hidden />
                      Agents only
                    </span>
                  )}
                </div>
                {!expanded && snippet && <span className="text-meta text-text-tertiary truncate block">{snippet}</span>}
              </div>
            </div>
          </button>
          <span className="shrink-0 px-4 py-3 text-meta text-text-tertiary">
            <span className="font-mono text-micro mr-2" title={`Message ${n}`}>#{n}</span>
            <Timestamp at={entry.at} />
          </span>
        </div>
        {expanded && (
          <div className="px-4 pb-4">
            {entry.bodyHtml ? (
              <EmailRenderer html={entry.bodyHtml} text={entry.bodyText} blockImages />
            ) : (
              <p className="text-row text-text-primary whitespace-pre-wrap">{entry.bodyText ?? ""}</p>
            )}
            <Attachments attachments={entry.attachments} />
          </div>
        )}
      </article>
    </li>
  );
}

/** Long histories show the request and the latest conversations; earlier ones load on request. */
const RECENT_ENTRIES = 20;

function History({ entries }: { entries: HistoryEntry[] }) {
  const [showEarlier, setShowEarlier] = useState(false);
  const [open, setOpen] = useState<Set<string>>(() => {
    const last = entries[entries.length - 1];
    return new Set(last ? [last.id] : []);
  });
  const pendingScroll = useRef<string | null>(null);
  const lastId = entries[entries.length - 1]?.id;
  const seenLastId = useRef(lastId);
  const [request, ...conversations] = entries;
  const hidden = showEarlier ? 0 : Math.max(0, conversations.length - RECENT_ENTRIES);

  // A new latest conversation opens itself. Reloading the same history does not reopen one the operator collapsed.
  useEffect(() => {
    if (!lastId || seenLastId.current === lastId) return;
    seenLastId.current = lastId;
    setOpen((prev) => (prev.has(lastId) ? prev : new Set(prev).add(lastId)));
  }, [lastId]);

  useEffect(() => {
    const onReveal = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      if (typeof id !== "string" || !entries.some((entry) => entry.id === id)) return;
      if (!document.getElementById(ticketEntryAnchor(id))) {
        pendingScroll.current = id;
        setShowEarlier(true);
      }
      setOpen((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
    };
    document.addEventListener(TICKET_ENTRY_REVEAL_EVENT, onReveal);
    return () => document.removeEventListener(TICKET_ENTRY_REVEAL_EVENT, onReveal);
  }, [entries]);

  useEffect(() => {
    const id = pendingScroll.current;
    if (!id) return;
    const el = document.getElementById(ticketEntryAnchor(id));
    if (!el) return;
    el.scrollIntoView?.({ behavior: "smooth", block: "start" });
    pendingScroll.current = null;
  }, [showEarlier, open]);

  const toggle = (id: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <ol aria-label="Conversation history" className="max-w-4xl border-t border-border-secondary">
      {request && <Entry entry={request} n={1} expanded={open.has(request.id)} onToggle={() => toggle(request.id)} />}
      {hidden > 0 && (
        <li className="border-b border-border-secondary">
          <button
            type="button"
            onClick={() => setShowEarlier(true)}
            className="w-full px-4 py-2 text-meta text-text-secondary hover:bg-bg-hover"
          >
            Show {hidden} earlier {hidden === 1 ? "conversation" : "conversations"}
          </button>
        </li>
      )}
      {conversations.slice(hidden).map((entry, i) => (
        <Entry key={entry.id} entry={entry} n={hidden + i + 2} expanded={open.has(entry.id)} onToggle={() => toggle(entry.id)} />
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

/** The ticket open on the right of the list. Status, priority and assignee are edited in its header; Reply and Internal note open the composer over the conversation. */
export function TicketReader({ ticket, ticketId }: { ticket: TicketListItem | null; ticketId: string | null }) {
  const view = useTicketHistory(ticket ? ticketId : null);
  const a = ticket?.activity;
  const editor = useTicketEditor();
  const edit = useTicketEditControls(ticket, editor);
  const editError = editor.error && editor.error.ticketId === ticket?.id ? editor.error : null;
  const [composing, setComposing] = useState<{ ticketId: string; mode: ComposerMode; aiDraftRequest?: number } | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "i") return;
      const target = event.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) return;
      }
      event.preventDefault();
      setInspectorOpen((open) => !open);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const composerMode = composing && composing.ticketId === ticket?.id ? composing.mode : null;
  const compose = (mode: ComposerMode) => ticket && setComposing({ ticketId: ticket.id, mode });
  useShortcutAction("action.reply", ({ ticketId }) => {
    if (ticketId === ticket?.id) compose("reply");
  });
  useShortcutAction("ticket.note", ({ ticketId }) => {
    if (ticketId === ticket?.id) compose("note");
  });
  useShortcutAction("ticket.aiDraft", ({ ticketId }) => {
    if (!ticketId || ticketId !== ticket?.id) return;
    setComposing((previous) => ({ ticketId, mode: "reply", aiDraftRequest: (previous?.aiDraftRequest ?? 0) + 1 }));
  });
  useShortcutAction("ticket.status", ({ ticketId }) => {
    if (ticketId === ticket?.id) edit.focus("Status");
  });
  useShortcutAction("ticket.priority", ({ ticketId }) => {
    if (ticketId === ticket?.id) edit.focus("Priority");
  });
  useShortcutAction("ticket.assignee", ({ ticketId }) => {
    if (ticketId === ticket?.id) edit.focus("Assignee");
  });
  return (
    <section data-clickup-reader aria-label="Ticket reader" className="flex-1 min-w-0 flex flex-col bg-surface-reader">
      {!ticket || !a ? (
        <EmptyState
          illustration={ReadingPaneIllustration}
          title="Freshdesk"
          subtitle={ticketId ? `Ticket #${ticketId} is not in the local copy` : "Select a ticket to read"}
        />
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex-1 min-h-0 overflow-y-auto px-8 py-6">
              <TicketHeader
                ticket={ticket}
                channel={view?.channel ?? null}
                edit={edit}
                compact={inspectorOpen}
                onToggleInspector={() => setInspectorOpen((open) => !open)}
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
              <TicketSummaryCard key={ticket.id} ticket={ticket} view={view} />
              <HistoryNotice view={view} />
              {view && view.entries.length > 0 && <History key={view.ticketId} entries={view.entries} />}
            </div>
            {composerMode && (
              <TicketComposer ticket={ticket} history={view} aiDraftRequest={composing?.aiDraftRequest ?? 0} mode={composerMode} onModeChange={compose} onClose={() => setComposing(null)} />
            )}
          </div>
          {inspectorOpen && (
            <ErrorBoundary name="Inspector">
              <TicketInspector ticket={ticket} onEdit={editor.run} />
            </ErrorBoundary>
          )}
        </div>
      )}
    </section>
  );
}
