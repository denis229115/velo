/**
 * A linked task's content for an AI reply draft: its name, status,
 * description and comment texts, read live from ClickUp (never cached). Who
 * commented, when, and the lines Velo writes into descriptions stay behind.
 * Task text is untrusted; it reaches the AI only through the AI gateway.
 */
import { ClickUpError, clickupGet } from "./client";
import { currentClickUpCredentials } from "./connection";
import { assertNotWaiting, failAction } from "./links";
import { isDoneStatusType, sanitizeText, type ApiTask } from "./tasks";

export interface TaskForAi {
  taskId: string;
  name: string;
  /** ClickUp's own status name */
  status: string;
  /** True only when ClickUp's status type says the task is complete */
  done: boolean;
  description: string;
  /** Comment texts only, oldest first */
  comments: string[];
}

const MAX_DESCRIPTION = 3000;
const MAX_COMMENT = 600;
const MAX_COMMENTS = 10;

// Control and direction characters, keeping line breaks
const UNSAFE_TEXT = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;
// Lines Velo itself writes into a task description: the operation marker and the ticket link
const VELO_LINES = /^\s*(Velo reference: velo-op-\S+|Freshdesk ticket #\S+: \S+)\s*$/;

function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const text = value
    .replace(/\r\n?/g, "\n")
    .replace(UNSAFE_TEXT, "")
    .split("\n")
    .filter((line) => !VELO_LINES.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

type RemoteTask = ApiTask & { description?: string | null; markdown_description?: string | null };
interface RemoteComment {
  comment_text?: string;
  comment?: { text?: string }[];
}

export async function readTaskForAi(taskId: string): Promise<TaskForAi> {
  const credentials = await currentClickUpCredentials();
  if (!credentials) throw new Error("Connect a ClickUp workspace in Settings → ClickUp to use linked tasks.");
  const { tenantId, workspaceId, token } = credentials;
  const id = encodeURIComponent(taskId);
  try {
    await assertNotWaiting(tenantId);
    const task = await clickupGet<RemoteTask>(token, `/task/${id}?include_markdown_description=true`);
    if (!task || String(task.id) !== taskId || (task.team_id !== undefined && String(task.team_id) !== workspaceId)) {
      throw new ClickUpError("not_in_workspace", "This task is not in the connected workspace.");
    }
    const { comments } = await clickupGet<{ comments?: RemoteComment[] }>(token, `/task/${id}/comment`);
    // ClickUp answers newest first: keep the latest few, then read them oldest first
    const texts = (comments ?? [])
      .map((c) => cleanText(c.comment_text ?? c.comment?.map((part) => part.text ?? "").join(""), MAX_COMMENT))
      .filter(Boolean)
      .slice(0, MAX_COMMENTS)
      .reverse();
    return {
      taskId,
      name: sanitizeText(task.name, `Task ${taskId}`),
      status: sanitizeText(task.status?.status, "unknown status"),
      done: isDoneStatusType(sanitizeText(task.status?.type)),
      description: cleanText(task.markdown_description ?? task.description, MAX_DESCRIPTION),
      comments: texts,
    };
  } catch (err) {
    return failAction(tenantId, err);
  }
}
