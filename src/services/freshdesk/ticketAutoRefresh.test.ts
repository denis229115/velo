import { describe, it, expect, beforeEach, vi } from "vitest";
import { createSqliteTestDb, type SqliteTestDb } from "@/test/sqliteTestDb";
import type { AiCompletionRequest } from "@/services/ai/types";

// ── A fake Claude client at the provider-client interface: nothing leaves the machine ──
const captured: AiCompletionRequest[] = [];
let nextResponse: string | Error = "";

vi.mock("@/services/ai/providers/claudeProvider", () => ({
  createClaudeProvider: vi.fn(() => ({
    async complete(request: AiCompletionRequest): Promise<string> {
      captured.push(request);
      if (nextResponse instanceof Error) throw nextResponse;
      return nextResponse;
    },
    async testConnection() {
      return true;
    },
  })),
  clearClaudeProvider: vi.fn(),
}));

let db: SqliteTestDb;
vi.mock("@tauri-apps/plugin-sql", () => ({
  default: {
    load: vi.fn(async () => ({
      select: (sql: string, params?: unknown[]) => db.select(sql, params),
      execute: (sql: string, params?: unknown[]) => db.execute(sql, params),
    })),
  },
}));

import { runMigrations } from "@/services/db/migrations";
import { setSetting } from "@/services/db/settings";
import { clearProviderClients } from "@/services/ai/providerManager";
import { previewNextRequest, setSendPreviewHandler } from "@/services/ai/gateway";
import { listAiAuditLog } from "@/services/db/aiAuditLog";
import { AiError } from "@/services/ai/errors";
import type { HistoryEntry } from "./ticketHistory";
import { publicActivityKey, summarizeTicket, type TicketAiSource } from "./ticketAi";

// Fake personal data only
const CUSTOMER_EMAIL = "grace.fixture@example.test";
const CUSTOMER_PHONE = "+44 20 7946 0999";
const CARD = "4111 1111 1111 1111";
const NOTE_TEXT = "Internal: this customer is on the legacy plan, no refunds";

function entry(over: Partial<HistoryEntry> & Pick<HistoryEntry, "id" | "kind">): HistoryEntry {
  return {
    visibility: "public",
    author: "Fixture Customer Grace",
    at: 1_760_000_000_000,
    bodyHtml: null,
    bodyText: "",
    attachments: [],
    ...over,
  };
}

function source(extra: HistoryEntry[] = []): TicketAiSource {
  return {
    ticketId: "2001",
    subject: "Invoice shows the wrong plan",
    status: "Open",
    priority: "Medium",
    entries: [
      entry({ id: "request", kind: "request", bodyText: "My invoice lists the wrong plan." }),
      entry({ id: "c1", kind: "reply", author: "Fixture Operator", bodyText: "Which plan should it show?" }),
      ...extra,
    ],
  };
}

const NEW_MESSAGE = entry({
  id: "c2",
  kind: "customer_message",
  bodyText: `The Team plan. Call ${CUSTOMER_PHONE} or write ${CUSTOMER_EMAIL}; card ${CARD} was charged.`,
});

const SUMMARY_JSON = JSON.stringify({
  issue: [{ text: "The invoice shows the wrong plan.", sources: [1] }],
  facts: [],
  work_done: [],
  blocker: [],
  open_questions: [],
  next_action: [{ text: "Correct the invoice.", sources: [2] }],
});

beforeEach(async () => {
  db = createSqliteTestDb();
  captured.length = 0;
  nextResponse = SUMMARY_JSON;
  await runMigrations();
  clearProviderClients();
  setSendPreviewHandler(async () => true);
  await setSetting("ai_provider", "claude");
  await setSetting("claude_api_key", "fake-claude-key");
  await setSetting("ai_approved_provider", "claude");
});

describe("an unattended (automatic) summary refresh through the gateway", () => {
  it("sends like a manual summary: allowlisted fields with roles, placeholders, an audit row, and fake personal data never leaves", async () => {
    await summarizeTicket(source()); // the operator's first, previewed summary
    const handler = vi.fn(async () => true);
    setSendPreviewHandler(handler);

    await summarizeTicket(source([NEW_MESSAGE]), { unattended: true }).catch(() => undefined);
    // The new message carries email, phone and card data: kinds not previewed before, so nothing was sent yet
    expect(captured).toHaveLength(1);

    // Same kinds already previewed: a message without new kinds goes out silently
    await summarizeTicket(source([entry({ id: "c3", kind: "customer_message", bodyText: "Any news on this?" })]), { unattended: true });
    expect(captured).toHaveLength(2);
    const sent = JSON.stringify(captured[1]);
    expect(sent).toContain("From: customer");
    expect(sent).toContain("From: agent");
    expect(sent).toContain("Any news on this?");
    expect(sent).not.toContain("Fixture Customer Grace");
    expect(sent).not.toContain("Fixture Operator");
    expect(handler).not.toHaveBeenCalled();
    const audit = await listAiAuditLog();
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({ feature: "ticket_summary", provider: "claude" });
  });

  it("does not send a request that needs the first-use preview, and opens no dialog", async () => {
    const handler = vi.fn(async () => true);
    setSendPreviewHandler(handler);

    const err = await summarizeTicket(source(), { unattended: true }).catch((e) => e);

    expect(err).toBeInstanceOf(AiError);
    expect(err.code).toBe("PREVIEW_REQUIRED");
    expect(captured).toHaveLength(0);
    expect(handler).not.toHaveBeenCalled();
    expect(await listAiAuditLog()).toHaveLength(0);
  });

  it("does not send a request that carries a data kind the operator has not previewed, and keeps contact details out", async () => {
    await summarizeTicket(source());
    const handler = vi.fn(async () => true);
    setSendPreviewHandler(handler);

    const err = await summarizeTicket(source([NEW_MESSAGE]), { unattended: true }).catch((e) => e);

    expect(err.code).toBe("PREVIEW_REQUIRED");
    expect(captured).toHaveLength(1);
    expect(JSON.stringify(captured)).not.toContain(CUSTOMER_EMAIL);
    expect(handler).not.toHaveBeenCalled();
  });

  it("leaves a preview the operator asked for to their next manual summary", async () => {
    await summarizeTicket(source());
    previewNextRequest(["ticket_summary"]);
    const handler = vi.fn(async () => true);
    setSendPreviewHandler(handler);

    const err = await summarizeTicket(source([entry({ id: "c3", kind: "customer_message", bodyText: "Any news?" })]), { unattended: true }).catch((e) => e);
    expect(err.code).toBe("PREVIEW_REQUIRED");
    expect(captured).toHaveLength(1);

    await summarizeTicket(source([entry({ id: "c3", kind: "customer_message", bodyText: "Any news?" })]));
    expect(handler).toHaveBeenCalledOnce();
    expect(captured).toHaveLength(2);
  });

  it("never sends an internal note", async () => {
    await summarizeTicket(source());
    const withNote = source([entry({ id: "c3", kind: "internal_note", visibility: "internal", author: "Fixture Operator", bodyText: NOTE_TEXT })]);
    await summarizeTicket(withNote, { unattended: true });
    // Nothing new reached the model, so the cached summary answers and no request leaves
    expect(captured).toHaveLength(1);
    expect(JSON.stringify(captured)).not.toContain("legacy plan");
  });
});

describe("publicActivityKey", () => {
  it("changes with a new public message and not with an internal note", () => {
    const base = publicActivityKey(source());
    const note = entry({ id: "c3", kind: "internal_note", visibility: "internal", bodyText: NOTE_TEXT });
    expect(publicActivityKey(source([note]))).toBe(base);
    expect(publicActivityKey(source([NEW_MESSAGE]))).not.toBe(base);
  });
});
