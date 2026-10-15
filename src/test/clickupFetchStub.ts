import { createMockFetchResponse } from "@/test/mocks";
import type {
  ClickUpFixtureToken,
  ClickUpFixtureWorkspace,
  FixtureList,
  FixtureTask,
} from "@/services/clickup/__fixtures__/clickupFixtures";

export interface RecordedClickUpRequest {
  url: string;
  path: string;
  method: string;
  authorization: string | null;
  body?: Record<string, unknown>;
}

interface CannedResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Only for this method; any method when unset */
  method?: string;
  /** Carry the write out first (as ClickUp would), then answer as configured */
  apply?: boolean;
  /** Drop the connection instead of answering: with `apply`, an ambiguous timeout after remote acceptance */
  networkError?: boolean;
}

const TASK_PAGE_SIZE = 100;

/**
 * Stands in for the Tauri HTTP fetch boundary with fixture ClickUp
 * workspaces. Each personal token sees only its own workspaces, and the
 * stub answers with the documented v2 shapes and error codes.
 */
export function createClickUpFetchStub(tokens: Record<string, ClickUpFixtureToken>) {
  const requests: RecordedClickUpRequest[] = [];
  const queued = new Map<string, CannedResponse[]>();
  // Per-stub copies so a test can change what ClickUp answers
  const state: Record<string, ClickUpFixtureToken> = Object.fromEntries(
    Object.entries(tokens).map(([token, t]) => [
      token,
      {
        user: t.user,
        // Writes change the stub's own task copies, never the shared fixtures
        workspaces: t.workspaces.map((w) => ({ ...w, tasks: w.tasks.map((task) => ({ ...task, custom_fields: [...task.custom_fields] })) })),
      },
    ]),
  );

  function json(status: number, body: unknown, headers?: Record<string, string>) {
    return createMockFetchResponse({
      status,
      data: body,
      text: JSON.stringify(body),
      headers: { "content-type": "application/json", ...headers },
    });
  }

  const listShape = (list: FixtureList, space: { id: string; name: string }) => ({
    id: list.id,
    name: list.name,
    orderindex: list.orderindex,
    archived: list.archived,
    space,
    ...(list.statuses ? { statuses: list.statuses, override_statuses: true } : { override_statuses: false }),
  });

  function allWorkspaces(): ClickUpFixtureWorkspace[] {
    return Object.values(state).flatMap((t) => t.workspaces);
  }

  function findList(listId: string) {
    for (const ws of allWorkspaces()) {
      for (const space of ws.spaces) {
        const list = [...space.folders.flatMap((f) => f.lists), ...space.folderlessLists].find((l) => l.id === listId);
        if (list) return { ws, list, statuses: list.statuses ?? space.statuses, spaceId: space.id };
      }
    }
    return null;
  }

  let nextTaskNo = 1;
  const findTask = (id: string) => allWorkspaces().flatMap((w) => w.tasks).find((t) => t.id === id);

  /** The writes ClickUp carries out; null when the target does not exist */
  function applyWrite(method: string, path: string, body: Record<string, unknown>): { status: number; body: unknown } | null {
    let m = path.match(/^\/list\/([^/]+)\/task$/);
    if (m && method === "POST") {
      const found = findList(m[1]!);
      if (!found) return { status: 404, body: { err: "List not found", ECODE: "ITEM_015" } };
      const { ws, list, statuses, spaceId } = found;
      const status = statuses.find((s) => s.status === body.status) ?? statuses[0]!;
      const id = `86a0new${String(nextTaskNo++).padStart(2, "0")}`;
      const description = String(body.markdown_content ?? body.description ?? "");
      const now = String(Date.now());
      const created: FixtureTask = {
        id,
        custom_id: null,
        name: String(body.name ?? ""),
        text_content: description,
        description,
        status,
        orderindex: "1.0000",
        date_created: now,
        date_updated: now,
        date_closed: null,
        date_done: null,
        archived: false,
        creator: { ...ws.members[0]!, initials: undefined } as FixtureTask["creator"],
        assignees: ws.members.filter((u) => ((body.assignees as number[] | undefined) ?? []).includes(u.id)),
        due_date: body.due_date === undefined || body.due_date === null ? null : String(body.due_date),
        start_date: null,
        url: `https://app.clickup.com/t/${id}`,
        list: { id: list.id, name: list.name, access: true },
        folder: { id: "fo_a_1", name: "Fixture folder", hidden: false, access: true },
        space: { id: spaceId },
        team_id: ws.id,
        custom_fields: [],
      };
      ws.tasks.push(created);
      return { status: 200, body: created };
    }
    m = path.match(/^\/task\/([^/]+)$/);
    if (m && method === "PUT") {
      const t = findTask(decodeURIComponent(m[1]!));
      if (!t) return { status: 404, body: { err: "Task not found, deleted", ECODE: "ITEM_013" } };
      const description = body.markdown_content ?? body.description;
      if (typeof description === "string") Object.assign(t, { description, text_content: description });
      if (typeof body.name === "string") t.name = body.name;
      t.date_updated = String(Date.now());
      return { status: 200, body: t };
    }
    m = path.match(/^\/task\/([^/]+)\/field\/([^/]+)$/);
    if (m && method === "POST") {
      const t = findTask(decodeURIComponent(m[1]!));
      if (!t) return { status: 404, body: { err: "Task not found, deleted", ECODE: "ITEM_013" } };
      const ws = allWorkspaces().find((w) => w.id === t.team_id)!;
      if (!(ws.fields[t.list.id] ?? []).some((f) => f.id === m![2])) {
        return { status: 400, body: { err: "Custom field is not on this list", ECODE: "FIELD_010" } };
      }
      t.custom_fields = [...t.custom_fields.filter((f) => f.id !== m![2]), { id: m[2]!, value: body.value }];
      return { status: 200, body: {} };
    }
    return null;
  }

  async function fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    const authorization = headers.get("authorization");
    const path = url.pathname.replace(/^\/api\/v2/, "");
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    requests.push({ url: url.href, path, method, authorization, ...(body !== undefined && { body }) });

    if (url.host !== "api.clickup.com") throw new TypeError(`fixture: unexpected host ${url.host}`);

    const pending = queued.get(path) ?? [];
    const cannedIndex = pending.findIndex((c) => c.method === undefined || c.method === method);
    if (cannedIndex >= 0) {
      const [canned] = pending.splice(cannedIndex, 1);
      if (canned!.apply) applyWrite(method, path, body ?? {});
      if (canned!.networkError) throw new TypeError("fixture: connection dropped");
      return json(canned!.status ?? 200, canned!.body ?? {}, canned!.headers);
    }

    const owner = authorization ? state[authorization] : undefined;
    if (!owner) return json(401, { err: "Token invalid", ECODE: "OAUTH_025" });
    const own = (id: string | undefined) => owner.workspaces.find((w) => w.id === id);
    const notAuthorized = () => json(401, { err: "Team not authorized", ECODE: "OAUTH_027" });

    if (path === "/user") return json(200, { user: owner.user });
    if (path === "/team") {
      return json(200, {
        teams: owner.workspaces.map((w) => ({
          id: w.id,
          name: w.name,
          color: "#7b68ee",
          avatar: null,
          members: w.members.map((user) => ({ user: { ...user, role: 3 } })),
        })),
      });
    }

    if (method !== "GET") {
      const written = applyWrite(method, path, body ?? {});
      if (written) {
        const target = path.startsWith("/list/") ? findList(path.split("/")[2]!)?.ws : undefined;
        if (target && !own(target.id)) return notAuthorized();
        return json(written.status, written.body);
      }
      return json(404, { err: "Route not found", ECODE: "APP_001" });
    }

    let m = path.match(/^\/team\/([^/]+)\/space$/);
    if (m) {
      const ws = own(m[1]);
      if (!ws) return notAuthorized();
      return json(200, {
        spaces: ws.spaces.map((s) => ({ id: s.id, name: s.name, private: false, statuses: s.statuses, multiple_assignees: true })),
      });
    }
    m = path.match(/^\/space\/([^/]+)\/(folder|list)$/);
    if (m) {
      const space = owner.workspaces.flatMap((w) => w.spaces).find((s) => s.id === m![1]);
      if (!space) return notAuthorized();
      const spaceRef = { id: space.id, name: space.name };
      if (m[2] === "folder") {
        return json(200, {
          folders: space.folders.map((f) => ({
            id: f.id,
            name: f.name,
            hidden: f.hidden,
            space: spaceRef,
            lists: f.lists.map((l) => listShape(l, spaceRef)),
          })),
        });
      }
      return json(200, { lists: space.folderlessLists.map((l) => listShape(l, spaceRef)) });
    }
    m = path.match(/^\/list\/([^/]+)\/field$/);
    if (m) {
      const ws = owner.workspaces.find((w) => m![1]! in w.fields);
      if (!ws) return json(404, { err: "List not found", ECODE: "ITEM_015" });
      return json(200, { fields: ws.fields[m[1]!] });
    }
    m = path.match(/^\/task\/([^/]+)$/);
    if (m) {
      const id = decodeURIComponent(m[1]!);
      const byCustomId = url.searchParams.get("custom_task_ids") === "true";
      const teamId = url.searchParams.get("team_id");
      if (byCustomId && !own(teamId ?? undefined)) return notAuthorized();
      const match = (t: FixtureTask) => (byCustomId ? t.custom_id === id : t.id === id);
      const found = allWorkspaces().flatMap((w) => w.tasks).find(match);
      if (!found) return json(404, { err: "Task not found, deleted", ECODE: "ITEM_013" });
      if (!own(found.team_id)) return notAuthorized();
      return json(200, url.searchParams.get("include_markdown_description") === "true" ? { ...found, markdown_description: found.description } : found);
    }
    m = path.match(/^\/list\/([^/]+)\/(task|member)$/);
    if (m) {
      const found = findList(m[1]!);
      if (!found) return json(404, { err: "List not found", ECODE: "ITEM_015" });
      if (!own(found.ws.id)) return notAuthorized();
      if (m[2] === "member") return json(200, { members: found.ws.listMembers?.[m[1]!] ?? found.ws.members });
      const after = Number(url.searchParams.get("date_created_gt") ?? 0);
      const page = Number(url.searchParams.get("page") ?? 0);
      const inList = found.ws.tasks.filter((t) => t.list.id === m![1] && Number(t.date_created) > after);
      const slice = inList.slice(page * TASK_PAGE_SIZE, (page + 1) * TASK_PAGE_SIZE);
      return json(200, { tasks: slice, last_page: (page + 1) * TASK_PAGE_SIZE >= inList.length });
    }
    m = path.match(/^\/team\/([^/]+)\/task$/);
    if (m) {
      const ws = own(m[1]);
      if (!ws) return notAuthorized();
      const page = Number(url.searchParams.get("page") ?? 0);
      const includeClosed = url.searchParams.get("include_closed") === "true";
      const visible = ws.tasks.filter((t) => includeClosed || t.status.type !== "closed");
      const slice = visible.slice(page * TASK_PAGE_SIZE, (page + 1) * TASK_PAGE_SIZE);
      return json(200, { tasks: slice, last_page: (page + 1) * TASK_PAGE_SIZE >= visible.length });
    }
    return json(404, { err: "Route not found", ECODE: "APP_001" });
  }

  return {
    fetch,
    requests,
    /** Answer the next request to `path` (without /api/v2) with this response instead. */
    respondOnce(path: string, response: CannedResponse) {
      queued.set(path, [...(queued.get(path) ?? []), response]);
    },
    /** The task as ClickUp now holds it, after any writes */
    task(id: string): FixtureTask | undefined {
      return findTask(id);
    },
    /** Tasks ClickUp holds in one list */
    tasksInList(listId: string): FixtureTask[] {
      return allWorkspaces().flatMap((w) => w.tasks).filter((t) => t.list.id === listId);
    },
    /** Replace a task (matched by ID) in whichever workspace holds it, e.g. to complete it remotely. */
    replaceTask(next: FixtureTask) {
      for (const ws of allWorkspaces()) {
        const i = ws.tasks.findIndex((t) => t.id === next.id);
        if (i >= 0) ws.tasks[i] = next;
      }
    },
    /** Revoke a token, as when it expires or is deleted in ClickUp. */
    revoke(token: string) {
      delete state[token];
    },
  };
}
