import { createMockFetchResponse } from "@/test/mocks";
import type {
  FixtureConversation,
  FixtureTicket,
  FreshdeskFixtureTenant,
} from "@/services/freshdesk/__fixtures__/freshdeskFixtures";

export interface RecordedRequest {
  url: string;
  method: string;
  authorization: string | null;
  /** Parsed JSON body of a write, or a multipart body's fields with its files as `attachments` */
  body?: unknown;
  /** The Content-Type the caller set (null for multipart: the request itself adds the boundary) */
  contentType: string | null;
}

/** A multipart body as Freshdesk reads it: `name[]` fields become arrays, files become `attachments` */
function readMultipart(form: FormData): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  const attachments: { name: string; content_type: string; size: number }[] = [];
  for (const [key, value] of form.entries()) {
    if (typeof value !== "string") {
      attachments.push({ name: value.name, content_type: value.type, size: value.size });
    } else if (key.endsWith("[]")) {
      const name = key.slice(0, -2);
      fields[name] = [...((fields[name] as string[] | undefined) ?? []), value];
    } else {
      fields[key] = value;
    }
  }
  return attachments.length > 0 ? { ...fields, attachments } : fields;
}

interface CannedResponse {
  /** Only answer this page of a paginated path */
  page?: number;
  /** Only answer this method (default: any) */
  method?: string;
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** The connection drops before an answer arrives */
  networkError?: boolean;
  /** Apply the write to the fixture helpdesk before answering (a write accepted but unanswered) */
  apply?: boolean;
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
  // Writes land in the stub's own overlay, never in the shared fixtures (tests may still edit those)
  const written = new Map<string, Partial<FixtureTicket>>();
  const ticketsOf = (host: string): FixtureTicket[] =>
    (helpdesks[host]?.tenant.tickets ?? []).map((t) => ({ ...t, ...written.get(`${host}/${t.id}`) }));
  // Replies and notes posted through the stub, after the fixture's own conversations
  const posted = new Map<string, FixtureConversation[]>();
  let nextConversationId = 8_000_000_001;
  const conversationsOf = (host: string, ticketId: number): FixtureConversation[] => [
    ...(helpdesks[host]?.tenant.conversations?.[ticketId] ?? []),
    ...(posted.get(`${host}/${ticketId}`) ?? []),
  ];
  const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  function applyPost(host: string, ticketId: number, kind: string, body: Record<string, unknown>): FixtureConversation | null {
    const found = ticketsOf(host).find((t) => t.id === ticketId);
    if (!found) return null;
    const html = typeof body.body === "string" ? body.body : "";
    const me = helpdesks[host]?.tenant.me as { id: number } | undefined;
    const at = nowIso();
    const conversation: FixtureConversation = {
      id: nextConversationId++,
      body: html,
      body_text: html.replace(/<[^>]+>/g, ""),
      incoming: false,
      private: kind === "notes" ? body.private !== false && body.private !== "false" : false,
      user_id: me?.id ?? 0,
      source: kind === "notes" ? 2 : 0,
      ticket_id: ticketId,
      support_email: null,
      from_email: null,
      to_emails: [],
      cc_emails: Array.isArray(body.cc_emails) ? (body.cc_emails as string[]) : [],
      bcc_emails: [],
      attachments: Array.isArray(body.attachments)
        ? (body.attachments as { name: string; content_type: string; size: number }[]).map((a, i) => ({
            id: 9_000_000_000 + nextConversationId * 10 + i,
            name: a.name,
            content_type: a.content_type,
            size: a.size,
            attachment_url: `https://${host}/fixture-attachments/${encodeURIComponent(a.name)}`,
          }))
        : [],
      automation_id: null,
      automation_type_id: null,
      created_at: at,
      updated_at: at,
    };
    posted.set(`${host}/${ticketId}`, [...(posted.get(`${host}/${ticketId}`) ?? []), conversation]);
    written.set(`${host}/${ticketId}`, { ...written.get(`${host}/${ticketId}`), updated_at: at });
    return conversation;
  }

  function applyWrite(host: string, ticketId: number, body: Record<string, unknown>): FixtureTicket | null {
    const found = ticketsOf(host).find((t) => t.id === ticketId);
    if (!found) return null;
    const changes: Partial<FixtureTicket> = { updated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") };
    for (const key of ["status", "priority", "responder_id"] as const) if (key in body) Object.assign(changes, { [key]: body[key] });
    written.set(`${host}/${ticketId}`, { ...written.get(`${host}/${ticketId}`), ...changes });
    return { ...found, ...changes };
  }

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
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : init?.body instanceof FormData
          ? readMultipart(init.body)
          : undefined;
    requests.push({ url: url.href, method, authorization, contentType: headers.get("content-type"), ...(body !== undefined && { body }) });

    const pending = queued.get(`${url.host}${url.pathname}`) ?? [];
    const cannedIndex = pending.findIndex(
      (c) =>
        (c.method === undefined || c.method === method) &&
        (c.page === undefined || c.page === Number(url.searchParams.get("page") ?? 1)),
    );
    if (cannedIndex >= 0) {
      const [canned] = pending.splice(cannedIndex, 1);
      const writeMatch = url.pathname.match(/^\/api\/v2\/tickets\/(\d+)$/);
      if (canned!.apply && writeMatch && body) applyWrite(url.host, Number(writeMatch[1]), body);
      const postMatch = url.pathname.match(/^\/api\/v2\/tickets\/(\d+)\/(reply|notes)$/);
      if (canned!.apply && postMatch && body) applyPost(url.host, Number(postMatch[1]), postMatch[2]!, body);
      if (canned!.networkError) throw new TypeError("fixture: connection dropped");
      return json(canned!.status ?? 200, canned!.body, canned!.headers);
    }

    const helpdesk = helpdesks[url.host];
    if (!helpdesk) throw new TypeError(`fixture: no helpdesk at ${url.host}`);
    if (authorization !== `Basic ${btoa(`${helpdesk.apiKey}:X`)}`) {
      return json(401, { code: "invalid_credentials", message: "You have to be logged in to perform this action." });
    }

    const { tenant } = helpdesk;
    const tickets = ticketsOf(url.host);
    const withRequester = (t: FixtureTicket) =>
      url.searchParams.get("include") === "requester"
        ? { ...t, requester: tenant.contacts?.find((c) => c.id === t.requester_id) ?? null }
        : t;

    const ticketMatch = url.pathname.match(/^\/api\/v2\/tickets\/(\d+)$/);
    if (ticketMatch && method === "PUT") {
      const updated = applyWrite(url.host, Number(ticketMatch[1]), body ?? {});
      return updated ? json(200, updated) : json(404, { code: "not_found" });
    }
    if (ticketMatch) {
      const found = tickets.find((t) => t.id === Number(ticketMatch[1]));
      return found ? json(200, withRequester(found)) : json(404, { code: "not_found" });
    }
    const postMatch = url.pathname.match(/^\/api\/v2\/tickets\/(\d+)\/(reply|notes)$/);
    if (postMatch && method === "POST") {
      const created = applyPost(url.host, Number(postMatch[1]), postMatch[2]!, body ?? {});
      return created ? json(201, created) : json(404, { code: "not_found" });
    }
    const conversationsMatch = url.pathname.match(/^\/api\/v2\/tickets\/(\d+)\/conversations$/);
    if (conversationsMatch) {
      const id = Number(conversationsMatch[1]);
      if (!tickets.some((t) => t.id === id)) return json(404, { code: "not_found" });
      return json(200, page(conversationsOf(url.host, id), url));
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
    /** A colleague or the customer writes on a ticket meanwhile (bumps its updated_at) */
    addConversation(host: string, ticketId: number, conversation: Partial<FixtureConversation> & { user_id: number; body: string }) {
      const at = nowIso();
      const added: FixtureConversation = {
        id: nextConversationId++,
        body_text: conversation.body.replace(/<[^>]+>/g, ""),
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
        ...conversation,
      };
      posted.set(`${host}/${ticketId}`, [...(posted.get(`${host}/${ticketId}`) ?? []), added]);
      written.set(`${host}/${ticketId}`, { ...written.get(`${host}/${ticketId}`), updated_at: at });
    },
    /** Change a ticket in the helpdesk behind Velo's back (e.g. a colleague reassigns it) */
    editTicket(host: string, ticketId: number, changes: Partial<FixtureTicket>) {
      written.set(`${host}/${ticketId}`, { ...written.get(`${host}/${ticketId}`), ...changes, updated_at: nowIso() });
    },
    /** Answer the next request to `host + path` (or to one page or method of it) with this response instead. */
    respondOnce(host: string, path: string, response: CannedResponse) {
      const key = `${host}${path}`;
      queued.set(key, [...(queued.get(key) ?? []), response]);
    },
  };
}
