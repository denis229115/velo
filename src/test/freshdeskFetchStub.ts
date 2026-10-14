import { createMockFetchResponse } from "@/test/mocks";
import type { FixtureTicket, FreshdeskFixtureTenant } from "@/services/freshdesk/__fixtures__/freshdeskFixtures";

export interface RecordedRequest {
  url: string;
  method: string;
  authorization: string | null;
}

interface CannedResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/**
 * Stands in for the Tauri HTTP fetch boundary with fixture helpdesks.
 * Each host answers only to its own API key (Basic auth, `key:X`).
 */
export function createFreshdeskFetchStub(
  helpdesks: Record<string, { apiKey: string; tenant: FreshdeskFixtureTenant }>,
) {
  const requests: RecordedRequest[] = [];
  const queued = new Map<string, CannedResponse[]>();

  function json(status: number, body: unknown, headers?: Record<string, string>) {
    return createMockFetchResponse({
      status,
      data: body,
      text: JSON.stringify(body),
      headers: { "content-type": "application/json", ...headers },
    });
  }

  function page<T>(items: T[], url: URL): T[] {
    const perPage = Number(url.searchParams.get("per_page") ?? 30);
    const pageNo = Number(url.searchParams.get("page") ?? 1);
    return items.slice((pageNo - 1) * perPage, pageNo * perPage);
  }

  async function fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    const authorization = headers.get("authorization");
    requests.push({ url: url.href, method: init?.method ?? "GET", authorization });

    const canned = queued.get(`${url.host}${url.pathname}`)?.shift();
    if (canned) return json(canned.status, canned.body, canned.headers);

    const helpdesk = helpdesks[url.host];
    if (!helpdesk) throw new TypeError(`fixture: no helpdesk at ${url.host}`);
    if (authorization !== `Basic ${btoa(`${helpdesk.apiKey}:X`)}`) {
      return json(401, { code: "invalid_credentials", message: "You have to be logged in to perform this action." });
    }

    const { tenant } = helpdesk;
    const tickets = tenant.tickets ?? [];
    const withRequester = (t: FixtureTicket) =>
      url.searchParams.get("include") === "requester"
        ? { ...t, requester: tenant.contacts?.find((c) => c.id === t.requester_id) ?? null }
        : t;

    const ticketMatch = url.pathname.match(/^\/api\/v2\/tickets\/(\d+)$/);
    if (ticketMatch) {
      const found = tickets.find((t) => t.id === Number(ticketMatch[1]));
      return found ? json(200, withRequester(found)) : json(404, { code: "not_found" });
    }
    const contactMatch = url.pathname.match(/^\/api\/v2\/contacts\/(\d+)$/);
    if (contactMatch) {
      const found = tenant.contacts?.find((c) => c.id === Number(contactMatch[1]));
      return found ? json(200, found) : json(404, { code: "not_found" });
    }

    switch (url.pathname) {
      case "/api/v2/tickets": {
        // Freshdesk returns only tickets created in the last 30 days unless updated_since is given
        const since = url.searchParams.get("updated_since");
        const floor = since ? Date.parse(since) : Date.now() - 30 * 86_400_000;
        const field = since ? "updated_at" : "created_at";
        const desc = url.searchParams.get("order_type") !== "asc";
        const orderBy = url.searchParams.get("order_by") ?? "created_at";
        const matching = tickets
          .filter((t) => Date.parse(t[field]) >= floor)
          .sort((a, b) => {
            const diff = Date.parse(String(a[orderBy])) - Date.parse(String(b[orderBy]));
            return desc ? -diff : diff;
          });
        return json(200, page(matching, url).map(withRequester));
      }
      case "/api/v2/search/tickets": {
        // Search: quoted query, 30 results per page, at most 10 pages
        const query = url.searchParams.get("query") ?? "";
        const pageNo = Number(url.searchParams.get("page") ?? 1);
        if (!/^".*"$/.test(query) || pageNo > 10) return json(400, { description: "Validation failed", errors: [{ field: "query", code: "invalid_value" }] });
        const statuses = [...query.matchAll(/status:(\d+)/g)].map((m) => Number(m[1]));
        const matching = tickets.filter((t) => statuses.includes(t.status));
        return json(200, { results: matching.slice((pageNo - 1) * 30, pageNo * 30), total: matching.length });
      }
      case "/api/v2/agents/me":
        return json(200, tenant.me);
      case "/api/v2/ticket_fields":
        return json(200, tenant.ticketFields);
      case "/api/v2/agents":
        return json(200, page(tenant.agents, url));
      case "/api/v2/groups":
        return json(200, page(tenant.groups, url));
      default:
        return json(404, { code: "not_found" });
    }
  }

  return {
    fetch,
    requests,
    /** Answer the next request to `host + path` with this response instead. */
    respondOnce(host: string, path: string, response: CannedResponse) {
      const key = `${host}${path}`;
      queued.set(key, [...(queued.get(key) ?? []), response]);
    },
  };
}
