import { useCallback, useEffect, useRef, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { AlertTriangle, CalendarClock, CheckCircle2, Clock, HelpCircle, Lock, Reply, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { EditorToolbar } from "@/components/composer/EditorToolbar";
import { ScheduleSendDialog } from "@/components/composer/ScheduleSendDialog";
import { useComposerShortcuts } from "@/hooks/useComposerShortcuts";
import { useShortcutStore } from "@/stores/shortcutStore";
import { formatShortcut } from "@/utils/shortcutLabel";
import { formatFullDate } from "@/utils/date";
import { scheduleTicketReply } from "@/services/freshdesk/scheduledReplies";
import { useTicketStore } from "@/stores/ticketStore";
import type { TicketListItem } from "@/services/freshdesk/ticketSync";
import { getHelpdeskConnection, getStatusClassification, type ClassifiableStatus } from "@/services/freshdesk/connection";
import type { HelpdeskAgent } from "@/services/freshdesk/metadata";
import { UNCONFIRMED_MESSAGE, type ComposerMode, type StalenessBaseline, type TicketSendResult } from "@/services/freshdesk/ticketSend";
import { isEmailAddress, splitAddressText } from "@/services/freshdesk/emailAddress";
import { replyCcPrefill, sameAddresses } from "@/services/freshdesk/ticketCc";
import { discardTicketDraft, loadTicketDraft, saveTicketDraft, sendTicketDraft } from "@/services/freshdesk/ticketDrafts";
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
  mode,
  onModeChange,
  onClose,
}: {
  ticket: TicketListItem;
  /** The ticket's history, which AI drafts read; null while loading */
  history?: TicketHistoryView | null;
  mode: ComposerMode;
  onModeChange: (mode: ComposerMode) => void;
  onClose: () => void;
}) {
  // One pane per ticket and mode, so each loads and saves its own draft
  return <ComposerPane key={`${ticket.id}:${mode}`} ticket={ticket} history={history} mode={mode} onModeChange={onModeChange} onClose={onClose} />;
}

function ComposerPane({
  ticket,
  history,
  mode,
  onModeChange,
  onClose,
}: {
  ticket: TicketListItem;
  history: TicketHistoryView | null;
  mode: ComposerMode;
  onModeChange: (mode: ComposerMode) => void;
  onClose: () => void;
}) {
  const writable = useFreshdeskWritable({ isSample: ticket.isSample });
  const [me, setMe] = useState<HelpdeskAgent | null>(null);
  const [doneStatuses, setDoneStatuses] = useState<ClassifiableStatus[]>([]);
  const [ccText, setCcText] = useState("");
  const [thenStatusId, setThenStatusId] = useState("");
  const [empty, setEmpty] = useState(true);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [showSchedule, setShowSchedule] = useState(false);
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
    // Nothing typed and CC still as the ticket has it: not a draft worth keeping
    if (editor.isEmpty && sameAddresses(ccEmails, mode === "reply" ? prefillRef.current : [])) await discardTicketDraft(ticket.id, mode);
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
    dirty.current = false;
  }

  const canSchedule = mode === "reply" && writable.writable && !busy && !empty && !unconfirmed && badCc.length === 0 && outcome?.kind !== "stale";
  useComposerShortcuts({ onSendLater: () => canSchedule && setShowSchedule(true) }, mode === "reply");

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

  return (
    <section
      aria-label={MODE_NAME[mode]}
      className={`max-w-4xl mb-6 rounded-lg border bg-surface-composer ${isNote ? "border-status-warning/50" : "border-accent/50"}`}
    >
      <div className="flex items-center gap-2 px-3 pt-2">
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
        <Button variant="ghost" size="xs" iconOnly aria-label="Close composer" title="Close (the draft is kept)" onClick={onClose} className="ml-auto" icon={<X size={14} aria-hidden />} />
      </div>

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

      <Summary ticket={ticket} mode={mode} me={me} ccText={ccText} badCc={badCc} locked={unconfirmed} onCcChange={(v) => {
        setCcText(v);
        ccRef.current = v;
        scheduleSave();
      }} />

      {mode === "reply" && <><TicketAiDraft ticket={ticket} view={history} editor={editor} empty={empty} /><TaskReplyDraft key={ticket.id} item={{ kind: "ticket", ticketId: ticket.id }} editor={editor} disabled={busy || unconfirmed} /></>}

      <div className="mx-3 mt-2 rounded-md border border-border-primary bg-bg-primary">
        <EditorToolbar editor={editor} />
        <EditorContent editor={editor} />
      </div>

      <div className="px-3 py-2.5 space-y-2">
        <OutcomeView outcome={outcome} mode={mode} busy={busy} writable={writable.writable} onSendAnyway={(baseline) => void send({ acknowledged: baseline })} onCheck={() => void send()} />
        <div className="flex flex-wrap items-center gap-2">
          {!unconfirmed && outcome?.kind !== "stale" && (
            <Button
              variant="primary"
              size="sm"
              {...writable.controlProps}
              disabled={writable.controlProps.disabled || busy || empty || badCc.length > 0}
              onClick={() => void send()}
            >
              {busy ? "Sending…" : sendLabel}
            </Button>
          )}
          {mode === "reply" && !unconfirmed && outcome?.kind !== "stale" && (
            <Button
              variant="secondary"
              size="sm"
              className="border border-border-primary"
              icon={<Clock size={13} aria-hidden />}
              {...writable.controlProps}
              title={writable.controlProps.title ?? (sendLaterKeys ? `Send later (${formatShortcut(sendLaterKeys)})` : "Send later")}
              disabled={!canSchedule}
              onClick={() => setShowSchedule(true)}
            >
              Send later
            </Button>
          )}
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
          {!empty && <span className="ml-auto text-micro text-text-tertiary">Draft kept on this device</span>}
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
  );
}

/** Who sends, who receives, CC and attachments, visible before anything goes out */
function Summary({
  ticket,
  mode,
  me,
  ccText,
  badCc,
  locked,
  onCcChange,
}: {
  ticket: TicketListItem;
  mode: ComposerMode;
  me: HelpdeskAgent | null;
  ccText: string;
  badCc: string[];
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
          <dd className={value}>No attachments</dd>
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
