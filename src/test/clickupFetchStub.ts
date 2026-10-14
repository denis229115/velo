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
}

interface CannedResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
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
      { user: t.user, workspaces: t.workspaces.map((w) => ({ ...w, tasks: [...w.tasks] })) },
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

  async function fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    const authorization = headers.get("authorization");
    const path = url.pathname.replace(/^\/api\/v2/, "");
    requests.push({ url: url.href, path, method: init?.method ?? "GET", authorization });

    if (url.host !== "api.clickup.com") throw new TypeError(`fixture: unexpected host ${url.host}`);

    const pending = queued.get(path) ?? [];
    const canned = pending.shift();
    if (canned) return json(canned.status, canned.body, canned.headers);

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
      return json(200, found);
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
