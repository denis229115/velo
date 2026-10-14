import { deleteSetting, getSecureSetting, setSecureSetting } from "@/services/db/settings";
import {
  deleteClickUpDataExcept,
  deleteClickUpWorkspace,
  getClickUpCustomFields,
  getClickUpLists,
  getClickUpMembers,
  getClickUpSyncState,
  getClickUpWorkspace,
  replaceWorkspaceMetadata,
  saveClickUpSyncState,
  saveClickUpWorkspace,
  setWorkspaceChoice,
} from "@/services/db/clickup";
import { ClickUpError } from "./client";
import {
  fetchTokenUser,
  fetchWorkspaceMetadata,
  fetchWorkspaces,
  type ClickUpMember,
  type ClickUpWorkspaceRef,
} from "./metadata";
import { SAMPLE_LISTS } from "./sampleData";

/** Secure (encrypted) setting holding the ClickUp API token. */
const TOKEN_SETTING = "clickup_api_token";

export function tenantIdForWorkspace(workspaceId: string): string {
  return `clickup:${workspaceId}`;
}

export interface WorkspaceConnection {
  tenantId: string;
  workspaceId: string;
  name: string;
  me: ClickUpMember | null;
  connectedAt: number;
  metadataRefreshedAt: number | null;
}

export type ConnectResult =
  | { status: "connected"; connection: WorkspaceConnection }
  /** The token sees several workspaces; connect again with the chosen one */
  | { status: "choose_workspace"; workspaces: ClickUpWorkspaceRef[] };

export interface ListView {
  listId: string;
  name: string;
  /** Space, then folder when the list is in one */
  location: string;
  statuses: { name: string; type: string; color: string | null }[];
}

export interface CustomFieldView {
  fieldId: string;
  name: string;
  type: string;
  listNames: string[];
}

export interface ClickUpSettingsView {
  isSample: boolean;
  workspace: WorkspaceConnection | null;
  lists: ListView[];
  members: ClickUpMember[];
  customFields: CustomFieldView[];
  defaultListId: string | null;
  ticketIdFieldId: string | null;
}

export async function getWorkspaceConnection(): Promise<WorkspaceConnection | null> {
  const row = await getClickUpWorkspace();
  if (!row) return null;
  return {
    tenantId: row.tenantId,
    workspaceId: row.workspaceId,
    name: row.workspaceName,
    me: row.me,
    connectedAt: row.connectedAt,
    metadataRefreshedAt: row.metadataRefreshedAt,
  };
}

/**
 * Verifies the token against ClickUp, reads the chosen workspace's metadata
 * and only then stores anything. A different workspace leaves no cached
 * tasks or links behind from before.
 */
export async function connectWorkspace(input: { token: string; workspaceId?: string }): Promise<ConnectResult> {
  const token = input.token.trim();
  if (!token) throw new ClickUpError("auth", "Enter the personal API token from your ClickUp settings.");

  const me = await fetchTokenUser(token);
  const workspaces = await fetchWorkspaces(token);
  if (workspaces.length === 0) throw new ClickUpError("not_found", "This token cannot see any ClickUp workspace.");

  const chosen = input.workspaceId
    ? workspaces.find((w) => w.workspaceId === input.workspaceId)
    : workspaces.length === 1 ? workspaces[0] : undefined;
  if (!chosen) {
    if (input.workspaceId) throw new ClickUpError("not_in_workspace", "This token cannot see that workspace.");
    return { status: "choose_workspace", workspaces };
  }

  const metadata = await fetchWorkspaceMetadata(token, chosen.workspaceId);
  const tenantId = tenantIdForWorkspace(chosen.workspaceId);
  await deleteClickUpDataExcept(tenantId);
  await setSecureSetting(TOKEN_SETTING, token);
  await saveClickUpWorkspace({ tenantId, workspaceId: chosen.workspaceId, workspaceName: chosen.name, me });
  await replaceWorkspaceMetadata(tenantId, metadata);
  await clearAuthBlock(tenantId);

  const connection = await getWorkspaceConnection();
  if (!connection) throw new ClickUpError("server", "The workspace connection could not be saved.");
  return { status: "connected", connection };
}

/** A new token lifts a rejected-credentials block; a Retry-After wait stays. */
async function clearAuthBlock(tenantId: string): Promise<void> {
  const state = await getClickUpSyncState(tenantId);
  if (state.state !== "auth_error") return;
  await saveClickUpSyncState(tenantId, { ...state, state: "idle", errorMessage: null, consecutiveFailures: 0 });
}

/** Forgets the token. Links and cached tasks stay with their workspace and show again only if it is reconnected. */
export async function disconnectWorkspace(): Promise<void> {
  await deleteSetting(TOKEN_SETTING);
  await deleteClickUpWorkspace();
}

/** The connected workspace and its token; null when not connected. Never log the result. */
export async function currentClickUpCredentials(): Promise<{ tenantId: string; workspaceId: string; token: string } | null> {
  const row = await getClickUpWorkspace();
  if (!row) return null;
  const token = await getSecureSetting(TOKEN_SETTING);
  if (!token) return null;
  return { tenantId: row.tenantId, workspaceId: row.workspaceId, token };
}

/** Re-reads lists, statuses, members and custom fields. */
export async function refreshWorkspaceMetadata(): Promise<boolean> {
  const current = await currentClickUpCredentials();
  if (!current) return false;
  const metadata = await fetchWorkspaceMetadata(current.token, current.workspaceId);
  await replaceWorkspaceMetadata(current.tenantId, metadata);
  return true;
}

function listView(l: { listId: string; name: string; spaceName: string; folderName: string | null; statuses: ListView["statuses"] }): ListView {
  return {
    listId: l.listId,
    name: l.name,
    location: l.folderName ? `${l.spaceName} / ${l.folderName}` : l.spaceName,
    statuses: l.statuses.map((s) => ({ name: s.name, type: s.type, color: s.color })),
  };
}

/** What Settings → ClickUp shows: the workspace's own names, or marked sample lists when not connected. */
export async function getClickUpSettings(): Promise<ClickUpSettingsView> {
  const row = await getClickUpWorkspace();
  if (!row) {
    return {
      isSample: true,
      workspace: null,
      lists: SAMPLE_LISTS.map(listView),
      members: [],
      customFields: [],
      defaultListId: null,
      ticketIdFieldId: null,
    };
  }
  const [lists, members, fields] = await Promise.all([
    getClickUpLists(row.tenantId),
    getClickUpMembers(row.tenantId),
    getClickUpCustomFields(row.tenantId),
  ]);
  const listNames = new Map(lists.map((l) => [l.listId, l.name]));
  const byField = new Map<string, CustomFieldView>();
  for (const f of fields) {
    const view = byField.get(f.fieldId) ?? { fieldId: f.fieldId, name: f.name, type: f.type, listNames: [] };
    const listName = listNames.get(f.listId);
    if (listName) view.listNames.push(listName);
    byField.set(f.fieldId, view);
  }
  return {
    isSample: false,
    workspace: await getWorkspaceConnection(),
    lists: lists.map(listView),
    members,
    customFields: [...byField.values()].map((f) => ({ ...f, listNames: f.listNames.sort((a, b) => a.localeCompare(b)) })),
    defaultListId: row.defaultListId,
    ticketIdFieldId: row.ticketIdFieldId,
  };
}

/** Sets the list new tasks go to by default; it must be a list of the connected workspace. */
export async function setDefaultList(listId: string | null): Promise<void> {
  const settings = await getClickUpSettings();
  if (settings.isSample) throw new Error("Connect a ClickUp workspace before choosing a default list.");
  if (listId !== null && !settings.lists.some((l) => l.listId === listId)) {
    throw new Error("That list is not in the connected workspace.");
  }
  await setWorkspaceChoice("default_list_id", listId);
}

/** Selects the custom field (created by the operator in ClickUp) that holds the ticket ID. */
export async function setTicketIdField(fieldId: string | null): Promise<void> {
  const settings = await getClickUpSettings();
  if (settings.isSample) throw new Error("Connect a ClickUp workspace before choosing the Ticket-ID field.");
  if (fieldId !== null && !settings.customFields.some((f) => f.fieldId === fieldId)) {
    throw new Error("That custom field is not in the connected workspace.");
  }
  await setWorkspaceChoice("ticket_id_field_id", fieldId);
}
