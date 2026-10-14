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

export const rateLimited = { status: 429, body: { message: "You have exceeded the limit of requests per minute" }, headers: { "Retry-After": "42" } };
