import { useMemo, useState, type ReactNode } from "react";
import { formatWhen, parseWhen } from "@/utils/parseWhen";
import { isNightForRecipient, localZoneName } from "@/utils/recipientTime";
import { MiniCalendar } from "./MiniCalendar";

export interface ScheduleChoice {
  label: string;
  /** Unix seconds */
  timestamp: number;
  detail?: string;
}

interface QuickSchedulePickerProps {
  presets: ScheduleChoice[];
  onSelect: (timestamp: number) => void;
  submitLabel: string;
  note?: string;
  /** Minutes east of UTC for the recipient, when known. */
  recipientOffsetMinutes?: number | null;
  children?: ReactNode;
}

/** Natural language, presets, and a calendar. Enter on a parsed phrase selects it. */
export function QuickSchedulePicker({
  presets,
  onSelect,
  submitLabel,
  note,
  recipientOffsetMinutes = null,
  children,
}: QuickSchedulePickerProps) {
  const [phrase, setPhrase] = useState("");
  const [picking, setPicking] = useState(false);
  const [customDate, setCustomDate] = useState("");
  const [customTime, setCustomTime] = useState("08:00");
  const parsed = useMemo(() => parseWhen(phrase), [phrase]);
  const zone = localZoneName();

  const night = (seconds: number) =>
    recipientOffsetMinutes !== null && isNightForRecipient(new Date(seconds * 1000), recipientOffsetMinutes);

  const commit = (seconds: number) => onSelect(seconds);

  return (
    <div className="px-1 pb-2">
      {children}
      <form
        className="px-2 pb-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (parsed.date) commit(Math.floor(parsed.date.getTime() / 1000));
        }}
      >
        <input
          aria-label="When"
          value={phrase}
          onChange={(event) => setPhrase(event.target.value)}
          placeholder="Try tomorrow 8am, or 3"
          className="w-full rounded-[var(--radius-control-sm)] border border-separator bg-surface-subtle px-2 py-1.5 text-row text-text-primary outline-none"
        />
        <p className="mt-1 min-h-4 text-meta text-text-tertiary" role="status">
          {parsed.someday && "Someday has no time yet."}
          {parsed.date && (
            <>
              {parsed.label}
              {night(Math.floor(parsed.date.getTime() / 1000)) ? " · night for them" : ""}
            </>
          )}
          {phrase.trim() && !parsed.date && !parsed.someday && "No time in that phrase."}
        </p>
      </form>
      <ul className="py-0.5" role="listbox" aria-label="Presets">
        {presets.map((preset) => (
          <li key={preset.label}>
            <button
              type="button"
              className="w-full text-left px-3 py-1.5 rounded-[var(--radius-menu-item)] hover:bg-state-hover flex items-center justify-between gap-3"
              onClick={() => commit(preset.timestamp)}
            >
              <span className="text-row text-text-primary">{preset.label}</span>
              <span className="text-meta text-text-tertiary shrink-0">
                {preset.detail ?? formatWhen(new Date(preset.timestamp * 1000))}
                {night(preset.timestamp) ? " · night" : ""}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="px-3 pt-2 border-t border-separator">
        <button type="button" className="text-preview text-accent" onClick={() => setPicking((open) => !open)}>
          Pick date & time
        </button>
        {picking && (
          <div className="mt-2 space-y-2">
            <MiniCalendar value={customDate} onChange={setCustomDate} />
            <div className="flex items-center gap-2">
              <input
                type="time"
                aria-label="Time"
                value={customTime}
                onChange={(event) => setCustomTime(event.target.value)}
                className="rounded-[var(--radius-control-sm)] border border-separator bg-surface-subtle px-2 py-1 text-meta"
              />
              <button
                type="button"
                disabled={!customDate}
                className="px-2 py-1 text-preview text-white bg-accent rounded-[var(--radius-control-sm)] disabled:opacity-50"
                onClick={() => {
                  if (!customDate) return;
                  commit(Math.floor(new Date(`${customDate}T${customTime}`).getTime() / 1000));
                }}
              >
                {submitLabel}
              </button>
            </div>
          </div>
        )}
        <p className="mt-2 text-meta text-text-tertiary">Your time · {zone}</p>
        {note && <p className="mt-1 text-meta text-text-tertiary">{note}</p>}
      </div>
    </div>
  );
}
