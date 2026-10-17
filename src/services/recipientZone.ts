import { getDb } from "@/services/db/connection";
import { getContactByEmail, setContactTimezone } from "@/services/db/contacts";
import { offsetFromDateHeader, rememberRecipientOffset, recipientOffset } from "@/utils/recipientTime";

export interface RecipientZone {
  name: string;
  offsetMinutes: number | null;
}

function nameFor(email: string, displayName: string | null | undefined): string {
  const named = displayName?.trim();
  if (named) return named;
  const local = email.split("@")[0]?.trim();
  return local || "Recipient";
}

/**
 * The recipient's zone from the offset on their last inbound Date header.
 * A contact row keeps the offset so the next schedule can use it before a resync.
 */
export async function loadRecipientZone(accountId: string | null, email: string): Promise<RecipientZone> {
  const contact = await getContactByEmail(email).catch(() => null);
  const name = nameFor(email, contact?.display_name);
  const cached = recipientOffset(email);
  if (cached !== null) return { name, offsetMinutes: cached };

  const db = await getDb();
  const rows = await db.select<{ date_header: string | null }[]>(
    `SELECT date_header FROM messages
     WHERE LOWER(from_address) = LOWER($1)
       AND date_header IS NOT NULL
       AND ($2 IS NULL OR account_id = $2)
     ORDER BY date DESC
     LIMIT 1`,
    [email, accountId],
  );
  const header = rows[0]?.date_header ?? null;
  const parsed = header ? offsetFromDateHeader(header) : null;
  if (parsed !== null) {
    rememberRecipientOffset(email, parsed);
    if (contact) await setContactTimezone(email, parsed).catch(() => {});
    return { name, offsetMinutes: parsed };
  }
  if (typeof contact?.timezone_offset_minutes === "number") {
    rememberRecipientOffset(email, contact.timezone_offset_minutes);
    return { name, offsetMinutes: contact.timezone_offset_minutes };
  }
  return { name, offsetMinutes: null };
}
