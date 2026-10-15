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
import { setSendPreviewHandler } from "@/services/ai/gateway";
import { listAiAuditLog } from "@/services/db/aiAuditLog";
import type { HistoryEntry } from "./ticketHistory";
import { draftTicketReply, summarizeTicket, type TicketAiSource } from "./ticketAi";
import { AiError } from "@/services/ai/errors";

// Fake personal data only
const CUSTOMER_EMAIL = "ada.fixture@example.test";
const CUSTOMER_PHONE = "+44 20 7946 0958";
const CARD = "4111 1111 1111 1111";
const NOTE_TEXT = "Internal: customer is on the legacy plan, do not offer refunds";
const SECRET = "sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKE";

function entry(over: Partial<HistoryEntry> & Pick<HistoryEntry, "id" | "kind">): HistoryEntry {
  return {
    visibility: "public",
    author: "Fixture Customer Ada",
    at: 1_760_000_000_000,
    bodyHtml: null,
    bodyText: "",
    attachments: [],
    ...over,
  };
}

function fixtureSource(extra: HistoryEntry[] = []): TicketAiSource {
  return {
    ticketId: "1001",
    subject: "Cannot sign in after password reset",
    status: "Open",
    priority: "High",
    entries: [
      entry({
        id: "request",
        kind: "request",
        bodyText: `Hi, I reset my password yesterday and now the sign-in link fails. Call me on ${CUSTOMER_PHONE} or write to ${CUSTOMER_EMAIL}. My card ${CARD} was charged twice too.`,
        attachments: [{ name: "screenshot-secret-board.png", contentType: "image/png", size: 2048, url: "https://files.example.test/a.png" }],
      }),
      entry({ id: "c1", kind: "internal_note", visibility: "internal", author: "Fixture Operator", bodyText: NOTE_TEXT }),
      entry({ id: "c2", kind: "reply", author: "Fixture Operator", bodyText: "I have resent the sign-in link. Can you tell me the time you tried?" }),
      entry({ id: "c3", kind: "customer_message", bodyText: `Tried again at 9:40, still failing. Here is my token: ${SECRET}` }),
      ...extra,
    ],
  };
}

const SUMMARY_JSON = JSON.stringify({
  issue: [{ text: "The customer cannot sign in after a password reset.", sources: [1] }],
  facts: [{ text: `The customer can be reached at ${"[EMAIL_1]"}.`, sources: [1] }],
  work_done: [{ text: "The agent resent the sign-in link.", sources: [2] }],
  blocker: [{ text: "The link still fails.", sources: [3] }],
  open_questions: [{ text: "Was the double charge refunded?", sources: [1] }],
  next_action: [{ text: "Check the sign-in logs for 9:40.", sources: [3] }],
});

async function approveClaude() {
  await setSetting("ai_provider", "claude");
  await setSetting("claude_api_key", "fake-claude-key");
  await setSetting("ai_approved_provider", "claude");
}

beforeEach(async () => {
  db = createSqliteTestDb();
  captured.length = 0;
  nextResponse = SUMMARY_JSON;
  await runMigrations();
  clearProviderClients();
  setSendPreviewHandler(async () => true);
  await approveClaude();
});

describe("summarizeTicket", () => {
  it("sends only allowlisted ticket content: no internal notes, attachments or contact details, secrets removed", async () => {
    await summarizeTicket(fixtureSource());

    expect(captured).toHaveLength(1);
    const sent = JSON.stringify(captured[0]);
    expect(sent).toContain("Cannot sign in after password reset");
    expect(sent).toContain("Open");
    expect(sent).toContain("High");
    expect(sent).toContain("I have resent the sign-in link");
    expect(sent).not.toContain(NOTE_TEXT);
    expect(sent).not.toContain("legacy plan");
    expect(sent).not.toContain("screenshot-secret-board");
    expect(sent).not.toContain("files.example.test");
    expect(sent).not.toContain(CUSTOMER_EMAIL);
    expect(sent).not.toContain("7946");
    expect(sent).not.toContain("4111");
    expect(sent).not.toContain(SECRET);
    expect(sent).not.toContain("Fixture Customer Ada");
    expect(sent).not.toContain("Fixture Operator");
  });

  it("returns the six sections with references to the source conversations, placeholders restored", async () => {
    const summary = await summarizeTicket(fixtureSource());

    expect(summary.issue[0]).toEqual({ text: "The customer cannot sign in after a password reset.", sources: ["request"] });
    expect(summary.facts[0]!.text).toBe(`The customer can be reached at ${CUSTOMER_EMAIL}.`);
    // Source 2 is the agent's reply: the internal note is not numbered, so it can never be cited
    expect(summary.workDone[0]!.sources).toEqual(["c2"]);
    expect(summary.blocker[0]!.sources).toEqual(["c3"]);
    expect(summary.openQuestions[0]!.text).toBe("Was the double charge refunded?");
    expect(summary.nextAction[0]!.sources).toEqual(["c3"]);
    const logged = await listAiAuditLog();
    expect(logged[0]).toMatchObject({ feature: "ticket_summary", provider: "claude" });
  });

  it("asks again only when the ticket's public content changes", async () => {
    await summarizeTicket(fixtureSource());
    await summarizeTicket(fixtureSource());
    expect(captured).toHaveLength(1);

    // An internal note is never sent, so it does not change what the summary rests on
    await summarizeTicket(fixtureSource([entry({ id: "c4", kind: "internal_note", visibility: "internal", bodyText: "Escalated" })]));
    expect(captured).toHaveLength(1);

    await summarizeTicket(fixtureSource([entry({ id: "c4", kind: "customer_message", bodyText: "It works now, thanks!" })]));
    expect(captured).toHaveLength(2);
    expect(JSON.stringify(captured[1])).toContain("It works now, thanks!");

    await summarizeTicket(fixtureSource(), { refresh: true });
    expect(captured).toHaveLength(3);
  });

  it("never restores a removed secret into the summary", async () => {
    nextResponse = SUMMARY_JSON.replace("The link still fails.", "The link fails; the customer shared [SECRET_REMOVED].");
    const summary = await summarizeTicket(fixtureSource());
    expect(JSON.stringify(summary)).not.toContain(SECRET);
    expect(summary.blocker[0]!.text).toContain("[SECRET_REMOVED]");
  });

  it("keeps the summary per helpdesk ticket", async () => {
    await summarizeTicket(fixtureSource());
    await summarizeTicket({ ...fixtureSource(), ticketId: "1002" });
    expect(captured).toHaveLength(2);
  });
});

describe("draftTicketReply", () => {
  beforeEach(() => {
    nextResponse = "<p>Thanks for trying again. Could you tell me which browser you use?</p>";
  });

  it("drafts in the friendly-professional tone by default from public content only", async () => {
    const html = await draftTicketReply(fixtureSource());

    expect(html).toBe("<p>Thanks for trying again. Could you tell me which browser you use?</p>");
    const sent = captured[0]!;
    expect(sent.userContent).toMatch(/Tone: friendly-professional/);
    expect(sent.systemPrompt).toMatch(/language of the customer's most recent message/);
    expect(sent.systemPrompt).toMatch(/clarifying question/);
    expect(sent.systemPrompt).toMatch(/Never invent fixes/);
    expect(JSON.stringify(sent)).not.toContain(NOTE_TEXT);
    expect(JSON.stringify(sent)).not.toContain("screenshot-secret-board");
    expect((await listAiAuditLog())[0]).toMatchObject({ feature: "ticket_reply" });
  });

  it("follows the tone switch", async () => {
    await draftTicketReply(fixtureSource(), { tone: "formal" });
    await draftTicketReply(fixtureSource(), { tone: "neutral" });
    expect(captured[0]!.userContent).toMatch(/Tone: formal/);
    expect(captured[1]!.userContent).toMatch(/Tone: neutral/);
  });

  it("rewrites or shortens the operator's own draft, with contact details as placeholders", async () => {
    await draftTicketReply(fixtureSource(), { action: "shorten", draftText: `Please call ${CUSTOMER_PHONE} back, I checked the logs.` });
    const sent = captured[0]!.userContent;
    expect(sent).toMatch(/Shorten/);
    expect(sent).toContain("I checked the logs.");
    expect(sent).not.toContain("7946");
  });

  it("refuses to send a draft holding a secret and sends nothing", async () => {
    const err = await draftTicketReply(fixtureSource(), { action: "rewrite", draftText: "Your new password: Hunter2Hunter2" }).catch((e) => e);
    expect(err).toBeInstanceOf(AiError);
    expect(err.code).toBe("SENSITIVE_DATA");
    expect(captured).toHaveLength(0);
  });

  it("strips anything active from the returned draft", async () => {
    nextResponse = '<p onclick="steal()">Hello</p><script>alert(1)</script>';
    const html = await draftTicketReply(fixtureSource());
    expect(html).not.toMatch(/script|onclick/);
    expect(html).toContain("Hello");
  });
});
