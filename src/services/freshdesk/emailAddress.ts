/**
 * Email addresses reach Velo as untrusted text: typed by the operator, or copied
 * from a Freshdesk ticket whose requester controls them. One plain address per
 * entry; no display names, no whitespace or control characters (header injection),
 * no list separators.
 */
const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const MAX_ADDRESS_LENGTH = 254;
const MAX_LOCAL_LENGTH = 64;

export function isEmailAddress(text: string): boolean {
  if (text.length > MAX_ADDRESS_LENGTH || !ADDRESS.test(text)) return false;
  return text.indexOf("@") <= MAX_LOCAL_LENGTH;
}

/** Splits typed text on whitespace, commas and semicolons */
export function splitAddressText(text: string): string[] {
  return text.split(/[\s,;]+/).filter(Boolean);
}

/** The addresses that are valid, once each (compared without regard to case), in their first order */
export function uniqueValidAddresses(entries: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string") continue;
    const address = entry.trim();
    const key = address.toLowerCase();
    if (!isEmailAddress(address) || seen.has(key)) continue;
    seen.add(key);
    out.push(address);
  }
  return out;
}
