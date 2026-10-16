import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Copy,
  Equal,
  ExternalLink,
  Lock,
  MoreHorizontal,
  Reply,
  UserRound,
  Users,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { SampleBadge } from "@/components/ui/SampleBadge";
import { Timestamp } from "@/components/ui/Timestamp";
import { LinkedWorkRow } from "@/components/clickup/LinkedWorkRow";
import { getTicketWebUrl } from "@/services/freshdesk/connection";
import type { TicketListItem } from "@/services/freshdesk/ticketSync";
import { ActivityValue, NeedsReplyValue } from "./TicketActivity";
import { TONES, priorityAppearance, statusAppearance, type BadgeAppearance } from "./TicketBadges";
import type { useTicketEditControls } from "./TicketEditControls";

type EditControls = ReturnType<typeof useTicketEditControls>;

const fieldId = (label: string) => `ticket-field-${label.toLowerCase().replace(/\W+/g, "-")}`;

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  const id = fieldId(label);
  return (
    <div className="min-w-0">
      <dt id={id} title={hint} className="text-meta leading-tight text-text-tertiary mb-0.5">
        {label}
      </dt>
      <dd aria-labelledby={id} className="text-row text-text-primary min-w-0 break-words">
        {children}
      </dd>
    </div>
  );
}

const Sep = () => <span aria-hidden className="opacity-60"> · </span>;

/** Reply and Internal note: open the ticket composer; without a handler the slot explains why, never a dead click. */
function ActionSlot({
  label,
  icon,
  primary,
  unavailable,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  primary?: boolean;
  unavailable: string;
  onClick?: () => void;
}) {
  const reasonId = useId();
  const available = onClick !== undefined;
  const tone = primary
    ? "text-white bg-accent hover:bg-accent-hover"
    : "text-text-secondary border border-border-primary hover:text-text-primary hover:bg-bg-hover";
  return (
    <button
      type="button"
      aria-label={label}
      aria-disabled={available ? undefined : true}
      aria-describedby={available ? undefined : reasonId}
      title={available ? undefined : unavailable}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 shrink-0 rounded-md px-2.5 py-1 text-preview font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${tone} ${
        available ? "" : "opacity-50 cursor-not-allowed"
      }`}
    >
      {icon}
      <span className={primary ? "" : "hidden @lg:inline"}>{label}</span>
      {!available && (
        <span id={reasonId} hidden>
          {unavailable}
        </span>
      )}
    </button>
  );
}

const NOT_IN_FRESHDESK = "Sample ticket: it is not in Freshdesk.";

/** Open in Freshdesk and Copy ticket link. */
function MoreMenu({ ticket }: { ticket: TicketListItem }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    if (ticket.isSample) return;
    void getTicketWebUrl(ticket.id).then((u) => !cancelled && setUrl(u));
    return () => {
      cancelled = true;
    };
  }, [ticket.id, ticket.isSample]);

  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      items[(at + step + items.length) % items.length]?.focus();
    }
  };
  const item = (label: string, icon: ReactNode, run: (u: string) => void) => (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      aria-disabled={url === null}
      title={url === null ? NOT_IN_FRESHDESK : undefined}
      onClick={() => {
        if (url === null) return;
        close();
        run(url);
      }}
      className={`flex w-full items-center gap-2 px-2.5 py-1 text-left text-row focus:bg-bg-hover focus:outline-none ${
        url === null ? "text-text-tertiary" : "text-text-primary hover:bg-bg-hover"
      }`}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );

  return (
    <div className="relative shrink-0">
      <button
        ref={buttonRef}
        type="button"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        title="More actions"
        onClick={() => setOpen((o) => !o)}
        className="rounded-md p-1.5 text-text-secondary hover:bg-bg-hover hover:text-text-primary focus-visible:outline-2 focus-visible:outline-accent"
      >
        <MoreHorizontal size={15} aria-hidden />
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="More actions"
          onKeyDown={onKeyDown}
          onBlur={(e) => {
            if (!menuRef.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
          }}
          className="absolute right-0 top-full z-20 mt-1 w-52 rounded-md border border-border-primary bg-surface-overlay py-1 overlay-shadow"
        >
          {item("Open in Freshdesk", <ExternalLink size={13} aria-hidden className="shrink-0" />, (u) => void openUrl(u))}
          {item("Copy ticket link", <Copy size={13} aria-hidden className="shrink-0" />, (u) => void navigator.clipboard?.writeText(u))}
        </div>
      )}
    </div>
  );
}

/** One calm line on what the ticket needs; a done ticket needs nothing, so it has none. */
function AttentionLine({ ticket }: { ticket: TicketListItem }) {
  if (!ticket.outstanding) return null;
  const a = ticket.activity;
  const base = "flex items-start gap-2 min-w-0 rounded-md border px-3 py-1.5 text-preview";
  const icon = "shrink-0 mt-px";
  if (a.needsReply === true) {
    return (
      <div role="note" aria-label="Attention" className={`${base} border-status-warning/40 bg-status-warning/10 text-status-warning`}>
        <CircleAlert size={14} aria-hidden className={icon} />
        {/* A narrow reader wraps between the parts, never inside one */}
        <p className="min-w-0">
          <span className="font-semibold whitespace-nowrap">Needs reply</span>
          <Sep />
          <span className="whitespace-nowrap">
            Customer wrote <ActivityValue time={a.lastCustomerMessage} history={a.history} never="None" />
          </span>
          <Sep />
          <span className="whitespace-nowrap">
            {a.lastAnswered.state === "never" ? (
              "Never answered"
            ) : (
              <>
                Last answered <ActivityValue time={a.lastAnswered} history={a.history} never="Never answered" />
              </>
            )}
          </span>
        </p>
      </div>
    );
  }
  const quiet = `${base} border-border-primary bg-surface-subtle text-text-secondary`;
  if (a.needsReply === null) {
    return (
      <div role="note" aria-label="Attention" className={quiet}>
        <p className="min-w-0">
          Needs reply: <NeedsReplyValue value={null} history={a.history} />
        </p>
      </div>
    );
  }
  return (
    <div role="note" aria-label="Attention" className={quiet}>
      <CircleCheck size={14} aria-hidden className={`${icon} text-status-success`} />
      <p className="min-w-0">
        {a.lastAnswered.state === "known" ? (
          <>
            Answered <ActivityValue time={a.lastAnswered} history={a.history} never="Never answered" />
          </>
        ) : (
          "No reply needed"
        )}
      </p>
    </div>
  );
}

/**
 * A state pill over the #10 edit control: the pill shows the value with its
 * icon and text, and the control itself (same validation, permissions and
 * rollback) sits invisibly on top, so a click opens it.
 */
function EditPill({ field, appearance, edit }: { field: "Status" | "Priority" | "Assignee"; appearance: BadgeAppearance; edit: EditControls }) {
  const labelId = fieldId(field);
  const { tone, icon: Icon, label, title } = appearance;
  return (
    <span
      title={title}
      className={`group relative inline-flex items-center gap-1.5 min-w-0 max-w-full rounded-full border pl-2 pr-1.5 py-0.5 text-preview font-medium transition-[filter] hover:brightness-110 focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-accent has-[select:disabled]:opacity-70 ${TONES[tone]}`}
    >
      <span id={labelId} className="sr-only">
        {field}
      </span>
      <Icon size={12} aria-hidden className="shrink-0" />
      <span className="truncate">{label}</span>
      <ChevronDown size={12} aria-hidden className="shrink-0 opacity-70 group-has-[select:disabled]:hidden" />
      <span className="absolute inset-0 [&>span]:size-full [&_select]:size-full [&_select]:cursor-pointer [&_select]:opacity-0! [&_select:disabled]:cursor-not-allowed [&_svg]:hidden">
        {edit.render(field, labelId)}
      </span>
    </span>
  );
}

function initialsOf(name: string | null, email: string | null): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length > 0) return ((words[0]?.[0] ?? "") + (words.length > 1 ? (words[words.length - 1]?.[0] ?? "") : "")).toUpperCase();
  return email?.[0]?.toUpperCase() ?? "?";
}

function Customer({ ticket, channel }: { ticket: TicketListItem; channel: string | null }) {
  return (
    <div role="group" aria-label="Customer" className="flex items-center gap-2.5 min-w-0">
      <span
        aria-hidden
        className="grid place-items-center size-8 shrink-0 rounded-full bg-accent-light text-accent text-meta font-semibold"
      >
        {initialsOf(ticket.customer, ticket.customerEmail)}
      </span>
      <div className="min-w-0">
        <p className="text-row font-medium text-text-primary truncate">{ticket.customer ?? "Customer not loaded yet"}</p>
        <p className="text-meta text-text-tertiary break-words">
          {ticket.customerEmail && (
            <>
              <span className="text-text-secondary">{ticket.customerEmail}</span>
              <Sep />
            </>
          )}
          {channel && (
            <>
              <span className="whitespace-nowrap">{channel}</span>
              <Sep />
            </>
          )}
          <span className="whitespace-nowrap">
            Created <Timestamp at={ticket.createdAt} />
          </span>
        </p>
      </div>
    </div>
  );
}

function Details({ ticket }: { ticket: TicketListItem }) {
  const [open, setOpen] = useState(false);
  const regionId = useId();
  const a = ticket.activity;
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 rounded-md px-1 -mx-1 py-0.5 text-meta text-text-tertiary hover:text-text-primary hover:bg-bg-hover focus-visible:outline-2 focus-visible:outline-accent"
      >
        {open ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
        Details
      </button>
      {open && (
        <dl id={regionId} className="grid grid-cols-3 gap-x-4 mt-1.5">
          <Field label="Last internal note">
            <ActivityValue time={a.lastInternalNote} history={a.history} never="None" />
          </Field>
          <Field label="Last activity">
            <ActivityValue time={a.lastActivity} history={a.history} never="No conversations yet" />
          </Field>
        </dl>
      )}
    </div>
  );
}

/**
 * The ticket's header, grouped by what the operator decides from it: identity
 * and actions, what it needs, its state, the customer and timing, linked work.
 */
export function TicketHeader({
  ticket,
  channel,
  edit,
  notice,
  onReply,
  onInternalNote,
}: {
  ticket: TicketListItem;
  /** How the ticket reached the helpdesk, once its history is read */
  channel: string | null;
  edit: EditControls;
  /** Why the state cannot change, or why a change was refused */
  notice?: ReactNode;
  /** Open the ticket composer in that mode; without them the slots explain they are not available */
  onReply?: () => void;
  onInternalNote?: () => void;
}) {
  const a = ticket.activity;
  const priority: BadgeAppearance = ticket.priority
    ? priorityAppearance(ticket.priority)
    : { tone: "neutral", icon: Equal, label: "No priority", title: "Priority: None" };
  const assignee = ticket.assignee ?? (ticket.assigneeId ? `Agent ${ticket.assigneeId}` : "Unassigned");
  return (
    <div role="group" aria-label="Ticket header" className="@container max-w-4xl mb-6 space-y-4">
      <div>
        <div data-clickup-drawer-header className="flex flex-wrap items-center gap-x-2 gap-y-1.5 min-w-0 text-meta text-text-tertiary">
          <nav aria-label="Breadcrumb" className="hidden @md:block truncate">
            <span>Freshdesk</span> <span aria-hidden>›</span> <span>Tickets</span>
          </nav>
          <span className="shrink-0 rounded border border-border-primary px-1.5 py-px tabular-nums text-text-secondary">#{ticket.id}</span>
          {ticket.isSample && <SampleBadge />}
          {ticket.fetchedOnDemand && <span className="truncate">Fetched on demand: outside the downloaded scope</span>}
          <div className="ml-auto flex items-center gap-1.5 shrink-0">
            <ActionSlot
              label="Reply"
              primary
              icon={<Reply size={13} aria-hidden />}
              unavailable="Replying is not available in Velo yet. Use Open in Freshdesk for now."
              onClick={onReply}
            />
            <ActionSlot
              label="Internal note"
              icon={<Lock size={13} aria-hidden />}
              unavailable="Internal notes are not available in Velo yet. Use Open in Freshdesk for now."
              onClick={onInternalNote}
            />
            <MoreMenu ticket={ticket} />
          </div>
        </div>
        <h2 className="text-title font-semibold text-text-primary mt-2 break-words">{ticket.subject || "(no subject)"}</h2>
      </div>

      <AttentionLine ticket={ticket} />

      <div className="space-y-1.5">
        <div role="group" aria-label="Ticket state" className="flex flex-wrap items-center gap-1.5">
          <EditPill field="Status" appearance={statusAppearance(ticket.status)} edit={edit} />
          <EditPill field="Priority" appearance={priority} edit={edit} />
          <EditPill
            field="Assignee"
            appearance={{ tone: "neutral", icon: UserRound, label: assignee, title: `Assignee: ${assignee}` }}
            edit={edit}
          />
          {ticket.group && (
            <span
              title={`Group: ${ticket.group.name}`}
              className="inline-flex items-center gap-1 min-w-0 max-w-full rounded-full px-2 py-0.5 text-meta text-text-tertiary bg-surface-subtle"
            >
              <Users size={11} aria-hidden className="shrink-0" />
              <span className="truncate">{ticket.group.name}</span>
            </span>
          )}
        </div>
        {notice}
      </div>

      <div className="grid gap-x-8 gap-y-3 @2xl:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] items-start border-t border-border-primary pt-4">
        <Customer ticket={ticket} channel={channel} />
        <div className="min-w-0 space-y-2">
          <dl className="grid grid-cols-3 items-end gap-x-4">
            <Field label="Customer wrote" hint="Last customer message: when the customer last wrote, including the original request">
              <ActivityValue time={a.lastCustomerMessage} history={a.history} never="None" />
            </Field>
            <Field label="Last answered" hint="When an agent last sent a reply written by a human">
              <ActivityValue time={a.lastAnswered} history={a.history} never="Never answered" />
            </Field>
            <Field label="Updated" hint="Last updated: when Freshdesk last recorded any change to the ticket">
              <Timestamp at={ticket.updatedAt} />
            </Field>
          </dl>
          <Details ticket={ticket} />
        </div>
      </div>

      <LinkedWorkRow item={{ kind: "ticket", ticketId: ticket.id }} />
    </div>
  );
}
