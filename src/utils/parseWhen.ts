import { parseDate } from "chrono-node";

export interface ParsedWhen {
  /** A concrete instant, when the phrase has one. */
  date: Date | null;
  /** How the phrase was understood, for the live preview. */
  label: string | null;
  /** "someday" is a choice with no instant. */
  someday: boolean;
}

const SOMEDAY = /^(someday|some day|eventually)$/i;

/**
 * Turns a short phrase into a time. Slang is normalised first (tmr, a bare
 * hour, this weekend, someday), then chrono-node parses what's left.
 * `now` is the reference instant; tests pin it.
 */
export function parseWhen(input: string, now: Date = new Date()): ParsedWhen {
  const raw = input.trim();
  if (!raw) return { date: null, label: null, someday: false };
  if (SOMEDAY.test(raw)) return { date: null, label: "Someday", someday: true };

  const normalised = normaliseWhen(raw);
  const date = parseDate(normalised, now, { forwardDate: true });
  if (!date) return { date: null, label: null, someday: false };
  return { date, label: formatWhen(date), someday: false };
}

/** Rewrite the slang chrono does not know before parsing. */
export function normaliseWhen(input: string): string {
  let text = input.trim();
  text = text.replace(/\b(tmrw|tmr|tommorrow|tommorow)\b/gi, "tomorrow");
  text = text.replace(/\btom\b/gi, "tomorrow");
  if (/^this weekend$/i.test(text)) return "saturday 9:00 am";

  const bare = text.match(/^(\d{1,2})$/);
  if (bare?.[1]) {
    const hour = Number(bare[1]);
    if (hour >= 0 && hour <= 23) {
      if (hour === 0) return "12:00 am";
      if (hour <= 7) return `${hour}pm`;
      if (hour <= 11) return `${hour}am`;
      return `${hour}:00`;
    }
  }
  return text;
}

export function formatWhen(date: Date): string {
  return date.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
