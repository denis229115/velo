import { useCallback, useEffect, useRef, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { AlertTriangle, CalendarClock, CheckCircle2, Clock, HelpCircle, Lock, Maximize2, Minimize2, Reply, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { EditorToolbar } from "@/components/composer/EditorToolbar";
import { ScheduleSendDialog } from "@/components/composer/ScheduleSendDialog";
import { useComposerShortcuts } from "@/hooks/useComposerShortcuts";
import { useComposerStore } from "@/stores/composerStore";
import { useShortcutStore } from "@/stores/shortcutStore";
import { formatShortcut } from "@/utils/shortcutLabel";
import { formatFullDate } from "@/utils/date";
import { scheduleTicketReply } from "@/services/freshdesk/scheduledReplies";
import { useTicketStore } from "@/stores/ticketStore";
import type { TicketListItem } from "@/services/freshdesk/ticketSync";
import { getHelpdeskConnection, getStatusClassification, type ClassifiableStatus } from "@/services/freshdesk/connection";
import type { HelpdeskAgent } from "@/services/freshdesk/metadata";
import { UNCONFIRMED_MESSAGE, type ComposerMode, type StalenessBaseline, type TicketSendResult } from "@/services/freshdesk/ticketSend";
import {
  attachToTicketDraft,
  discardTicketDraft,
  loadTicketDraft,
  removeTicketDraftAttachment,
  saveTicketDraft,
  sendTicketDraft,
  type DraftAttachment,
} from "@/services/freshdesk/ticketDrafts";
import { attachRefusal, attachmentLimitProblem, formatAttachmentSize } from "@/services/freshdesk/replyAttachments";
import { readFileAsBase64 } from "@/utils/fileUtils";
import { TicketAttachments } from "./TicketAttachments";
import { isEmailAddress, splitAddressText } from "@/services/freshdesk/emailAddress";
import { replyCcPrefill, sameAddresses } from "@/services/freshdesk/ticketCc";
import { FreshdeskWriteReason, useFreshdeskWritable } from "./useFreshdeskWritable";
import type { TicketHistoryView } from "@/services/freshdesk/ticketHistory";
import { TaskReplyDraft } from "@/components/clickup/TaskReplyDraft";
import { TicketAiDraft } from "./TicketAiDraft";

const MODE_NAME: Record<ComposerMode, string> = { reply: "Reply to customer", note: "Internal note" };
const SENT_TEXT: Record<ComposerMode, string> = { reply: "Reply sent.", note: "Internal note added." };
const AUTOSAVE_MS = 600;
const SCHEDULE_NOTE =
  "Your reply sends through Freshdesk when Velo is next open at or after this time — not while your Mac sleeps or Velo is closed. If the ticket changed by then, it is held for you instead.";

/** What the last send attempt came to, as the composer shows it */
type Outcome =
  | { kind: "sent"; statusProblem: string | null }
  | { kind: "scheduled"; sendAt: number }
  | { kind: "stale"; changes: string[]; baseline: StalenessBaseline }
  | { kind: "unconfirmed"; message: string }
  | { kind: "not_sent"; message: string };

function toOutcome(result: TicketSendResult): Outcome {
  switch (result.outcome) {
    case "sent": {
      const status = result.status;
      if (!status || status.outcome === "confirmed") return { kind: "sent", statusProblem: null };
      const problem =
        status.outcome === "needs_fields"
          ? "Freshdesk needs more fields filled in first. Set the status from the header."
          : status.message;
      return { kind: "sent", statusProblem: problem };
    }
    case "stale":
      return { kind: "stale", changes: result.changes, baseline: result.baseline };
    case "unconfirmed":
      return { kind: "unconfirmed", message: result.message };
    default:
      return { kind: "not_sent", message: result.message };
  }
}

const parseCc = splitAddressText;

/**
 * Reply to customer or Internal note on the open ticket. Text lives in a durable
 * draft per ticket and mode (it survives restarts and works offline); sending
 * goes through Freshdesk only, after the Staleness check, and is never queued.
 */
export function TicketComposer({
  ticket,
  history = null,
  aiDraftRequest = 0,
  mode,
  onModeChange,
  onClose,
}: {
  ticket: TicketListItem;
  /** The ticket's history, which AI drafts read; null while loading */
  history?: TicketHistoryView | null;
  aiDraftRequest?: number;
  mode: ComposerMode;
  onModeChange: (mode: ComposerMode) => void;
  onClose: () => void;
}) {
  // One pane per ticket and mode, so each loads and saves its own draft
  return <ComposerPane key={`${ticket.id}:${mode}`} ticket={ticket} history={history} aiDraftRequest={aiDraftRequest} mode={mode} onModeChange={onModeChange} onClose={onClose} />;
}

function ComposerPane({
  ticket,
  history,
  aiDraftRequest,
  mode,
  onModeChange,
  onClose,
}: {
  ticket: TicketListItem;
  history: TicketHistoryView | null;
  aiDraftRequest: number;
  mode: ComposerMode;
  onModeChange: (mode: ComposerMode) => void;
  onClose: () => void;
}) {
  const emailComposerOpen = useComposerStore((s) => s.isOpen);
  const writable = useFreshdeskWritable({ isSample: ticket.isSample });
  const [me, setMe] = useState<HelpdeskAgent | null>(null);
  const [doneStatuses, setDoneStatuses] = useState<ClassifiableStatus[]>([]);
  const [ccText, setCcText] = useState("");
  const [thenStatusId, setThenStatusId] = useState("");
  const [empty, setEmpty] = useState(true);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [showSchedule, setShowSchedule] = useState(false);
  const [fullpage, setFullpage] = useState(false);
  const sendKeys = useShortcutStore((s) => s.keyMap["app.send"]);
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [attaching, setAttaching] = useState(false);
  const attachmentsRef = useRef<DraftAttachment[]>([]);
  attachmentsRef.current = attachments;
  const sendLaterKeys = useShortcutStore((s) => s.keyMap["app.sendLater"]);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(false);
  const ccRef = useRef("");
  ccRef.current = ccText;
  // The ticket's CC as the Reply opened with it; a later sync does not rewrite what the operator sees
  const prefillRef = useRef<string[]>([]);
  if (mode === "reply" && prefillRef.current.length === 0) prefillRef.current = replyCcPrefill(ticket);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: { openOnClick: false } }),
      Placeholder.configure({ placeholder: mode === "reply" ? "Write your reply…" : "Write a note for your colleagues…" }),
    ],
    content: "",
    onUpdate: ({ editor: ed }) => {
      setEmpty(ed.isEmpty);
      scheduleSave();
    },
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": mode === "reply" ? "Reply text" : "Note text",
        class: "prose prose-sm max-w-none px-4 py-3 min-h-[140px] focus:outline-none text-text-primary",
      },
    },
  });

  const save = useCallback(async () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    if (!dirty.current || !editor) return;
    dirty.current = false;
    const ccEmails = parseCc(ccRef.current);
    // An empty draft is discarded only when its CC is unchanged and it holds no files.
    if (editor.isEmpty && sameAddresses(ccEmails, mode === "reply" ? prefillRef.current : []) && attachmentsRef.current.length === 0) await discardTicketDraft(ticket.id, mode);
    else await saveTicketDraft(ticket.id, mode, { bodyHtml: editor.getHTML(), ccEmails });
  }, [editor, ticket.id, mode]);

  const saveRef = useRef(save);
  saveRef.current = save;
  function scheduleSave() {
    dirty.current = true;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void saveRef.current(), AUTOSAVE_MS);
  }

  // The draft, the sender and the Done statuses, once per pane
  useEffect(() => {
    if (!editor) return;
    let cancelled = false;
    void (async () => {
      const [draft, connection, classification] = await Promise.all([
        loadTicketDraft(ticket.id, mode),
        getHelpdeskConnection(),
        mode === "reply" ? getStatusClassification() : null,
      ]);
      if (cancelled) return;
      setMe(connection?.me ?? null);
      setDoneStatuses(classification?.statuses.filter((s) => s.statusClass === "done") ?? []);
      if (draft) {
        editor.commands.setContent(draft.bodyHtml, { emitUpdate: false });
        setEmpty(editor.isEmpty);
        setCcText(draft.ccEmails.join(", "));
        setAttachments(draft.attachments);
        if (draft.unconfirmedEntryId !== null) setOutcome({ kind: "unconfirmed", message: UNCONFIRMED_MESSAGE });
      } else if (mode === "reply") {
        // No draft yet: the Reply starts with the ticket's CC. A draft, even one with no CC, keeps its own.
        setCcText(prefillRef.current.join(", "));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [editor, ticket.id, mode]);

  // Leaving the pane (other mode, other ticket, closed) keeps what was typed
  useEffect(() => () => void saveRef.current(), []);

  // An Unconfirmed send is settled by reading Freshdesk, so the text stays as sent until then
  const unconfirmed = outcome?.kind === "unconfirmed";
  useEffect(() => {
    if (editor && editor.isEditable === unconfirmed) editor.setEditable(!unconfirmed, false);
  }, [editor, unconfirmed]);

  const ccEmails = parseCc(ccText);
  const badCc = ccEmails.filter((e) => !isEmailAddress(e));
  const thenStatus = doneStatuses.find((s) => s.id === thenStatusId) ?? null;

  /** Clears the composer once its text has left it (sent, or moved into the schedule) */
  function clearComposer() {
    editor?.commands.setContent("", { emitUpdate: false });
    setEmpty(true);
    setCcText("");
    setThenStatusId("");
    setAttachments([]);
    setAttachError(null);
    dirty.current = false;
  }

  /** Keeps the picked files with the draft, one by one; a file over the limit is refused with the reason */
  async function addFiles(files: File[]) {
    setAttaching(true);
    setAttachError(null);
    try {
      await save();
      let kept = attachmentsRef.current;
      for (const file of files) {
        // Checked before reading, so a huge file is never loaded
        const refusal = attachRefusal(file.name, kept, file.size);
        if (refusal) {
          setAttachError(refusal);
          continue;
        }
        const dataBase64 = await readFileAsBase64(file);
        // A file can start the draft before typing; keep the visible CC prefill with it.
        if (editor) await saveTicketDraft(ticket.id, mode, { bodyHtml: editor.getHTML(), ccEmails: parseCc(ccRef.current) });
        const result = await attachToTicketDraft(ticket.id, mode, {
          name: file.name,
          contentType: file.type,
          dataBase64,
        });
        if (result.ok) {
          kept = [...kept, result.attachment];
          setAttachments(kept);
        } else {
          setAttachError(result.message);
        }
      }
    } catch {
      setAttachError("Velo could not read that file. Nothing was attached.");
    } finally {
      setAttaching(false);
    }
  }

  async function removeFile(attachmentId: string) {
    setAttachError(null);
    await removeTicketDraftAttachment(ticket.id, mode, attachmentId);
    setAttachments((current) => current.filter((a) => a.attachmentId !== attachmentId));
  }

  const tooLarge = attachmentLimitProblem(attachments);
  const canSchedule =
    mode === "reply" && writable.writable && !busy && !attaching && !empty && !unconfirmed && badCc.length === 0 && !tooLarge && outcome?.kind !== "stale";
  const canSend = writable.writable && !busy && !attaching && !empty && !unconfirmed && badCc.length === 0 && !tooLarge && outcome?.kind !== "stale";
  const composerRoot = useRef<HTMLElement>(null);
  useComposerShortcuts({
    onSend: () => { if (canSend) void send(); },
    onSendLater: mode === "reply" ? () => { if (canSchedule) setShowSchedule(true); } : undefined,
  }, !showSchedule && !emailComposerOpen, composerRoot);

  async function schedule(sendAt: number) {
    setShowSchedule(false);
    if (busy || !writable.writable) return;
    setBusy(true);
    try {
      await save();
      const result = await scheduleTicketReply(ticket.id, { sendAt, ...(thenStatusId && { thenStatusId }) });
      if (result.ok) {
        clearComposer();
        setOutcome({ kind: "scheduled", sendAt });
      } else {
        setOutcome({ kind: "not_sent", message: result.message });
      }
    } finally {
      setBusy(false);
    }
  }

  async function send(options: { acknowledged?: StalenessBaseline } = {}) {
    if (busy || !writable.writable) return;
    setBusy(true);
    try {
      await save();
      const result = await sendTicketDraft(ticket.id, mode, {
        ...(mode === "reply" && thenStatusId && { thenStatusId }),
        ...options,
      });
      const next = toOutcome(result);
      setOutcome(next);
      if (next.kind === "sent") clearComposer();
      // The send or the Staleness check re-read the ticket: show what is new in the history and Last answered
      if (next.kind === "sent" || next.kind === "stale") await useTicketStore.getState().load();
    } finally {
      setBusy(false);
    }
  }

  const sendLabel = mode === "note" ? "Add internal note" : thenStatus ? `Send and set ${thenStatus.label}` : "Send reply";
  const isNote = mode === "note";
  const showSend = !unconfirmed && outcome?.kind !== "stale";
  const sendDisabled = writable.controlProps.disabled || busy || attaching || empty || badCc.length > 0 || tooLarge !== null;
  const sendTitle = writable.controlProps.title ?? (sendKeys ? `${sendLabel} (${formatShortcut(sendKeys)})` : sendLabel);
  const laterTitle = writable.controlProps.title ?? (sendLaterKeys ? `Send later (${formatShortcut(sendLaterKeys)})` : "Send later");
  const describedBy = writable.controlProps["aria-describedby"];
  const sendClass = "px-4 py-1.5 text-xs font-medium text-white bg-accent hover:bg-accent-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
  const laterClass = "px-2 py-1.5 text-white bg-accent hover:bg-accent-hover border-l border-white/20 rounded-r-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed";

  return (
    <div className={`fixed inset-0 z-50 flex pointer-events-none ${fullpage ? "items-stretch justify-center p-4" : "items-end justify-center pb-4"}`}>
      <div className="absolute inset-0 pointer-events-auto backdrop-animate" onClick={onClose} />
      <section
        ref={composerRoot}
        aria-label={MODE_NAME[mode]}
        className={`relative bg-surface-composer border border-border-primary rounded-lg overlay-shadow pointer-events-auto flex flex-col overflow-hidden ${
          fullpage ? "w-full h-full max-w-5xl" : "w-full max-w-2xl max-h-[80vh]"
        }`}
      >
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border-primary bg-bg-secondary rounded-t-lg shrink-0">
          <span className="text-sm font-medium text-text-primary">{MODE_NAME[mode]}</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setFullpage((value) => !value)}
              className="text-text-tertiary hover:text-text-primary p-1 rounded transition-colors"
              title={fullpage ? "Collapse" : "Expand"}
              aria-label={fullpage ? "Collapse" : "Expand"}
            >
              {fullpage ? <Minimize2 size={14} aria-hidden /> : <Maximize2 size={14} aria-hidden />}
            </button>
            <Button variant="ghost" size="xs" iconOnly aria-label="Close composer" title="Close (the draft is kept)" onClick={onClose} icon={<X size={14} aria-hidden />} />
          </div>
        </div>

        <div className="flex items-center gap-2 px-3 pt-2 shrink-0">
          <div role="tablist" aria-label="Composer mode" className="flex items-center gap-1">
            {(["reply", "note"] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={m === mode}
                onClick={() => m !== mode && onModeChange(m)}
                className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-preview font-medium transition-colors ${
                  m === mode
                    ? m === "note"
                      ? "bg-status-warning/15 text-text-primary"
                      : "bg-accent/15 text-text-primary"
                    : "text-text-tertiary hover:text-text-primary hover:bg-bg-hover"
                }`}
              >
                {m === "note" ? <Lock size={12} aria-hidden /> : <Reply size={12} aria-hidden />}
                {MODE_NAME[m]}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0">
          <p
            className={`mx-3 mt-2 flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-meta ${
              isNote ? "border-status-warning/40 bg-status-warning/5 text-text-secondary" : "border-accent/30 bg-accent/5 text-text-secondary"
            }`}
          >
            {isNote ? <Lock size={12} aria-hidden className="shrink-0 text-status-warning" /> : <Reply size={12} aria-hidden className="shrink-0 text-accent" />}
            {isNote
              ? "Only agents can see this. The customer is not notified."
              : "The customer receives this by email."}
          </p>

          <Summary ticket={ticket} mode={mode} me={me} ccText={ccText} badCc={badCc} attachments={attachments} tooLarge={tooLarge} locked={unconfirmed} onCcChange={(v) => {
            setCcText(v);
            ccRef.current = v;
            scheduleSave();
          }} />

          {mode === "reply" && <><TicketAiDraft request={aiDraftRequest} ticket={ticket} view={history} editor={editor} empty={empty} /><TaskReplyDraft key={ticket.id} item={{ kind: "ticket", ticketId: ticket.id }} editor={editor} disabled={busy || unconfirmed} /></>}

          <div className="mx-3 mt-2 rounded-md border border-border-primary bg-bg-primary">
            <EditorToolbar editor={editor} allowImages={false} />
            <EditorContent editor={editor} />
          </div>

          <TicketAttachments
            attachments={attachments}
            error={attachError}
            locked={unconfirmed}
            onAdd={(files) => void addFiles(files)}
            onRemove={(id) => void removeFile(id)}
          />

          <div className="px-3 py-2">
            <OutcomeView outcome={outcome} mode={mode} busy={busy} writable={writable.writable} onSendAnyway={(baseline) => void send({ acknowledged: baseline })} onCheck={() => void send()} />
          </div>
        </div>

        <div className="px-4 py-2.5 border-t border-border-primary bg-bg-secondary rounded-b-lg shrink-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            {mode === "reply" && !unconfirmed && (
              <label className="inline-flex items-center gap-1.5 text-meta text-text-secondary">
                Then set status
                <select
                  value={thenStatusId}
                  onChange={(e) => setThenStatusId(e.target.value)}
                  {...writable.controlProps}
                  disabled={writable.controlProps.disabled || outcome?.kind === "stale"}
                  className="rounded-md border border-border-primary bg-bg-primary px-1.5 py-1 text-meta text-text-primary disabled:opacity-50"
                >
                  <option value="">Keep current status</option>
                  {doneStatuses.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {!empty && <span className="text-micro text-text-tertiary">Draft kept on this device</span>}
            {showSend && (
              <div className="ml-auto flex items-center">
                <button
                  type="button"
                  className={`${sendClass} ${mode === "reply" ? "rounded-l-md" : "rounded-md"}`}
                  disabled={sendDisabled}
                  title={sendTitle}
                  aria-describedby={describedBy}
                  onClick={() => void send()}
                >
                  {busy ? "Sending…" : sendLabel}
                </button>
                {mode === "reply" && (
                  <button
                    type="button"
                    className={laterClass}
                    aria-label="Send later"
                    title={laterTitle}
                    aria-describedby={describedBy}
                    disabled={!canSchedule}
                    onClick={() => setShowSchedule(true)}
                  >
                    <Clock size={12} aria-hidden />
                  </button>
                )}
              </div>
            )}
          </div>
          <FreshdeskWriteReason writable={writable} />
        </div>
        {showSchedule && (
          <ScheduleSendDialog title="Schedule reply" note={SCHEDULE_NOTE} onSchedule={(at) => void schedule(at)} onClose={() => setShowSchedule(false)}>
            <label className="flex items-center justify-between gap-2 text-xs text-text-secondary">
              Then set status
              <select
                value={thenStatusId}
                onChange={(e) => setThenStatusId(e.target.value)}
                className="rounded-md border border-border-primary bg-bg-primary px-1.5 py-1 text-xs text-text-primary"
              >
                <option value="">Keep current status</option>
                {doneStatuses.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <p className="mt-1.5 text-micro text-text-tertiary">Set only once Freshdesk confirms the reply was sent.</p>
          </ScheduleSendDialog>
        )}
      </section>
    </div>
  );
}

/** Who sends, who receives, CC and attachments, visible before anything goes out */
function Summary({
  ticket,
  mode,
  me,
  ccText,
  badCc,
  attachments,
  tooLarge,
  locked,
  onCcChange,
}: {
  ticket: TicketListItem;
  mode: ComposerMode;
  me: HelpdeskAgent | null;
  ccText: string;
  badCc: string[];
  attachments: DraftAttachment[];
  /** Why the files can't go out as they are, or null */
  tooLarge: string | null;
  locked: boolean;
  onCcChange: (text: string) => void;
}) {
  const row = "grid grid-cols-[5.5rem_1fr] items-baseline gap-2";
  const term = "text-meta text-text-tertiary";
  const value = "text-meta text-text-primary min-w-0 truncate";
  const customer = [ticket.customer, ticket.customerEmail && `<${ticket.customerEmail}>`].filter(Boolean).join(" ") || "Unknown customer";
  return (
    <div role="group" aria-label="Before sending" className="mx-3 mt-2">
      <dl className="space-y-1">
        <div className={row}>
          <dt className={term}>From</dt>
          <dd className={value}>{me ? [me.name, me.email && `<${me.email}>`].filter(Boolean).join(" ") : "…"}</dd>
        </div>
        {mode === "reply" ? (
          <>
            <div className={row}>
              <dt className={term}>To</dt>
              <dd className={value}>{customer}</dd>
            </div>
            <div className={row}>
              <dt className={term}>
                <label htmlFor={`cc-${ticket.id}`}>CC</label>
              </dt>
              <dd className="min-w-0">
                <input
                  id={`cc-${ticket.id}`}
                  type="text"
                  value={ccText}
                  readOnly={locked}
                  onChange={(e) => onCcChange(e.target.value)}
                  placeholder="No CC"
                  aria-invalid={badCc.length > 0 || undefined}
                  className="w-full rounded border border-border-primary bg-bg-primary px-1.5 py-0.5 text-meta text-text-primary placeholder:text-text-tertiary"
                />
                {badCc.length > 0 && <p className="text-micro text-status-error mt-0.5">Not an email address: {badCc.join(", ")}</p>}
              </dd>
            </div>
          </>
        ) : (
          <div className={row}>
            <dt className={term}>Seen by</dt>
            <dd className={value}>Agents in this helpdesk</dd>
          </div>
        )}
        <div className={row}>
          <dt className={term}>Attachments</dt>
          <dd className="min-w-0 text-meta text-text-primary">
            {attachments.length === 0 ? (
              "No attachments"
            ) : (
              <ul className="space-y-0.5">
                {attachments.map((a) => (
                  <li key={a.attachmentId} className="flex min-w-0 gap-2">
                    <span className="min-w-0 truncate">{a.name}</span>
                    <span className="shrink-0 text-text-tertiary">{formatAttachmentSize(a.size)}</span>
                  </li>
                ))}
              </ul>
            )}
            {tooLarge && <p className="text-micro text-status-error mt-0.5">{tooLarge}</p>}
          </dd>
        </div>
        {mode === "reply" && (
          <div className={row}>
            <dt className={term}>Signature</dt>
            <dd className={value}>{me?.signature ? "Your Freshdesk signature is added" : "No Freshdesk signature"}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}

function OutcomeView({
  outcome,
  mode,
  busy,
  writable,
  onSendAnyway,
  onCheck,
}: {
  outcome: Outcome | null;
  mode: ComposerMode;
  busy: boolean;
  writable: boolean;
  onSendAnyway: (baseline: StalenessBaseline) => void;
  onCheck: () => void;
}) {
  if (!outcome) return null;
  const box = "rounded-md border px-3 py-2 text-meta";
  switch (outcome.kind) {
    case "scheduled":
      return (
        <p role="status" className={`${box} border-accent/40 bg-accent/5 text-text-primary flex gap-2`}>
          <CalendarClock size={14} aria-hidden className="shrink-0 mt-0.5 text-accent" />
          <span>
            Reply scheduled for {formatFullDate(outcome.sendAt * 1000)}. It sends when Velo is next open at or after
            that time; find it under Scheduled.
          </span>
        </p>
      );
    case "sent":
      return outcome.statusProblem ? (
        <div role="alert" aria-label="Partly done" className={`${box} border-status-warning/40 bg-status-warning/5 text-text-primary flex gap-2`}>
          <AlertTriangle size={14} aria-hidden className="shrink-0 mt-0.5 text-status-warning" />
          <p>
            {SENT_TEXT[mode]} The status was not changed: {outcome.statusProblem}
          </p>
        </div>
      ) : (
        <p role="status" className={`${box} border-status-success/40 bg-status-success/5 text-text-primary flex items-center gap-2`}>
          <CheckCircle2 size={14} aria-hidden className="shrink-0 text-status-success" />
          {SENT_TEXT[mode]}
        </p>
      );
    case "stale":
      return (
        <div role="alert" aria-label="The ticket changed" className={`${box} border-status-warning/40 bg-status-warning/5 text-text-primary space-y-1.5`}>
          <p className="flex items-center gap-2 font-medium">
            <AlertTriangle size={14} aria-hidden className="shrink-0 text-status-warning" />
            The ticket changed since you started. Nothing was sent.
          </p>
          <ul className="list-disc pl-8 text-text-secondary">
            {outcome.changes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <Button variant="primary" size="xs" disabled={busy || !writable} onClick={() => onSendAnyway(outcome.baseline)}>
            {busy ? "Sending…" : "Send anyway"}
          </Button>
        </div>
      );
    case "unconfirmed":
      return (
        <div role="status" aria-label="Unconfirmed" className={`${box} border-status-warning/40 bg-status-warning/5 text-text-primary space-y-1.5`}>
          <p className="flex gap-2">
            <HelpCircle size={14} aria-hidden className="shrink-0 mt-0.5 text-status-warning" />
            <span>
              <span className="font-medium">Unconfirmed. </span>
              {outcome.message}
            </span>
          </p>
          <Button variant="secondary" size="xs" className="border border-border-primary" disabled={busy || !writable} onClick={onCheck}>
            {busy ? "Checking…" : "Check Freshdesk"}
          </Button>
        </div>
      );
    case "not_sent":
      return (
        <div role="alert" aria-label="Not sent" className={`${box} border-status-error/40 bg-status-error/5 text-text-primary flex gap-2`}>
          <AlertTriangle size={14} aria-hidden className="shrink-0 mt-0.5 text-status-error" />
          <p>
            Not sent. {outcome.message}
            {!/draft/i.test(outcome.message) && " Your draft is kept."}
          </p>
        </div>
      );
  }
}
