import { FreshdeskError, freshdeskGet, freshdeskGetAll, type HelpdeskCredentials } from "./client";

export interface FieldChoice {
  fieldName: string;
  choiceId: string;
  label: string;
  customerLabel: string | null;
  position: number;
}

export interface TicketFieldDefinition {
  fieldId: string;
  name: string;
  label: string;
  type: string;
  isDefault: boolean;
  requiredForAgents: boolean;
  requiredForClosure: boolean;
  position: number;
}

export interface HelpdeskAgent {
  agentId: string;
  name: string;
  email: string | null;
}

export interface HelpdeskGroup {
  groupId: string;
  name: string;
}

export interface HelpdeskMetadata {
  ticketFields: TicketFieldDefinition[];
  choices: FieldChoice[];
  agents: HelpdeskAgent[];
  groups: HelpdeskGroup[];
}

interface RawTicketField {
  id: number | string;
  name: string;
  label: string;
  label_for_customers?: string;
  type: string;
  default?: boolean;
  position?: number;
  required_for_agents?: boolean;
  required_for_closure?: boolean;
  choices?: unknown;
}

interface RawAgent {
  id: number | string;
  contact?: { name?: string; email?: string | null };
}

interface RawGroup {
  id: number | string;
  name: string;
}

/** Agents and groups come from their own endpoints, so their field choices are not copied. */
const FIELDS_WITHOUT_CHOICES = new Set(["default_agent", "default_group", "default_company"]);

function malformed(what: string): never {
  throw new FreshdeskError("server", `Freshdesk returned ${what} in an unexpected shape.`);
}

/** Decodes the three shapes Freshdesk uses for `choices` without inventing values. */
function decodeChoices(field: RawTicketField): FieldChoice[] {
  const { choices } = field;
  if (choices == null || FIELDS_WITHOUT_CHOICES.has(field.type)) return [];

  if (Array.isArray(choices)) {
    return choices
      .filter((c): c is string => typeof c === "string")
      .map((value, position) => ({ fieldName: field.name, choiceId: value, label: value, customerLabel: null, position }));
  }
  if (typeof choices !== "object") malformed(`choices for ${field.name}`);

  return Object.entries(choices as Record<string, unknown>).map(([key, value], position) => {
    // Status: { "2": ["Open", "Being Processed"] }
    if (Array.isArray(value)) {
      if (typeof value[0] !== "string") malformed(`choices for ${field.name}`);
      return {
        fieldName: field.name,
        choiceId: key,
        label: value[0],
        customerLabel: typeof value[1] === "string" ? value[1] : null,
        position,
      };
    }
    // Priority, source: { "Low": 1 }
    if (typeof value === "number") {
      return { fieldName: field.name, choiceId: String(value), label: key, customerLabel: null, position };
    }
    // Nested dropdowns: top level only.
    return { fieldName: field.name, choiceId: key, label: key, customerLabel: null, position };
  });
}

function decodeTicketFields(raw: unknown): { ticketFields: TicketFieldDefinition[]; choices: FieldChoice[] } {
  if (!Array.isArray(raw)) malformed("ticket fields");
  const fields = raw as RawTicketField[];
  if (!fields.some((f) => f.name === "status" && f.choices)) malformed("ticket fields without statuses");

  return {
    ticketFields: fields.map((f, index) => ({
      fieldId: String(f.id),
      name: f.name,
      label: f.label,
      type: f.type,
      isDefault: f.default === true,
      requiredForAgents: f.required_for_agents === true,
      requiredForClosure: f.required_for_closure === true,
      position: f.position ?? index,
    })),
    choices: fields.flatMap(decodeChoices),
  };
}

export function decodeAgent(raw: unknown): HelpdeskAgent {
  const agent = raw as RawAgent | null;
  if (agent?.id == null || typeof agent.contact?.name !== "string") malformed("an agent");
  return { agentId: String(agent.id), name: agent.contact.name, email: agent.contact.email ?? null };
}

function decodeGroup(raw: unknown): HelpdeskGroup {
  const group = raw as RawGroup | null;
  if (group?.id == null || typeof group.name !== "string") malformed("a group");
  return { groupId: String(group.id), name: group.name };
}

/** The agent Freshdesk authenticates these credentials as: "me". */
export async function fetchCurrentAgent(credentials: HelpdeskCredentials): Promise<HelpdeskAgent> {
  return decodeAgent(await freshdeskGet<unknown>(credentials, "/agents/me"));
}

export async function fetchHelpdeskMetadata(credentials: HelpdeskCredentials): Promise<HelpdeskMetadata> {
  const [rawFields, rawAgents, rawGroups] = await Promise.all([
    freshdeskGet<unknown>(credentials, "/ticket_fields"),
    freshdeskGetAll<unknown>(credentials, "/agents"),
    freshdeskGetAll<unknown>(credentials, "/groups"),
  ]);
  return {
    ...decodeTicketFields(rawFields),
    agents: rawAgents.map(decodeAgent),
    groups: rawGroups.map(decodeGroup),
  };
}
