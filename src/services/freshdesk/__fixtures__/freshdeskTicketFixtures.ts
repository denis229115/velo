/**
 * Freshdesk API v2 ticket payloads for the alpha fixture helpdesk, shaped like
 * GET /api/v2/tickets, /search/tickets, /tickets/:id and /contacts/:id.
 *
 * Fictional throughout. Times are relative to FIXTURE_NOW so the 90-day
 * window is deterministic under a fixed system time.
 */
import { alphaTenant, type FixtureTicket, type FreshdeskFixtureTenant } from "./freshdeskFixtures";

export const FIXTURE_NOW = Date.parse("2026-10-14T12:00:00Z");

const DAY = 86_400_000;
const iso = (msAgo: number) => new Date(FIXTURE_NOW - msAgo).toISOString().replace(/\.\d{3}Z$/, "Z");

/** Agent IDs from freshdeskFixtures: me, my namesake, a colleague. */
export const ME_ID = 9000000002;
export const NAMESAKE_ID = 9000000001;
export const COLLEAGUE_ID = 9000000003;

export const fixtureContacts = [
  { id: 5000000001, name: "Fixture Customer Ada", email: "ada.fixture@example.test" },
  { id: 5000000002, name: "Fixture Customer Bo", email: "bo.fixture@example.test" },
  { id: 5000000003, name: "Fixture Customer Cy", email: "cy.fixture@example.test" },
];

function ticket(
  id: number,
  subject: string,
  status: number,
  priority: number,
  responder: number | null,
  updatedAgo: number,
  requester = 5000000001,
): FixtureTicket {
  return {
    id,
    subject,
    status,
    priority,
    requester_id: requester,
    responder_id: responder,
    group_id: 8000000001,
    company_id: null,
    source: 1,
    type: null,
    tags: [],
    cc_emails: [],
    reply_cc_emails: [],
    fwd_emails: [],
    is_escalated: false,
    due_by: iso(-DAY),
    fr_due_by: iso(-DAY),
    created_at: iso(updatedAgo + DAY),
    updated_at: iso(updatedAgo),
  };
}

export const fixtureTickets: FixtureTicket[] = [
  ticket(1001, "Fixture: cannot sign in", 2, 3, ME_ID, DAY),
  ticket(1002, "Fixture: export stuck", 6, 2, COLLEAGUE_ID, 3 * DAY, 5000000002),
  ticket(1003, "Fixture: status Velo does not know", 9, 1, ME_ID, 2 * 3_600_000),
  ticket(1004, "Fixture: refund issued", 4, 2, ME_ID, 10 * DAY),
  ticket(1005, "Fixture: old closed request", 5, 1, ME_ID, 200 * DAY),
  ticket(1006, "Fixture: long-waiting reply", 3, 4, ME_ID, 400 * DAY, 5000000003),
  ticket(1007, "Fixture: namesake's ticket", 2, 2, NAMESAKE_ID, 5 * DAY),
  ticket(1008, "Fixture: nobody assigned", 2, 2, null, 6 * DAY),
];

/** Alpha helpdesk with tickets: statuses 2–6 known, 9 is not in metadata. */
export const alphaTenantWithTickets: FreshdeskFixtureTenant = {
  ...alphaTenant,
  tickets: fixtureTickets,
  contacts: fixtureContacts,
};

/**
 * Tickets with CC lists as Freshdesk API v2 returns them: cc_emails (copied on the
 * ticket), reply_cc_emails (copied on replies) and fwd_emails (forwarded to).
 * 1101 has all three (one address repeats across lists, one differs in case, one
 * is the customer's own address); 1102 has none; 1103 holds text that is not an address.
 */
export const CC_TICKET_ID = "1101";
export const NO_CC_TICKET_ID = "1102";
export const UNTRUSTED_CC_TICKET_ID = "1103";
export const ccFixtureTickets: FixtureTicket[] = [
  {
    ...ticket(1101, "Fixture: copied colleagues", 2, 2, ME_ID, DAY),
    cc_emails: ["cc.one@example.test", "Cc.Two@example.test", "ada.fixture@example.test"],
    reply_cc_emails: ["CC.ONE@example.test", "reply.only@example.test"],
    fwd_emails: ["forward.person@example.test"],
  },
  ticket(1102, "Fixture: nobody copied", 2, 2, ME_ID, 2 * DAY),
  {
    ...ticket(1103, "Fixture: odd copy list", 2, 2, ME_ID, 3 * DAY),
    cc_emails: ["fine.one@example.test", "not an address", "evil@example.test\r\nBcc: x@example.test"],
    reply_cc_emails: [],
  },
];

/** Alpha helpdesk with the ordinary fixture tickets plus the CC ones. */
export const alphaTenantWithCcTickets: FreshdeskFixtureTenant = {
  ...alphaTenantWithTickets,
  tickets: [...fixtureTickets, ...ccFixtureTickets],
};

export const rateLimited = { status: 429, body: { message: "You have exceeded the limit of requests per minute" }, headers: { "Retry-After": "42" } };

/** 400 for a move to a done status while a field required for closure is empty. */
export const closureFieldMissing = {
  method: "PUT",
  status: 400,
  body: {
    description: "Validation failed",
    errors: [{ field: "cf_fixture_product", message: "It should not be blank as this is a mandatory field", code: "missing_field" }],
  },
};

/** 403 for an agent whose role may not edit the ticket. */
export const accessDenied = {
  method: "PUT",
  status: 403,
  body: { code: "access_denied", message: "You are not authorized to perform this action." },
};

/** 400 for an assignee Freshdesk does not accept for this ticket. */
export const invalidAssignee = {
  method: "PUT",
  status: 400,
  body: {
    description: "Validation failed",
    errors: [{ field: "responder_id", message: "There is no agent matching the given responder_id", code: "invalid_value" }],
  },
};
