import { createMockFetchResponse } from "@/test/mocks";
import type { FreshdeskFixtureTenant } from "@/services/freshdesk/__fixtures__/freshdeskFixtures";

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

  function page(items: unknown[], url: URL) {
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
    switch (url.pathname) {
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
