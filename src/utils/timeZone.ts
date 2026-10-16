/**
 * Time display: instants are stored in UTC and shown in the display zone (the
 * Mac's zone unless the operator overrides it). Date-only values are calendar
 * dates and never shift by zone.
 */

export const DEFAULT_EXTRA_TIME_ZONES = ["Europe/Berlin"];

export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function isValidTimeZone(zone: string): boolean {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** IANA zones the runtime knows, for the settings pickers. */
export function supportedTimeZones(): string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
  return intl.supportedValuesOf?.("timeZone") ?? [systemTimeZone(), ...DEFAULT_EXTRA_TIME_ZONES, "UTC"];
}

/** Exact time with its zone abbreviation, e.g. "Wed, Oct 14, 2026, 6:00 PM GMT+9". */
export function formatExact(at: number, timeZone: string): string {
  return new Date(at).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
    timeZoneName: "short",
  });
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "just now", "5 min ago", "3 h ago", "2 d ago"; beyond a week the date in the display zone. */
export function formatRelative(at: number, now: number, timeZone: string): string {
  const diff = now - at;
  const abs = Math.abs(diff);
  const ago = (n: number, unit: string) => (diff >= 0 ? `${n} ${unit} ago` : `in ${n} ${unit}`);
  if (abs < MIN) return "just now";
  if (abs < HOUR) return ago(Math.floor(abs / MIN), "min");
  if (abs < DAY) return ago(Math.floor(abs / HOUR), "h");
  if (abs < 7 * DAY) return ago(Math.floor(abs / DAY), "d");
  const sameYear =
    new Date(at).toLocaleDateString("en", { year: "numeric", timeZone }) ===
    new Date(now).toLocaleDateString("en", { year: "numeric", timeZone });
  return new Date(at).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone,
  });
}

/** A "YYYY-MM-DD" calendar date, formatted without any zone shift. Null when not a date. */
export function formatDateOnly(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}
