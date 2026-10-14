import { fetch } from "@tauri-apps/plugin-http";

export interface HelpdeskCredentials {
  host: string;
  apiKey: string;
}

export type FreshdeskErrorKind =
  | "auth"
  | "rate_limited"
  | "invalid_value"
  | "validation"
  | "permission"
  | "not_found"
  | "network"
  | "server";

/** One entry of Freshdesk's `errors` array on a 400 */
export interface FreshdeskFieldError {
  field: string;
  code: string;
  message: string;
}

/**
 * A failed Freshdesk call. Messages never include the API key or the
 * Authorization header.
 */
export class FreshdeskError extends Error {
  constructor(
    readonly kind: FreshdeskErrorKind,
    message: string,
    readonly status?: number,
    readonly retryAfterSeconds?: number,
    /** Freshdesk's own reason: its field errors on a 400, its message on a refused write */
    readonly detail?: { fieldErrors: FreshdeskFieldError[]; message: string | null },
  ) {
    super(message);
    this.name = "FreshdeskError";
  }
}

const HOST_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Turns what the operator typed ("acme", "acme.freshdesk.com",
 * "https://acme.freshdesk.com/") into a bare helpdesk host.
 */
export function normalizeHelpdeskHost(input: string): string {
  let host = input.trim().toLowerCase();
  host = host.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (host && !host.includes(".")) host = `${host}.freshdesk.com`;
  if (!HOST_PATTERN.test(host)) {
    throw new FreshdeskError("not_found", "Enter your helpdesk address, for example yourcompany.freshdesk.com.");
  }
  return host;
}

function fieldErrors(body: unknown): FreshdeskFieldError[] {
  const errors = (body as { errors?: unknown } | null)?.errors;
  if (!Array.isArray(errors)) return [];
  return errors.map((e: Record<string, unknown>) => ({
    field: typeof e?.field === "string" ? e.field : "",
    code: typeof e?.code === "string" ? e.code : "",
    message: typeof e?.message === "string" ? e.message : "",
  }));
}

function bodyMessage(body: unknown): string | null {
  const message = (body as { message?: unknown } | null)?.message;
  return typeof message === "string" && message ? message : null;
}

async function readBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function freshdeskRequest<T>(
  credentials: HelpdeskCredentials,
  method: "GET" | "PUT" | "POST",
  path: string,
  payload?: unknown,
  timeoutMs?: number,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`https://${credentials.host}/api/v2${path}`, {
      method,
      headers: {
        Authorization: `Basic ${btoa(`${credentials.apiKey}:X`)}`,
        "Content-Type": "application/json",
      },
      ...(payload !== undefined && { body: JSON.stringify(payload) }),
      ...(timeoutMs !== undefined && { signal: AbortSignal.timeout(timeoutMs) }),
    });
  } catch {
    throw new FreshdeskError("network", `Could not reach ${credentials.host}.`);
  }

  const body = await readBody(response);
  if (response.ok) return body as T;

  const status = response.status;
  const detail = { fieldErrors: fieldErrors(body), message: bodyMessage(body) };
  // A refused write is about the agent's permissions, not the API key, once the key itself works
  if (status === 403 && method !== "GET") {
    throw new FreshdeskError("permission", "Freshdesk did not allow this change.", status, undefined, detail);
  }
  if (status === 401 || status === 403) {
    throw new FreshdeskError("auth", "Freshdesk rejected the API key. Check it and connect again.", status);
  }
  if (status === 429) {
    const retryAfter = Number(response.headers.get("retry-after"));
    throw new FreshdeskError(
      "rate_limited",
      "Freshdesk is rate limiting requests. Velo will try again later.",
      status,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    );
  }
  if (status === 400 && detail.fieldErrors.some((e) => e.code === "invalid_value")) {
    throw new FreshdeskError("invalid_value", "Freshdesk did not accept a field value.", status, undefined, detail);
  }
  if (status === 400 && detail.fieldErrors.length > 0) {
    throw new FreshdeskError("validation", "Freshdesk did not accept the change.", status, undefined, detail);
  }
  if (status === 404) {
    throw new FreshdeskError("not_found", `${credentials.host} did not answer as a Freshdesk helpdesk.`, status);
  }
  throw new FreshdeskError("server", `Freshdesk answered with HTTP ${status}.`, status);
}

/** GET a Freshdesk API v2 path through the Tauri HTTP boundary. */
export function freshdeskGet<T>(credentials: HelpdeskCredentials, path: string): Promise<T> {
  return freshdeskRequest<T>(credentials, "GET", path);
}

/** PUT to a Freshdesk API v2 path: a remote write. Never retried here. */
export function freshdeskPut<T>(credentials: HelpdeskCredentials, path: string, payload: unknown): Promise<T> {
  return freshdeskRequest<T>(credentials, "PUT", path, payload);
}

/** How long a send waits for Freshdesk's answer before its outcome counts as unconfirmed */
const POST_TIMEOUT_MS = 30_000;

/**
 * POST to a Freshdesk API v2 path: a remote write. Never retried here; a
 * `network` error means the outcome is unknown (the write may have landed).
 */
export function freshdeskPost<T>(credentials: HelpdeskCredentials, path: string, payload: unknown): Promise<T> {
  return freshdeskRequest<T>(credentials, "POST", path, payload, POST_TIMEOUT_MS);
}

const PAGE_SIZE = 100;
const MAX_PAGES = 50;

/** GET every page of a list endpoint (bounded). */
export async function freshdeskGetAll<T>(credentials: HelpdeskCredentials, path: string): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = await freshdeskGet<T[]>(credentials, `${path}?per_page=${PAGE_SIZE}&page=${page}`);
    items.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return items;
}
