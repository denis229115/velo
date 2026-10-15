import { clickupGet } from "./client";

export interface ClickUpWorkspaceRef {
  workspaceId: string;
  name: string;
}

export interface ClickUpMember {
  userId: string;
  name: string;
  email: string | null;
}

export interface ClickUpStatus {
  name: string;
  /** ClickUp's status type: open, custom, done or closed */
  type: string;
  color: string | null;
  position: number;
}

export interface ClickUpList {
  listId: string;
  name: string;
  spaceName: string;
  folderName: string | null;
  position: number;
  statuses: ClickUpStatus[];
}

export interface ClickUpCustomField {
  listId: string;
  fieldId: string;
  name: string;
  type: string;
}

export interface ClickUpWorkspaceMetadata {
  lists: ClickUpList[];
  members: ClickUpMember[];
  customFields: ClickUpCustomField[];
}

interface ApiUser {
  id: number | string;
  username: string | null;
  email: string | null;
}

interface ApiStatus {
  status: string;
  type: string;
  color?: string | null;
  orderindex: number | string;
}

interface ApiList {
  id: string;
  name: string;
  archived?: boolean;
  statuses?: ApiStatus[];
}

interface ApiTeam {
  id: string;
  name: string;
  members?: { user: ApiUser }[];
}

/** Lists read per connect; their custom fields cost one request each. */
const MAX_LISTS = 100;

export function memberFrom(user: ApiUser): ClickUpMember {
  return { userId: String(user.id), name: user.username || user.email || `User ${user.id}`, email: user.email ?? null };
}

function statusesFrom(statuses: ApiStatus[]): ClickUpStatus[] {
  return statuses.map((s) => ({
    name: s.status,
    type: s.type,
    color: s.color ?? null,
    position: Number(s.orderindex) || 0,
  }));
}

/** The person the token belongs to. */
export async function fetchTokenUser(token: string): Promise<ClickUpMember> {
  const { user } = await clickupGet<{ user: ApiUser }>(token, "/user");
  return memberFrom(user);
}

/** The workspaces (ClickUp API "teams") the token can see. */
export async function fetchWorkspaces(token: string): Promise<ClickUpWorkspaceRef[]> {
  const { teams } = await clickupGet<{ teams: ApiTeam[] }>(token, "/team");
  return teams.map((t) => ({ workspaceId: String(t.id), name: t.name }));
}

/** Lists (with their statuses), members and custom fields of one workspace, exactly as ClickUp names them. */
export async function fetchWorkspaceMetadata(token: string, workspaceId: string): Promise<ClickUpWorkspaceMetadata> {
  const { teams } = await clickupGet<{ teams: ApiTeam[] }>(token, "/team");
  const team = teams.find((t) => String(t.id) === workspaceId);
  const members = (team?.members ?? []).map((m) => memberFrom(m.user));

  const { spaces } = await clickupGet<{ spaces: { id: string; name: string; statuses?: ApiStatus[] }[] }>(
    token,
    `/team/${encodeURIComponent(workspaceId)}/space?archived=false`,
  );

  const lists: ClickUpList[] = [];
  const add = (list: ApiList, spaceName: string, folderName: string | null, spaceStatuses: ApiStatus[]) => {
    if (list.archived || lists.length >= MAX_LISTS) return;
    lists.push({
      listId: String(list.id),
      name: list.name,
      spaceName,
      folderName,
      position: lists.length,
      // A list without its own statuses uses its space's
      statuses: statusesFrom(list.statuses ?? spaceStatuses),
    });
  };

  for (const space of spaces) {
    const spaceStatuses = space.statuses ?? [];
    const { folders } = await clickupGet<{ folders: { name: string; hidden?: boolean; lists: ApiList[] }[] }>(
      token,
      `/space/${encodeURIComponent(space.id)}/folder?archived=false`,
    );
    for (const folder of folders) {
      for (const list of folder.lists) add(list, space.name, folder.hidden ? null : folder.name, spaceStatuses);
    }
    const folderless = await clickupGet<{ lists: ApiList[] }>(token, `/space/${encodeURIComponent(space.id)}/list?archived=false`);
    for (const list of folderless.lists) add(list, space.name, null, spaceStatuses);
  }

  const customFields: ClickUpCustomField[] = [];
  for (const list of lists) {
    const { fields } = await clickupGet<{ fields: { id: string; name: string; type: string }[] }>(
      token,
      `/list/${encodeURIComponent(list.listId)}/field`,
    );
    for (const f of fields) customFields.push({ listId: list.listId, fieldId: f.id, name: f.name, type: f.type });
  }

  return { lists, members, customFields };
}

/** Who can be assigned tasks in one list (ClickUp limits this per list). */
export async function fetchListMembers(token: string, listId: string): Promise<ClickUpMember[]> {
  const { members } = await clickupGet<{ members: ApiUser[] }>(token, `/list/${encodeURIComponent(listId)}/member`);
  return members.map(memberFrom);
}
