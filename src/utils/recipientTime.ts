const offsets = new Map<string, number>();

/** Minutes east of UTC from a Date header, or null when the header has no zone. */
export function offsetFromDateHeader(header: string): number | null {
  const trimmed = header.trim();
  if (/\bZ$/i.test(trimmed) || /\bGMT$/i.test(trimmed)) return 0;
  const match = trimmed.match(/([+-])(\d{2}):?(\d{2})\s*$/);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

export function rememberRecipientOffset(email: string, offsetMinutes: number): void {
  const key = email.trim().toLowerCase();
  if (key) offsets.set(key, offsetMinutes);
}

/** The cached offset for an address, refreshed when a Date header is supplied. */
export function recipientOffset(email: string, dateHeader?: string | null): number | null {
  if (dateHeader) {
    const parsed = offsetFromDateHeader(dateHeader);
    if (parsed !== null) {
      rememberRecipientOffset(email, parsed);
      return parsed;
    }
  }
  return offsets.get(email.trim().toLowerCase()) ?? null;
}

export function hourInOffset(date: Date, offsetMinutes: number): number {
  return new Date(date.getTime() + offsetMinutes * 60_000).getUTCHours();
}

/** Quiet hours for the recipient: 22:00–07:00 in their offset. */
export function isNightForRecipient(date: Date, offsetMinutes: number): boolean {
  const hour = hourInOffset(date, offsetMinutes);
  return hour >= 22 || hour < 7;
}

export function localZoneName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Local time";
  } catch {
    return "Local time";
  }
}

/** Test hook. */
export function clearRecipientOffsets(): void {
  offsets.clear();
}
