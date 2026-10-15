/**
 * Ticket AI: the Ticket summary and AI drafts for the ticket composer.
 *
 * Every request goes through the AI gateway. Only allowlisted fields leave
 * Velo: the subject, status and priority, and the text of public messages
 * (with who wrote them as customer, agent or automated, never a name).
 * Internal notes and attachments are never part of a request. Results are
 * shown to the operator only; nothing here writes to Freshdesk or sends.
 */
import { requestAi, type AiSourceItem } from "@/services/ai/gateway";
import { TICKET_REPLY_PROMPT, TICKET_SUMMARY_PROMPT } from "@/services/ai/prompts";
import type { EntryKind, HistoryEntry } from "./ticketHistory";
import { currentTenantId } from "./connection";
import { sanitizeHtml } from "@/utils/sanitize";

/** What Ticket AI reads from a ticket; the history may hold internal notes, which are dropped here */
export interface TicketAiSource {
  ticketId: string;
  subject: string;
  /** Freshdesk's status label, null when not known */
  status: string | null;
  priority: string | null;
  /** Oldest first, the original request first */
  entries: HistoryEntry[];
}

/** Room for the ticket's messages in one request */
const MAX_CHARS = 12000;

const ROLE: Record<EntryKind, string> = {
  request: "customer",
  customer_message: "customer",
  unverified_reply: "agent",
  reply: "agent",
  public_note: "agent",
  incoming_from_agent: "agent",
  logged_interaction: "agent",
  automated_reply: "automated",
  internal_note: "agent",
};

function textOf(entry: HistoryEntry): string {
  if (entry.bodyText?.trim()) return entry.bodyText.trim();
  if (!entry.bodyHtml) return "";
  return (new DOMParser().parseFromString(entry.bodyHtml, "text/html").body.textContent ?? "").trim();
}

/**
 * The public messages that fit one request: always the original request, then
 * the latest messages that fit, oldest first. Internal notes never qualify.
 */
function publicEntries(source: TicketAiSource): { entry: HistoryEntry; text: string }[] {
  const all = source.entries
    .filter((e) => e.visibility === "public" && e.kind !== "internal_note")
    .map((entry) => ({ entry, text: textOf(entry) }))
    .filter((e) => e.text.length > 0);
  const [first, ...rest] = all;
  if (!first) return [];
  let used = first.text.length;
  const kept: typeof all = [];
  for (const e of [...rest].reverse()) {
    if (used + e.text.length > MAX_CHARS * 0.85) break;
    used += e.text.length;
    kept.unshift(e);
  }
  return [first, ...kept];
}

/**
 * What the public conversation looks like to Ticket AI. It changes when a
 * public message arrives and never for an internal note, so it tells a summary
 * that new activity has made it out of date.
 */
export function publicActivityKey(source: TicketAiSource): string {
  return publicEntries(source)
    .map(({ entry, text }) => `${entry.id}:${text}`)
    .join("\u0000");
}

function toItems(source: TicketAiSource, picked: { entry: HistoryEntry; text: string }[]): AiSourceItem[] {
  return picked.map(({ entry, text }, i) => ({
    ...(i === 0 && { subject: source.subject, status: source.status, priority: source.priority }),
    body: `From: ${ROLE[entry.kind]}\n${text}`,
  }));
}

// ---------- Ticket summary ----------

export interface SummaryPoint {
  text: string;
  /** IDs of the history entries the point rests on ("request" or a conversation ID) */
  sources: string[];
}

export interface TicketSummary {
  issue: SummaryPoint[];
  facts: SummaryPoint[];
  workDone: SummaryPoint[];
  blocker: SummaryPoint[];
  openQuestions: SummaryPoint[];
  nextAction: SummaryPoint[];
}

export const SUMMARY_SECTIONS: { key: keyof TicketSummary; label: string }[] = [
  { key: "issue", label: "Issue" },
  { key: "facts", label: "Relevant facts" },
  { key: "workDone", label: "Work done" },
  { key: "blocker", label: "Current blocker" },
  { key: "openQuestions", label: "Unanswered questions" },
  { key: "nextAction", label: "Next action" },
];

const JSON_KEYS: Record<keyof TicketSummary, string> = {
  issue: "issue",
  facts: "facts",
  workDone: "work_done",
  blocker: "blocker",
  openQuestions: "open_questions",
  nextAction: "next_action",
};

/** The summary came back in a shape Velo cannot show */
export class TicketSummaryFormatError extends Error {
  constructor() {
    super("The summary came back in a form Velo could not read. Try again.");
    this.name = "TicketSummaryFormatError";
  }
}

function parseSummary(raw: string, sourceIds: string[]): TicketSummary {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new TicketSummaryFormatError();
  }
  if (!parsed || typeof parsed !== "object") throw new TicketSummaryFormatError();
  const obj = parsed as Record<string, unknown>;
  const points = (value: unknown): SummaryPoint[] => {
    if (!Array.isArray(value)) return [];
    return value.flatMap((p): SummaryPoint[] => {
      if (typeof p === "string") return p.trim() ? [{ text: p.trim(), sources: [] }] : [];
      if (!p || typeof p !== "object") return [];
      const { text, sources } = p as { text?: unknown; sources?: unknown };
      if (typeof text !== "string" || !text.trim()) return [];
      // Only numbers that name a source item sent in this request become references
      const ids = Array.isArray(sources)
        ? [...new Set(sources.flatMap((n) => (typeof n === "number" && sourceIds[n - 1] ? [sourceIds[n - 1]!] : [])))]
        : [];
      return [{ text: text.trim(), sources: ids }];
    });
  };
  const summary = Object.fromEntries(
    SUMMARY_SECTIONS.map(({ key }) => [key, points(obj[JSON_KEYS[key]])]),
  ) as unknown as TicketSummary;
  if (SUMMARY_SECTIONS.every(({ key }) => summary[key].length === 0)) throw new TicketSummaryFormatError();
  return summary;
}

/**
 * The Ticket summary: issue, facts, work done, blocker, open questions and next
 * action, each point citing the history entries it rests on. Cached per
 * helpdesk and ticket; the gateway keys the cache on the content sent, the
 * model and the prompt version, so new public activity asks again.
 */
export async function summarizeTicket(
  source: TicketAiSource,
  options: { refresh?: boolean; unattended?: boolean } = {},
): Promise<TicketSummary> {
  const picked = publicEntries(source);
  const raw = await requestAi({
    feature: "ticket_summary",
    systemPrompt: TICKET_SUMMARY_PROMPT,
    items: toItems(source, picked),
    maxChars: MAX_CHARS,
    maxTokens: 1200,
    cache: { scope: await currentTenantId(), sourceId: source.ticketId, refresh: options.refresh },
    unattended: options.unattended,
  });
  return parseSummary(raw, picked.map((p) => p.entry.id));
}

// ---------- AI drafts ----------

export type ReplyTone = "friendly_professional" | "neutral" | "formal";

export const REPLY_TONES: { id: ReplyTone; label: string }[] = [
  { id: "friendly_professional", label: "Friendly-professional" },
  { id: "neutral", label: "Neutral" },
  { id: "formal", label: "Formal" },
];

/** draft: a new reply from the ticket; rewrite and shorten: the operator's own draft */
export type DraftAction = "draft" | "rewrite" | "shorten";

const TONE_TEXT: Record<ReplyTone, string> = {
  friendly_professional: "friendly-professional",
  neutral: "neutral",
  formal: "formal",
};

function operatorRequest(action: DraftAction, tone: ReplyTone, draftText: string): string {
  const lines = [`Tone: ${TONE_TEXT[tone]}.`];
  if (action === "draft") lines.push("Draft the agent's next reply to the customer.");
  else {
    lines.push(
      action === "shorten"
        ? "Shorten the agent's unsent draft below, keeping its meaning, facts and questions."
        : "Rewrite the agent's unsent draft below in the requested tone, keeping its meaning, facts and questions.",
      "Unsent draft:",
      draftText,
    );
  }
  return lines.join("\n");
}

/**
 * An AI draft for a reply to the customer, as HTML for the composer. It is
 * never sent and never cached: asking again gives a fresh draft. The
 * operator's own draft (rewrite, shorten) travels as the operator's request,
 * so a secret in it refuses the request instead of being cut out silently.
 */
export async function draftTicketReply(
  source: TicketAiSource,
  options: { tone?: ReplyTone; action?: DraftAction; draftText?: string } = {},
): Promise<string> {
  const action = options.action ?? "draft";
  const raw = await requestAi({
    feature: "ticket_reply",
    systemPrompt: TICKET_REPLY_PROMPT,
    items: toItems(source, publicEntries(source)),
    operatorText: operatorRequest(action, options.tone ?? "friendly_professional", options.draftText ?? ""),
    maxChars: MAX_CHARS,
    maxTokens: 1000,
  });
  const html = raw.replace(/^\s*```(?:html)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  return sanitizeHtml(/^\s*</.test(html) ? html : html.split(/\n{2,}/).map((p) => `<p>${p}</p>`).join(""));
}
