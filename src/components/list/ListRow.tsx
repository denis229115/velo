import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { Check, Paperclip, Star, type LucideIcon } from "lucide-react";
import { formatRelativeDate } from "@/utils/date";
import type { EmailDensity } from "@/stores/uiStore";

export interface ListRowAction {
  label: string;
  icon: LucideIcon | (() => null);
  onAction: () => void;
}

export interface ListRowProps {
  density: EmailDensity;
  unread: boolean;
  /** Name shown in the sender column; its initials fill the avatar */
  sender: string;
  subject: string;
  /** Shown before the subject, e.g. a ticket ID */
  subjectPrefix?: ReactNode;
  preview?: ReactNode;
  /** Optional details on a line of their own under the subject; the row grows to hold them */
  extraLine?: ReactNode;
  /** Unix ms */
  time: number;
  hasAttachment?: boolean;
  /** The row is the one open in the reader */
  selected?: boolean;
  /** The row is part of a multi-selection (avatar shows a check) */
  checked?: boolean;
  starred?: boolean;
  /** When set, a star toggle shows on hover (and stays visible once starred) */
  onToggleStar?: () => void;
  /** Hover quick actions, shown left of the star */
  actions?: ListRowAction[];
  /** Small icons or badges shown before the time */
  indicators?: ReactNode;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  /** Extra classes on the row button, e.g. a tint for spam */
  className?: string;
  buttonRef?: Ref<HTMLButtonElement>;
  /** Passed to the row button (aria-label, drag handles, context menu…) */
  buttonProps?: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "className">;
}

export function initialsOf(name: string): string {
  const words = name.replace(/[<>"@].*$/, "").trim().split(/\s+/).filter(Boolean);
  const first = words[0]?.[0] ?? name[0] ?? "?";
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}

function Avatar({ name, unread, checked, size }: { name: string; unread: boolean; checked?: boolean; size: "sm" | "md" }) {
  const dims = size === "sm" ? "w-6 h-6 text-micro" : "w-8 h-8 text-preview";
  const tone = checked
    ? "bg-accent text-white"
    : unread
      ? "bg-accent/15 text-accent"
      : "bg-surface-subtle text-text-secondary";
  return (
    <span aria-hidden className={`${dims} ${tone} rounded-full flex items-center justify-center shrink-0 font-semibold tracking-tight`}>
      {checked ? <Check size={size === "sm" ? 12 : 14} /> : initialsOf(name)}
    </span>
  );
}

function UnreadDot({ unread }: { unread: boolean }) {
  return (
    <span className="w-1.5 shrink-0 flex justify-center">
      {unread && <span title="Unread" className="w-1.5 h-1.5 rounded-full bg-accent" />}
    </span>
  );
}

/**
 * One row of a mail-style list. Compact density is a single line; comfortable
 * densities use two lines. Shared by the mail list and later ticket lists.
 */
export function ListRow({
  density,
  unread,
  sender,
  subject,
  subjectPrefix,
  preview,
  extraLine,
  time,
  hasAttachment,
  selected,
  checked,
  starred,
  onToggleStar,
  actions,
  indicators,
  onClick,
  className = "",
  buttonRef,
  buttonProps,
}: ListRowProps) {
  const compact = density === "compact";
  const weight = unread ? "font-[550] text-text-primary" : "text-text-secondary";
  const subjectWeight = unread ? "font-[550] text-text-primary" : "text-text-primary";
  const hasTrailing = Boolean(onToggleStar) || Boolean(actions?.length);

  const timeEl = (
    <time
      dateTime={new Date(time).toISOString()}
      className={`text-meta tabular-nums whitespace-nowrap shrink-0 text-right min-w-[3.5rem] ${unread ? "text-text-secondary" : "text-text-tertiary"}`}
    >
      {formatRelativeDate(time)}
    </time>
  );
  const attachment = hasAttachment && (
    <span title="Has attachments" className="shrink-0 text-text-tertiary">
      <Paperclip size={12} />
    </span>
  );
  // Reserves room under the absolutely positioned star so the time never sits beneath it
  const starSlot = onToggleStar && <span aria-hidden className="w-5 shrink-0" />;
  const extra = extraLine && (
    <span data-line className="flex items-center gap-x-3 min-w-0 text-preview text-text-tertiary">
      {extraLine}
    </span>
  );

  return (
    <div
      className={`group relative border-b border-border-secondary ${
        checked ? "bg-accent/10" : selected ? "bg-bg-selected" : "bg-surface-list hover:bg-bg-hover"
      }`}
    >
      <button
        ref={buttonRef}
        {...buttonProps}
        type="button"
        onClick={onClick}
        aria-selected={selected}
        className={`w-full text-left flex items-center gap-2.5 px-3 -outline-offset-2 ${
          compact ? `py-1.5 ${extra ? "" : "@2xl:py-0 @2xl:h-11"}` : density === "spacious" ? "py-3.5" : "py-2.5"
        } ${className}`}
      >
        <UnreadDot unread={unread} />
        <Avatar name={sender} unread={unread} checked={checked} size={compact ? "sm" : "md"} />

        {compact ? (
          // One line once the list is wide (@2xl); a narrow list folds the subject under the sender
          <span className="flex-1 min-w-0 flex flex-col gap-0.5">
            <span data-line className="min-w-0 flex flex-wrap @2xl:flex-nowrap items-center gap-x-3 gap-y-0.5 text-row">
              <span className={`truncate flex-1 min-w-0 @2xl:flex-none @2xl:w-44 ${weight}`}>{sender}</span>
              <span className="order-3 @2xl:order-2 basis-full @2xl:basis-auto min-w-0 flex items-baseline gap-2 flex-1 overflow-hidden">
                {subjectPrefix && <span className="shrink-0 text-meta tabular-nums text-text-tertiary">{subjectPrefix}</span>}
                <span className={`truncate shrink-0 max-w-full @lg:max-w-[70%] ${subjectWeight}`}>{subject}</span>
                {preview && <span className="hidden @lg:inline truncate text-preview text-text-tertiary min-w-0">{preview}</span>}
              </span>
              <span className="order-2 @2xl:order-3 flex items-center gap-2 shrink-0">
                {indicators}
                {attachment}
                {timeEl}
                {starSlot}
              </span>
            </span>
            {extra}
          </span>
        ) : (
          <span className="flex-1 min-w-0 flex flex-col gap-0.5">
            <span data-line className="flex items-center gap-2 text-row">
              <span className={`truncate flex-1 ${weight}`}>{sender}</span>
              {indicators}
              {attachment}
              {timeEl}
              {starSlot}
            </span>
            <span data-line className="flex items-baseline gap-2 min-w-0 text-row">
              {subjectPrefix && <span className="shrink-0 text-meta tabular-nums text-text-tertiary">{subjectPrefix}</span>}
              <span className={`truncate shrink-0 max-w-[70%] ${subjectWeight}`}>{subject}</span>
              {preview && <span className="truncate text-preview text-text-tertiary min-w-0">{preview}</span>}
            </span>
            {extra}
          </span>
        )}
      </button>

      {hasTrailing && (
        <div className={`absolute right-2 flex items-center gap-0.5 ${compact ? "top-1 h-7 @2xl:inset-y-0 @2xl:h-auto" : "top-1.5 h-7"}`}>
          {actions && actions.length > 0 && (
            <div className="hidden group-hover:flex items-center gap-0.5 rounded-md pl-2 bg-bg-hover">
              {actions.map(({ label, icon: Icon, onAction }) => (
                <button
                  key={label}
                  type="button"
                  tabIndex={-1}
                  title={label}
                  aria-label={label}
                  onClick={(e) => {
                    e.stopPropagation();
                    onAction();
                  }}
                  className="p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-state-selected transition-colors"
                >
                  <Icon size={14} />
                </button>
              ))}
            </div>
          )}
          {onToggleStar && (
            <button
              type="button"
              tabIndex={-1}
              aria-label={starred ? "Unstar" : "Star"}
              aria-pressed={starred}
              onClick={(e) => {
                e.stopPropagation();
                onToggleStar();
              }}
              className={`p-1 rounded transition-opacity ${
                starred ? "text-warning star-animate" : "text-text-tertiary hover:text-text-primary opacity-0 group-hover:opacity-100"
              }`}
            >
              <Star size={13} className={starred ? "fill-current" : ""} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
