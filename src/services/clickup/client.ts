import { fetch } from "@tauri-apps/plugin-http";

const API_BASE = "https://api.clickup.com/api/v2";

export type ClickUpErrorKind =
  | "auth"
  | "rate_limited"
  | "not_found"
  | "not_in_workspace"
  | "network"
  /** ClickUp refused the write (a 400 with its own reason) */
  | "rejected"
  | "server";

/**
 * A failed ClickUp call. Messages never include the API token or the
 * Authorization header.
 */
export class ClickUpError extends Error {
  constructor(
    readonly kind: ClickUpErrorKind,
    message: string,
    readonly status?: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ClickUpError";
  }
}

// ClickUp's documented error codes: a missing, revoked or invalid token...
const TOKEN_ECODES = new Set(["OAUTH_017", "OAUTH_019", "OAUTH_021", "OAUTH_025", "OAUTH_077"]);
// ...and a workspace (team) the token is not authorised for
const WORKSPACE_ECODES = new Set(["OAUTH_023", "OAUTH_026", "OAUTH_027", ...Array.from({ length: 17 }, (_, i) => `OAUTH_0${29 + i}`)]);

async function readBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** Seconds until ClickUp accepts requests again: Retry-After, else X-RateLimit-Reset (a unix timestamp). */
function retryAfterSeconds(response: Response): number | undefined {
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.ceil(retryAfter);
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) {
    const wait = Math.ceil(reset - Date.now() / 1000);
    if (wait > 0) return wait;
  }
  return undefined;
}

/** How long a write waits for ClickUp's answer before its outcome counts as unknown */
const WRITE_TIMEOUT_MS = 30_000;

/** GET a ClickUp API v2 path through the Tauri HTTP boundary. */
export function clickupGet<T>(token: string, path: string): Promise<T> {
  return clickupRequest<T>(token, "GET", path);
}

/**
 * A write to ClickUp: a remote write, never retried here. A `network` error
 * means the outcome is unknown (the write may have landed).
 */
export function clickupWrite<T>(token: string, method: "POST" | "PUT", path: string, payload: unknown): Promise<T> {
  return clickupRequest<T>(token, method, path, payload);
}

async function clickupRequest<T>(token: string, method: "GET" | "POST" | "PUT", path: string, payload?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers: { Authorization: token, "Content-Type": "application/json" },
      ...(payload !== undefined && { body: JSON.stringify(payload), signal: AbortSignal.timeout(WRITE_TIMEOUT_MS) }),
    });
  } catch {
    throw new ClickUpError("network", "Could not reach ClickUp.");
  }

  const body = await readBody(response);
  if (response.ok) return body as T;

  const status = response.status;
  const ecode = (body as { ECODE?: unknown } | null)?.ECODE;
  if (status === 429) {
    throw new ClickUpError(
      "rate_limited",
      "ClickUp is rate limiting requests. Velo will try again later.",
      status,
      retryAfterSeconds(response),
    );
  }
  if (typeof ecode === "string" && WORKSPACE_ECODES.has(ecode)) {
    throw new ClickUpError("not_in_workspace", "That is not in the connected ClickUp workspace.", status);
  }
  if (status === 401 || (typeof ecode === "string" && TOKEN_ECODES.has(ecode))) {
    throw new ClickUpError("auth", "ClickUp rejected the API token. Check it and connect again.", status);
  }
  if (status === 404 || (typeof ecode === "string" && ecode.startsWith("ITEM_"))) {
    throw new ClickUpError("not_found", "ClickUp has no such item.", status);
  }
  if (status === 400) {
    const err = (body as { err?: unknown } | null)?.err;
    const reason = typeof err === "string" && err ? `: ${err.replace(/[\u0000-\u001f]/g, "").slice(0, 200)}` : "";
    throw new ClickUpError("rejected", `ClickUp did not accept the change${reason}.`, status);
  }
  throw new ClickUpError("server", `ClickUp answered with HTTP ${status}.`, status);
}
