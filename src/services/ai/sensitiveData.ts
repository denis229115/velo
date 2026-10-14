/**
 * Local sensitive-data check for the AI gateway. Runs before anything leaves
 * Velo: secrets are removed and never restored; payment and contact data are
 * replaced with placeholders such as [EMAIL_1] that are restored locally in the
 * result. Names and companies are not sensitive.
 */

export type SensitiveKind = "secret" | "card" | "iban" | "bank" | "email" | "phone" | "address";

export type FlagCategory = "secret" | "payment" | "contact";

export const SENSITIVE_KIND_CATEGORY: Record<SensitiveKind, FlagCategory> = {
  secret: "secret",
  card: "payment",
  iban: "payment",
  bank: "payment",
  email: "contact",
  phone: "contact",
  address: "contact",
};

/** What a secret is replaced with; it has no original to restore. */
export const SECRET_REMOVED = "[SECRET_REMOVED]";

type PlaceholderKind = Exclude<SensitiveKind, "secret">;

const PLACEHOLDER_PREFIX: Record<PlaceholderKind, string> = {
  card: "CARD",
  iban: "IBAN",
  bank: "BANK",
  email: "EMAIL",
  phone: "PHONE",
  address: "ADDRESS",
};

/**
 * Collects what one AI request flagged. Shared by every part of the request so
 * the same value always gets the same placeholder.
 */
export class Redaction {
  readonly counts: Record<SensitiveKind, number> = {
    secret: 0, card: 0, iban: 0, bank: 0, email: 0, phone: 0, address: 0,
  };
  private readonly byOriginal = new Map<string, string>();
  private readonly byPlaceholder = new Map<string, string>();
  private readonly next: Record<PlaceholderKind, number> = {
    card: 0, iban: 0, bank: 0, email: 0, phone: 0, address: 0,
  };

  placeholder(kind: PlaceholderKind, original: string): string {
    this.counts[kind]++;
    const key = `${kind}:${original}`;
    const existing = this.byOriginal.get(key);
    if (existing) return existing;
    const placeholder = `[${PLACEHOLDER_PREFIX[kind]}_${++this.next[kind]}]`;
    this.byOriginal.set(key, placeholder);
    this.byPlaceholder.set(placeholder, original);
    return placeholder;
  }

  removeSecret(): string {
    this.counts.secret++;
    return SECRET_REMOVED;
  }

  /** The sensitive-data kinds flagged at least once. */
  kinds(): SensitiveKind[] {
    return (Object.keys(this.counts) as SensitiveKind[]).filter((k) => this.counts[k] > 0);
  }

  categoryCounts(): Record<FlagCategory, number> {
    const totals: Record<FlagCategory, number> = { secret: 0, payment: 0, contact: 0 };
    for (const kind of Object.keys(this.counts) as SensitiveKind[]) {
      totals[SENSITIVE_KIND_CATEGORY[kind]] += this.counts[kind];
    }
    return totals;
  }

  /** Put the original payment and contact data back into AI output. Secrets stay removed. */
  restore(text: string): string {
    return text.replace(/\[(CARD|IBAN|BANK|EMAIL|PHONE|ADDRESS)_\d+\]/g, (p) => this.byPlaceholder.get(p) ?? p);
  }
}

// ── Secrets ──

const SECRET_KEYWORD =
  /\b(passwords?|passwd|pwd|passcodes?|passwort|kennwort|pin|api[ _-]?keys?|secret(?:[ _-]?key)?|client[ _-]?secret|(?:access|auth|refresh|api|bearer)?[ _-]?tokens?|credentials?)(\s*(?:is|was|=|:|-)\s*|\s+)(["']?)([^\s"',;]{4,})\3/gi;

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/g,
  // Credentials inside a URL: https://user:pass@host
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@/gi,
];

// Words after a secret keyword that are prose, not a secret value.
const NOT_A_SECRET = new Set([
  "reset", "resets", "change", "changed", "expired", "expires", "forgotten", "forgot", "for", "and",
  "the", "this", "that", "with", "from", "please", "policy", "manager", "required", "request",
  "requests", "again", "here", "below", "above", "link", "page", "field", "should", "will", "must",
]);

const PLACEHOLDER_OR_REMOVED = /^\[[A-Z]+_(?:\d+|REMOVED)\]/;

function removeSecrets(text: string, r: Redaction): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, () => r.removeSecret());
  return out.replace(SECRET_KEYWORD, (match, keyword: string, sep: string, quote: string, value: string) => {
    if (PLACEHOLDER_OR_REMOVED.test(value) || NOT_A_SECRET.has(value.toLowerCase())) return match;
    // "password is" with no ':' or '=' needs something that looks like a credential.
    if (/^\s+$/.test(sep) && !/[\d!@#$%^&*_+=-]/.test(value)) return match;
    return `${keyword}${sep}${quote}${r.removeSecret()}${quote}`;
  });
}

// ── Payment data ──

function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

function ibanValid(iban: string): boolean {
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const value = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

const IBAN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/g;
const CARD = /\b\d(?:[ -]?\d){12,18}\b/g;
const BANK_DETAIL =
  /\b(account (?:number|no\.?|#)|acct\.? (?:number|no\.?|#)|routing (?:number|no\.?)|sort code|kontonummer|bankleitzahl|blz|bic|swift(?: code)?)(\s*[:#]?\s*)([A-Z0-9][A-Z0-9 -]{3,}[A-Z0-9])/gi;

function replacePayment(text: string, r: Redaction): string {
  let out = text.replace(IBAN, (m) => {
    const compact = m.replace(/ /g, "");
    return ibanValid(compact) ? r.placeholder("iban", m) : m;
  });
  out = out.replace(CARD, (m) => (luhnValid(m.replace(/[ -]/g, "")) ? r.placeholder("card", m) : m));
  return out.replace(BANK_DETAIL, (_m, label: string, sep: string, value: string) =>
    `${label}${sep}${r.placeholder("bank", value)}`,
  );
}

// ── Contact data ──

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const PHONES: RegExp[] = [
  // International: +49 30 1234 5678, 0044 20 7946 0000, +1 (555) 010-0000
  /(?:\+|\b00)\d{1,3}(?:[ ./-]?\(?\d+\)?)+/g,
  // North American: (555) 010-0000, 555-010-0000
  /(?:\(\d{3}\)\s?|\b\d{3}[ .-])\d{3}[ .-]\d{4}\b/g,
  // National with a trunk zero: 030 1234567, 0170/1234567
  /\b0\d{2,5}[ /-]\d{3,}(?:[ -]\d{2,})*\b/g,
];

const STREET_SUFFIX =
  "Street|St\\.|Avenue|Ave\\.|Road|Rd\\.|Boulevard|Blvd\\.|Lane|Ln\\.|Drive|Dr\\.|Court|Ct\\.|Place|Pl\\.|Way|Terrace|Close|Crescent";
const ADDRESSES: RegExp[] = [
  // 42 Fakeholm Street
  new RegExp(`\\b\\d{1,5}[a-z]?\\s+(?:[A-Z][\\w'-]*\\s+){1,4}(?:${STREET_SUFFIX})(?=\\W|$)`, "g"),
  // Musterstraße 12, Am Fakeweg 3a
  /\b(?:[A-ZÄÖÜ][\wäöüß-]*\s+)*[A-ZÄÖÜ][\wäöüß-]*(?:straße|strasse|str\.|weg|gasse|platz|allee|ring|damm|ufer|chaussee)\s+\d{1,4}\s?[a-z]?\b/g,
  /\b(?:[A-ZÄÖÜ][\wäöüß-]*\s+)+(?:Straße|Strasse|Str\.|Weg|Gasse|Platz|Allee|Ring|Damm)\s+\d{1,4}\s?[a-z]?\b/g,
  // 10115 Berlin
  /\b\d{5}\s+[A-ZÄÖÜ][a-zäöüß]+(?:[ -][A-ZÄÖÜ][a-zäöüß]+)?\b/g,
  // Springfield, IL 62701
  /\b[A-Z][a-z]+(?: [A-Z][a-z]+)?, [A-Z]{2} \d{5}(?:-\d{4})?\b/g,
  // SW1A 1AA
  /\b[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}\b/g,
];

function replaceContact(text: string, r: Redaction): string {
  let out = text.replace(EMAIL, (m) => r.placeholder("email", m));
  for (const pattern of ADDRESSES) out = out.replace(pattern, (m) => r.placeholder("address", m));
  for (const pattern of PHONES) {
    out = out.replace(pattern, (m) => {
      const trimmed = m.replace(/[ ./-]+$/, "");
      const digits = trimmed.replace(/\D/g, "").length;
      if (digits < 7 || digits > 15) return m;
      return r.placeholder("phone", trimmed) + m.slice(trimmed.length);
    });
  }
  return out;
}

/** Replace sensitive data in one piece of outbound text, recording what was flagged. */
export function redact(text: string, r: Redaction): string {
  if (!text) return text;
  return replaceContact(replacePayment(removeSecrets(text, r), r), r);
}

/** True when the text holds a password, API key or token. */
export function containsSecret(text: string): boolean {
  const r = new Redaction();
  removeSecrets(text, r);
  return r.counts.secret > 0;
}

/** True when the text still holds anything the local check would flag. */
export function containsSensitiveData(text: string): boolean {
  const r = new Redaction();
  redact(text, r);
  return r.kinds().length > 0;
}
