import { requestAi, isAiAvailable } from "./gateway";
import { threadItems } from "./aiService";
import {
  getWritingStyleProfile,
  upsertWritingStyleProfile,
  deleteWritingStyleProfile,
} from "@/services/db/writingStyleProfiles";
import { getRecentSentMessages, type DbMessage } from "@/services/db/messages";
import { getAccount } from "@/services/db/accounts";
import { getSetting } from "@/services/db/settings";
import { WRITING_STYLE_ANALYSIS_PROMPT, AUTO_DRAFT_REPLY_PROMPT } from "./prompts";

/**
 * Analyze writing style from sent email samples.
 */
export async function analyzeWritingStyle(samples: DbMessage[]): Promise<string> {
  return requestAi({
    feature: "writing_style",
    systemPrompt: WRITING_STYLE_ANALYSIS_PROMPT,
    items: samples.map((msg) => ({ body: (msg.body_text ?? msg.snippet ?? "").trim().slice(0, 1000) })),
    maxChars: 8000,
  });
}

/**
 * Get existing style profile or create one by analyzing recent sent emails.
 */
export async function getOrCreateStyleProfile(accountId: string): Promise<string | null> {
  const styleEnabled = await getSetting("ai_writing_style_enabled");
  if (styleEnabled === "false") return null;

  // Check for cached profile
  const existing = await getWritingStyleProfile(accountId);
  if (existing) return existing.profile_text;

  // Get account email for matching sent messages
  const account = await getAccount(accountId);
  if (!account) return null;

  // Fetch recent sent messages
  const sentMessages = await getRecentSentMessages(accountId, account.email, 15);
  if (sentMessages.length < 3) return null; // Not enough samples

  // Analyze and cache
  const profileText = await analyzeWritingStyle(sentMessages);
  await upsertWritingStyleProfile(accountId, profileText, sentMessages.length);
  return profileText;
}

/**
 * Force re-analysis of writing style from latest sent emails.
 */
export async function refreshWritingStyle(accountId: string): Promise<string | null> {
  await deleteWritingStyleProfile(accountId);
  return getOrCreateStyleProfile(accountId);
}

export type AutoDraftMode = "reply" | "replyAll";

/**
 * Generate an auto-draft reply for a thread.
 * Returns cached version if available.
 */
export async function generateAutoDraft(
  threadId: string,
  accountId: string,
  messages: DbMessage[],
  mode: AutoDraftMode,
  options: { refresh?: boolean } = {},
): Promise<string> {
  // Get writing style profile (lazy creation)
  const styleProfile = await getOrCreateStyleProfile(accountId);

  return requestAi({
    feature: "auto_draft",
    systemPrompt: AUTO_DRAFT_REPLY_PROMPT,
    items: threadItems(messages),
    operatorText: styleProfile ? `User's writing style:\n${styleProfile}` : undefined,
    cache: { scope: accountId, sourceId: `${threadId}:${mode}`, refresh: options.refresh },
  });
}

/**
 * Regenerate auto-draft (skip the cache and generate fresh).
 */
export async function regenerateAutoDraft(
  threadId: string,
  accountId: string,
  messages: DbMessage[],
  mode: AutoDraftMode,
): Promise<string> {
  return generateAutoDraft(threadId, accountId, messages, mode, { refresh: true });
}

/**
 * Check if auto-draft is available (AI ready + setting enabled).
 */
export async function isAutoDraftEnabled(): Promise<boolean> {
  const enabled = await getSetting("ai_auto_draft_enabled");
  if (enabled === "false") return false;
  return isAiAvailable();
}
