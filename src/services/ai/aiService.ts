import { requestAi, senderDomain, testAiConnection, type AiSourceItem } from "./gateway";
import type { DbMessage } from "@/services/db/messages";
import {
  SUMMARIZE_PROMPT,
  COMPOSE_PROMPT,
  REPLY_PROMPT,
  IMPROVE_PROMPT,
  SHORTEN_PROMPT,
  FORMALIZE_PROMPT,
  CATEGORIZE_PROMPT,
  SMART_REPLY_PROMPT,
  ASK_INBOX_PROMPT,
  SMART_LABEL_PROMPT,
  EXTRACT_TASK_PROMPT,
} from "./prompts";

// Every function here builds its request through the AI gateway (gateway.ts),
// which sends only allowlisted fields: sender addresses and names, recipients,
// dates and message IDs never leave Velo. Categorisation and smart labels add
// the sender's domain only.

/** A thread's messages as gateway source items: subject once, then each message's text. */
export function threadItems(messages: DbMessage[]): AiSourceItem[] {
  return messages.map((msg, i) => ({
    subject: i === 0 ? (msg.subject ?? "No subject") : null,
    body: msg.body_text ?? msg.snippet ?? "",
  }));
}

export async function summarizeThread(
  threadId: string,
  accountId: string,
  messages: DbMessage[],
  options: { refresh?: boolean } = {},
): Promise<string> {
  return requestAi({
    feature: "thread_summary",
    systemPrompt: SUMMARIZE_PROMPT,
    items: threadItems(messages),
    cache: { scope: accountId, sourceId: threadId, refresh: options.refresh },
  });
}

export async function composeFromPrompt(instructions: string): Promise<string> {
  return requestAi({ feature: "ai_compose", systemPrompt: COMPOSE_PROMPT, operatorText: instructions });
}

export async function generateReply(
  messagesText: string[],
  instructions?: string,
): Promise<string> {
  return requestAi({
    feature: "ai_reply",
    systemPrompt: REPLY_PROMPT,
    items: messagesText.map((body) => ({ body })),
    operatorText: instructions,
    maxChars: 4000,
  });
}

export type TransformType = "improve" | "shorten" | "formalize";

export async function transformText(
  text: string,
  type: TransformType,
): Promise<string> {
  const prompts: Record<TransformType, string> = {
    improve: IMPROVE_PROMPT,
    shorten: SHORTEN_PROMPT,
    formalize: FORMALIZE_PROMPT,
  };
  // The operator's own draft is the public message text being transformed.
  return requestAi({ feature: "text_transform", systemPrompt: prompts[type], items: [{ body: text }] });
}

export async function generateSmartReplies(
  threadId: string,
  accountId: string,
  messages: DbMessage[],
  options: { refresh?: boolean } = {},
): Promise<string[]> {
  const result = await requestAi({
    feature: "smart_replies",
    systemPrompt: SMART_REPLY_PROMPT,
    items: threadItems(messages),
    maxChars: 4000,
    cache: { scope: accountId, sourceId: threadId, refresh: options.refresh },
  });

  // Parse JSON array from response
  let replies: string[];
  try {
    // Extract JSON array from the response (handle potential markdown wrapping)
    // Use non-greedy match to avoid capturing extra content
    const jsonMatch = result.match(/\[[\s\S]*?\]/);
    replies = jsonMatch ? JSON.parse(jsonMatch[0]) as string[] : [result];
  } catch {
    // If parsing fails, split by newlines as fallback
    replies = result
      .split("\n")
      .map((l) => l.replace(/^\d+\.\s*/, "").trim())
      .filter(Boolean)
      .slice(0, 3);
  }

  // Validate and sanitize each reply
  replies = replies
    .filter((r): r is string => typeof r === "string")
    .map((r) => r.replace(/<[^>]*>/g, "").slice(0, 200));

  // Ensure exactly 3 replies
  while (replies.length < 3) replies.push("Thanks for the update.");
  return replies.slice(0, 3);
}

export async function askInbox(
  question: string,
  messages: { subject: string | null; snippet: string | null }[],
): Promise<string> {
  return requestAi({
    feature: "ask_inbox",
    systemPrompt: ASK_INBOX_PROMPT,
    items: messages.map((m) => ({ subject: m.subject ?? "(no subject)", body: m.snippet ?? "" })),
    operatorText: `Question: ${question}`,
  });
}

type ThreadForClassification = { id: string; subject: string; snippet: string; fromAddress: string };

/** Threads as source items; the AI refers to them by position, never by thread ID. */
function classificationItems(threads: ThreadForClassification[]): AiSourceItem[] {
  return threads.map((t) => ({
    subject: t.subject,
    body: t.snippet,
    senderDomain: senderDomain(t.fromAddress),
  }));
}

/** Parse "ITEM_ID:value" lines, mapping 1-based item ids back to thread IDs. */
function parseItemLines(result: string, threads: ThreadForClassification[]): [string, string][] {
  const pairs: [string, string][] = [];
  for (const line of result.split("\n")) {
    const trimmed = line.trim();
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;
    const index = Number(trimmed.slice(0, colonIdx).trim());
    const value = trimmed.slice(colonIdx + 1).trim();
    const threadId = Number.isInteger(index) ? threads[index - 1]?.id : undefined;
    if (threadId && value) pairs.push([threadId, value]);
  }
  return pairs;
}

const VALID_CATEGORIES = new Set(["Primary", "Updates", "Promotions", "Social", "Newsletters"]);

export async function categorizeThreads(
  threads: ThreadForClassification[],
): Promise<Map<string, string>> {
  const result = await requestAi({
    feature: "categorization",
    systemPrompt: CATEGORIZE_PROMPT,
    items: classificationItems(threads),
  });
  const categories = new Map<string, string>();
  for (const [threadId, category] of parseItemLines(result, threads)) {
    // Only accept valid categories
    if (VALID_CATEGORIES.has(category)) categories.set(threadId, category);
  }
  return categories;
}

export async function classifyThreadsBySmartLabels(
  threads: ThreadForClassification[],
  labelRules: { labelId: string; description: string }[],
): Promise<Map<string, string[]>> {
  const labelDefs = labelRules
    .map((r) => `LABEL_ID:${r.labelId} — ${r.description}`)
    .join("\n");
  const validLabelIds = new Set(labelRules.map((r) => r.labelId));

  const result = await requestAi({
    feature: "smart_labels",
    systemPrompt: SMART_LABEL_PROMPT,
    items: classificationItems(threads),
    operatorText: `Label definitions:\n${labelDefs}`,
  });

  const assignments = new Map<string, string[]>();
  for (const [threadId, labelsPart] of parseItemLines(result, threads)) {
    const labelIds = labelsPart
      .split(",")
      .map((l) => l.trim())
      .filter((l) => validLabelIds.has(l));
    if (labelIds.length > 0) assignments.set(threadId, labelIds);
  }
  return assignments;
}

export async function extractTaskFromThread(
  _threadId: string,
  _accountId: string,
  messages: DbMessage[],
): Promise<string> {
  return requestAi({
    feature: "task_extraction",
    systemPrompt: EXTRACT_TASK_PROMPT,
    items: threadItems(messages),
  });
}

export async function testConnection(): Promise<boolean> {
  return testAiConnection();
}
