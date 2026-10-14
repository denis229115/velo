import { fetch } from "@tauri-apps/plugin-http";

export interface HelpdeskCredentials {
  host: string;
  apiKey: string;
}

export type FreshdeskErrorKind =
  | "auth"
  | "rate_limited"
  | "invalid_value"
  | "not_found"
  | "network"
  | "server";

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

function hasInvalidValue(body: unknown): boolean {
  const errors = (body as { errors?: { code?: string }[] } | null)?.errors;
  return Array.isArray(errors) && errors.some((e) => e.code === "invalid_value");
}

async function readBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** GET a Freshdesk API v2 path through the Tauri HTTP boundary. */
export async function freshdeskGet<T>(credentials: HelpdeskCredentials, path: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`https://${credentials.host}/api/v2${path}`, {
      method: "GET",
      headers: {
        Authorization: `Basic ${btoa(`${credentials.apiKey}:X`)}`,
        "Content-Type": "application/json",
      },
    });
  } catch {
    throw new FreshdeskError("network", `Could not reach ${credentials.host}.`);
  }

  const body = await readBody(response);
  if (response.ok) return body as T;

  const status = response.status;
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
  if (status === 400 && hasInvalidValue(body)) {
    throw new FreshdeskError("invalid_value", "Freshdesk did not accept a field value.", status);
  }
  if (status === 404) {
    throw new FreshdeskError("not_found", `${credentials.host} did not answer as a Freshdesk helpdesk.`, status);
  }
  throw new FreshdeskError("server", `Freshdesk answered with HTTP ${status}.`, status);
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
