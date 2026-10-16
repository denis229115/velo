/**
 * Freshdesk API v2 responses for tests, shaped like the documented payloads of
 * GET /api/v2/agents/me, /ticket_fields, /agents and /groups.
 *
 * Every helpdesk, status, agent and group here is fictional ("Fixture ...").
 * None of it describes the operator's real helpdesk; real statuses are only
 * ever read from Freshdesk on connect.
 */

export const ALPHA_HOST = "fixture-alpha.freshdesk.com";
export const BETA_HOST = "fixture-beta.freshdesk.com";

function statusField(choices: Record<string, [string, string]>) {
  return {
    id: 60000000101,
    name: "status",
    label: "Status",
    description: "Ticket status",
    label_for_customers: "Status",
    position: 4,
    type: "default_status",
    default: true,
    required_for_closure: false,
    required_for_agents: true,
    required_for_customers: false,
    customers_can_edit: false,
    displayed_to_customers: true,
    created_at: "2026-01-05T09:00:00Z",
    updated_at: "2026-09-30T09:00:00Z",
    choices,
  };
}

const priorityField = {
  id: 60000000102,
  name: "priority",
  label: "Priority",
  description: "Ticket priority",
  label_for_customers: "Priority",
  position: 5,
  type: "default_priority",
  default: true,
  required_for_closure: false,
  required_for_agents: true,
  required_for_customers: false,
  customers_can_edit: false,
  displayed_to_customers: true,
  created_at: "2026-01-05T09:00:00Z",
  updated_at: "2026-01-05T09:00:00Z",
  choices: { Low: 1, Medium: 2, High: 3, Urgent: 4 },
};

const subjectField = {
  id: 60000000100,
  name: "subject",
  label: "Subject",
  description: "Ticket subject",
  label_for_customers: "Subject",
  position: 1,
  type: "default_subject",
  default: true,
  required_for_closure: false,
  required_for_agents: true,
  required_for_customers: true,
  customers_can_edit: true,
  displayed_to_customers: true,
  created_at: "2026-01-05T09:00:00Z",
  updated_at: "2026-01-05T09:00:00Z",
};

const customDropdownField = {
  id: 60000000110,
  name: "cf_fixture_product",
  label: "Fixture product",
  description: "",
  label_for_customers: "Product",
  position: 9,
  type: "custom_dropdown",
  default: false,
  required_for_closure: true,
  required_for_agents: false,
  required_for_customers: false,
  customers_can_edit: true,
  displayed_to_customers: true,
  created_at: "2026-02-01T09:00:00Z",
  updated_at: "2026-02-01T09:00:00Z",
  choices: ["Fixture Widget", "Fixture Gadget"],
};

/** Alpha helpdesk on first connect: defaults plus one custom status (6). */
export const alphaTicketFields = [
  subjectField,
  statusField({
    "2": ["Open", "Being Processed"],
    "3": ["Pending", "Awaiting your Reply"],
    "4": ["Resolved", "This ticket has been Resolved"],
    "5": ["Closed", "This ticket has been Closed"],
    "6": ["Fixture: With engineering", "Being Processed"],
  }),
  priorityField,
  customDropdownField,
];

/** Alpha helpdesk later: 3 and 6 renamed, 7 added. IDs unchanged. */
export const alphaTicketFieldsRenamed = [
  subjectField,
  statusField({
    "2": ["Open", "Being Processed"],
    "3": ["Fixture: Awaiting customer", "Awaiting your Reply"],
    "4": ["Resolved", "This ticket has been Resolved"],
    "5": ["Closed", "This ticket has been Closed"],
    "6": ["Fixture: With engineering team", "Being Processed"],
    "7": ["Fixture: On hold", "Being Processed"],
  }),
  priorityField,
  customDropdownField,
];

export const betaTicketFields = [
  subjectField,
  statusField({
    "2": ["Open", "Being Processed"],
    "5": ["Closed", "This ticket has been Closed"],
    "8": ["Fixture: Beta only", "Being Processed"],
  }),
  priorityField,
];

function agent(id: number, name: string, email: string) {
  return {
    available: true,
    occasional: false,
    id,
    signature: `<div>${name}</div>`,
    ticket_scope: 1,
    type: "support_agent",
    created_at: "2026-01-05T09:00:00Z",
    updated_at: "2026-09-30T09:00:00Z",
    contact: {
      active: true,
      email,
      job_title: null,
      language: "en",
      mobile: null,
      name,
      phone: null,
      time_zone: "Berlin",
    },
  };
}

/**
 * Two agents share the display name "Fixture Operator": the operator is
 * whoever /agents/me returns, never a name match.
 */
export const alphaMe = agent(9000000002, "Fixture Operator", "operator.fixture@example.test");
export const alphaAgents = [
  agent(9000000001, "Fixture Operator", "namesake.fixture@example.test"),
  alphaMe,
  agent(9000000003, "Fixture Colleague", "colleague.fixture@example.test"),
];

export const betaMe = agent(7000000001, "Fixture Beta Operator", "beta.operator.fixture@example.test");
export const betaAgents = [betaMe];

function group(id: number, name: string) {
  return {
    id,
    name,
    description: null,
    escalate_to: null,
    unassigned_for: null,
    business_hour_id: null,
    group_type: "support_agent_group",
    auto_ticket_assign: false,
    created_at: "2026-01-05T09:00:00Z",
    updated_at: "2026-01-05T09:00:00Z",
  };
}

export const alphaGroups = [group(8000000001, "Fixture Billing"), group(8000000002, "Fixture Escalations")];
export const betaGroups = [group(6000000001, "Fixture Beta Group")];

/** 401 body Freshdesk returns for a rejected API key. */
export const authenticationFailure = {
  code: "invalid_credentials",
  message: "You have to be logged in to perform this action.",
};

/** 400 body for a field value Freshdesk does not accept (e.g. a deleted status ID). */
export const invalidStatusValue = {
  description: "Validation failed",
  errors: [
    {
      field: "status",
      message: "It should be one of these values: '2,3,4,5,6,7'",
      code: "invalid_value",
    },
  ],
};

export interface FixtureTicket {
  id: number;
  subject: string;
  status: number;
  priority: number;
  requester_id: number;
  responder_id: number | null;
  group_id: number | null;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

export interface FreshdeskFixtureTenant {
  me: unknown;
  agents: unknown[];
  groups: unknown[];
  ticketFields: unknown[];
  /** GET /tickets payloads (requester embedded only on `include=requester`) */
  tickets?: FixtureTicket[];
  /** GET /contacts/:id payloads */
  contacts?: { id: number; name: string; email: string | null }[];
  /** GET /tickets/:id/conversations payloads, by ticket ID, oldest first */
  conversations?: Record<number, FixtureConversation[]>;
}

export interface FixtureConversation {
  id: number;
  body: string;
  body_text: string;
  incoming: boolean;
  private: boolean;
  user_id: number;
  source: number;
  ticket_id: number;
  support_email: string | null;
  from_email: string | null;
  to_emails: string[];
  cc_emails: string[];
  bcc_emails: string[];
  attachments: { id: number; name: string; content_type: string; size: number; attachment_url: string }[];
  automation_id: number | null;
  automation_type_id: number | null;
  created_at: string;
  updated_at: string;
}

export const alphaTenant: FreshdeskFixtureTenant = {
  me: alphaMe,
  agents: alphaAgents,
  groups: alphaGroups,
  ticketFields: alphaTicketFields,
};

export const betaTenant: FreshdeskFixtureTenant = {
  me: betaMe,
  agents: betaAgents,
  groups: betaGroups,
  ticketFields: betaTicketFields,
};
