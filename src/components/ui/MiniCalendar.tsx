import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

interface MiniCalendarProps {
  value: string;
  onChange: (isoDate: string) => void;
}

function iso(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** A month grid. Arrow keys move the highlighted day; Enter chooses it. */
export function MiniCalendar({ value, onChange }: MiniCalendarProps) {
  const selected = value ? new Date(`${value}T12:00:00`) : new Date();
  const [cursor, setCursor] = useState(() => new Date(selected.getFullYear(), selected.getMonth(), 1));

  const cells = useMemo(() => {
    const year = cursor.getFullYear();
    const month = cursor.getMonth();
    const first = new Date(year, month, 1).getDay();
    const count = new Date(year, month + 1, 0).getDate();
    const days: Array<Date | null> = [];
    for (let i = 0; i < first; i++) days.push(null);
    for (let day = 1; day <= count; day++) days.push(new Date(year, month, day));
    return days;
  }, [cursor]);

  const shiftMonth = (delta: number) => {
    setCursor((current) => new Date(current.getFullYear(), current.getMonth() + delta, 1));
  };

  return (
    <div
      role="grid"
      aria-label={cursor.toLocaleString(undefined, { month: "long", year: "numeric" })}
      onKeyDown={(event) => {
        const current = value ? new Date(`${value}T12:00:00`) : new Date();
        const move = (days: number) => {
          const next = new Date(current);
          next.setDate(next.getDate() + days);
          setCursor(new Date(next.getFullYear(), next.getMonth(), 1));
          onChange(iso(next));
        };
        if (event.key === "ArrowLeft") { event.preventDefault(); move(-1); }
        else if (event.key === "ArrowRight") { event.preventDefault(); move(1); }
        else if (event.key === "ArrowUp") { event.preventDefault(); move(-7); }
        else if (event.key === "ArrowDown") { event.preventDefault(); move(7); }
      }}
    >
      <div className="flex items-center justify-between mb-1">
        <button type="button" aria-label="Previous month" className="p-1 text-text-tertiary hover:text-text-primary" onClick={() => shiftMonth(-1)}>
          <ChevronLeft size={14} />
        </button>
        <span className="text-meta text-text-secondary">
          {cursor.toLocaleString(undefined, { month: "long", year: "numeric" })}
        </span>
        <button type="button" aria-label="Next month" className="p-1 text-text-tertiary hover:text-text-primary" onClick={() => shiftMonth(1)}>
          <ChevronRight size={14} />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-0.5 text-center text-meta text-text-tertiary">
        {WEEKDAYS.map((day) => (
          <span key={day}>{day}</span>
        ))}
        {cells.map((day, index) =>
          day ? (
            <button
              key={iso(day)}
              type="button"
              role="gridcell"
              aria-selected={iso(day) === value}
              className={`py-1 rounded-[var(--radius-chip)] ${iso(day) === value ? "bg-accent text-white" : "hover:bg-state-hover text-text-primary"}`}
              onClick={() => onChange(iso(day))}
            >
              {day.getDate()}
            </button>
          ) : (
            <span key={`empty-${index}`} />
          ),
        )}
      </div>
    </div>
  );
}
