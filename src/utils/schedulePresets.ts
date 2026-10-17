import { formatWhen } from "./parseWhen";

export interface SchedulePreset {
  id: string;
  label: string;
  detail: string;
  /** Unix seconds */
  timestamp: number;
}

function atLocal(base: Date, dayOffset: number, hour: number, minute = 0): Date {
  const next = new Date(base);
  next.setDate(next.getDate() + dayOffset);
  next.setHours(hour, minute, 0, 0);
  return next;
}

function nextMondayAt(now: Date, hour: number): Date {
  const day = now.getDay();
  let delta = (1 - day + 7) % 7;
  if (delta === 0 && now.getHours() >= hour) delta = 7;
  return atLocal(now, delta, hour);
}

/** Later today, tomorrow morning, and Monday morning. Times are local. */
export function buildSchedulePresets(now: Date): SchedulePreset[] {
  const later = new Date(now);
  if (now.getHours() < 16) {
    later.setHours(17, 0, 0, 0);
  } else {
    later.setTime(now.getTime() + 3 * 60 * 60 * 1000);
  }
  const tomorrow = atLocal(now, 1, 8);
  const monday = nextMondayAt(now, 8);
  return [
    { id: "later", label: "Later today", detail: formatWhen(later), timestamp: Math.floor(later.getTime() / 1000) },
    { id: "tomorrow", label: "Tomorrow 8am", detail: formatWhen(tomorrow), timestamp: Math.floor(tomorrow.getTime() / 1000) },
    { id: "monday", label: "Monday 8am", detail: formatWhen(monday), timestamp: Math.floor(monday.getTime() / 1000) },
  ];
}

/**
 * The next 8:00 in a zone described by a Date-header offset (minutes east of UTC).
 * The returned Date is an absolute instant.
 */
export function recipientMorning(now: Date, offsetMinutes: number): Date {
  const shifted = new Date(now.getTime() + offsetMinutes * 60_000);
  const target = new Date(shifted);
  target.setUTCHours(8, 0, 0, 0);
  if (target.getTime() <= shifted.getTime()) target.setUTCDate(target.getUTCDate() + 1);
  return new Date(target.getTime() - offsetMinutes * 60_000);
}

export function presetFromDate(date: Date, label: string, id: string): SchedulePreset {
  return { id, label, detail: formatWhen(date), timestamp: Math.floor(date.getTime() / 1000) };
}
