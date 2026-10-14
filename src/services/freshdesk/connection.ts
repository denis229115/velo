import { createBackgroundChecker } from "@/services/backgroundCheckers";
import { withReadSnapshot } from "@/services/db/connection";
import { deleteSetting, getSecureSetting, setSecureSetting } from "@/services/db/settings";
import {
  deleteFreshdeskDataExcept,
  deleteIntegrationAccount,
  getAgents,
  getFieldChoices,
  getGroups,
  getIntegrationAccount,
  getStatusClasses,
  getTicketFields,
  replaceHelpdeskMetadata,
  saveIntegrationAccount,
  setStatusClass,
  updateIntegrationIdentity,
  type StatusClass,
} from "@/services/db/freshdesk";
import { clearTicketSyncAuthBlock } from "@/services/db/freshdeskTickets";
import { FreshdeskError, normalizeHelpdeskHost, type HelpdeskCredentials } from "./client";
import {
  fetchCurrentAgent,
  fetchHelpdeskMetadata,
  type FieldChoice,
  type HelpdeskAgent,
  type HelpdeskGroup,
  type TicketFieldDefinition,
} from "./metadata";
import { SAMPLE_STATUSES } from "./sampleData";

/** Secure (encrypted) setting holding the helpdesk API key. */
const API_KEY_SETTING = "freshdesk_api_key";

/** Tenant that sample-data classifications are stored under. */
export const SAMPLE_TENANT_ID = "freshdesk:sample";

export function tenantIdForHost(host: string): string {
  return `freshdesk:${host}`;
}

export interface HelpdeskConnection {
  tenantId: string;
  host: string;
  me: HelpdeskAgent | null;
  connectedAt: number;
  metadataRefreshedAt: number | null;
}

export interface ClassifiableStatus {
  id: string;
  label: string;
  customerLabel: string | null;
  statusClass: StatusClass | null;
}

export interface StatusClassification {
  isSample: boolean;
  statuses: ClassifiableStatus[];
}

export interface HelpdeskMetadataSummary {
  priorities: FieldChoice[];
  agents: HelpdeskAgent[];
  groups: HelpdeskGroup[];
  ticketFields: TicketFieldDefinition[];
}

export async function getHelpdeskConnection(): Promise<HelpdeskConnection | null> {
  const account = await getIntegrationAccount("freshdesk");
  if (!account) return null;
  return {
    tenantId: account.tenantId,
    host: account.tenantHost,
    me: account.me,
    connectedAt: account.connectedAt,
    metadataRefreshedAt: account.metadataRefreshedAt,
  };
}

/**
 * Verifies the credentials against Freshdesk, reads the helpdesk's metadata
 * and only then stores anything. A different helpdesk (or sample data)
 * leaves nothing behind from before.
 */
export async function connectHelpdesk(input: { host: string; apiKey: string }): Promise<HelpdeskConnection> {
  const host = normalizeHelpdeskHost(input.host);
  const apiKey = input.apiKey.trim();
  if (!apiKey) throw new FreshdeskError("auth", "Enter the API key from your Freshdesk profile settings.");

  const credentials: HelpdeskCredentials = { host, apiKey };
  const me = await fetchCurrentAgent(credentials);
  const metadata = await fetchHelpdeskMetadata(credentials);

  const tenantId = tenantIdForHost(host);
  await deleteFreshdeskDataExcept(tenantId);
  await setSecureSetting(API_KEY_SETTING, apiKey);
  await saveIntegrationAccount({ kind: "freshdesk", tenantId, tenantHost: host, me });
  await replaceHelpdeskMetadata(tenantId, metadata);
  await clearTicketSyncAuthBlock(tenantId);

  const connection = await getHelpdeskConnection();
  if (!connection) throw new FreshdeskError("server", "The helpdesk connection could not be saved.");
  return connection;
}

/** Forgets the credentials and returns to sample data. */
export async function disconnectHelpdesk(): Promise<void> {
  await deleteSetting(API_KEY_SETTING);
  await deleteIntegrationAccount("freshdesk");
}

/** The connected helpdesk and its API key; null in sample mode. Never log the result. */
export async function currentCredentials(): Promise<{ tenantId: string; credentials: HelpdeskCredentials } | null> {
  const account = await getIntegrationAccount("freshdesk");
  if (!account) return null;
  const apiKey = await getSecureSetting(API_KEY_SETTING);
  if (!apiKey) return null;
  return { tenantId: account.tenantId, credentials: { host: account.tenantHost, apiKey } };
}

/** Re-reads identity and metadata. IDs stay stable; labels follow Freshdesk. */
export async function refreshHelpdeskMetadata(): Promise<boolean> {
  const current = await currentCredentials();
  if (!current) return false;
  const me = await fetchCurrentAgent(current.credentials);
  const metadata = await fetchHelpdeskMetadata(current.credentials);
  await updateIntegrationIdentity("freshdesk", me);
  await replaceHelpdeskMetadata(current.tenantId, metadata);
  return true;
}

/**
 * Call with any error from a Freshdesk write: an invalid-value rejection means
 * the cached metadata is out of date, so it is refreshed.
 */
export async function refreshMetadataAfterInvalidValue(error: unknown): Promise<boolean> {
  if (!(error instanceof FreshdeskError) || error.kind !== "invalid_value") return false;
  return refreshHelpdeskMetadata();
}

async function currentTenantId(): Promise<string> {
  return (await getIntegrationAccount("freshdesk"))?.tenantId ?? SAMPLE_TENANT_ID;
}

export function getStatusClassification(): Promise<StatusClassification> {
  return withReadSnapshot(readStatusClassification);
}

async function readStatusClassification(): Promise<StatusClassification> {
  const tenantId = await currentTenantId();
  const classes = await getStatusClasses(tenantId);

  if (tenantId === SAMPLE_TENANT_ID) {
    return {
      isSample: true,
      statuses: SAMPLE_STATUSES.map((s) => ({
        id: s.id,
        label: s.label,
        customerLabel: null,
        statusClass: classes.get(s.id) ?? null,
      })),
    };
  }

  const choices = await getFieldChoices(tenantId, "status");
  return {
    isSample: false,
    statuses: choices.map((c) => ({
      id: c.choiceId,
      label: c.label,
      customerLabel: c.customerLabel,
      statusClass: classes.get(c.choiceId) ?? null,
    })),
  };
}

export async function classifyStatus(statusId: string, statusClass: StatusClass): Promise<void> {
  const tenantId = await currentTenantId();
  const { statuses } = await getStatusClassification();
  if (!statuses.some((s) => s.id === statusId)) {
    throw new Error(`Status ${statusId} is not a status of the current helpdesk.`);
  }
  await setStatusClass(tenantId, statusId, statusClass);
}

/** Priorities, agents, groups and ticket fields of the connected helpdesk. */
export function getHelpdeskMetadataSummary(): Promise<HelpdeskMetadataSummary | null> {
  return withReadSnapshot(readHelpdeskMetadataSummary);
}

async function readHelpdeskMetadataSummary(): Promise<HelpdeskMetadataSummary | null> {
  const account = await getIntegrationAccount("freshdesk");
  if (!account) return null;
  const [priorities, agents, groups, ticketFields] = await Promise.all([
    getFieldChoices(account.tenantId, "priority"),
    getAgents(account.tenantId),
    getGroups(account.tenantId),
    getTicketFields(account.tenantId),
  ]);
  return { priorities, agents, groups, ticketFields };
}

const SIX_HOURS = 6 * 60 * 60 * 1000;

const metadataRefresher = createBackgroundChecker(
  "FreshdeskMetadata",
  async () => {
    await refreshHelpdeskMetadata();
  },
  SIX_HOURS,
);
export const startFreshdeskMetadataRefresher = metadataRefresher.start;
export const stopFreshdeskMetadataRefresher = metadataRefresher.stop;
