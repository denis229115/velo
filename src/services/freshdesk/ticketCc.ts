import { uniqueValidAddresses } from "./emailAddress";

/**
 * Who a Reply starts out copying: the ticket's CC list and reply-CC list, once
 * each, without the customer (the To line already has them). The forward list
 * is not copied: those people were sent the ticket, not part of the thread.
 */
export function replyCcPrefill(ticket: {
  ccEmails: readonly string[];
  replyCcEmails: readonly string[];
  customerEmail: string | null;
}): string[] {
  const customer = ticket.customerEmail?.trim().toLowerCase();
  return uniqueValidAddresses([...ticket.ccEmails, ...ticket.replyCcEmails]).filter((a) => a.toLowerCase() !== customer);
}

/** The same people, however they are written or ordered */
export function sameAddresses(a: readonly string[], b: readonly string[]): boolean {
  const key = (list: readonly string[]) => [...new Set(list.map((x) => x.toLowerCase()))].sort().join("\n");
  return key(a) === key(b);
}
