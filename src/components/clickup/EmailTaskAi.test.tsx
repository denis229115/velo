import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createSqliteTestDb, type SqliteTestDb } from "@/test/sqliteTestDb";
import { createClickUpFetchStub } from "@/test/clickupFetchStub";
import { ALPHA_TOKEN, alphaExportBugWithNotes, clickupTokens } from "@/services/clickup/__fixtures__/clickupFixtures";
import type { AiCompletionRequest } from "@/services/ai/types";

const ai = vi.hoisted(() => ({ requests: [] as AiCompletionRequest[], respond: async () => "<p>The export fix is in review, not deployed yet. Contact [EMAIL_1].</p>" }));
vi.mock("@/services/ai/providers/claudeProvider", () => ({
  createClaudeProvider: () => ({ complete: async (request: AiCompletionRequest) => { ai.requests.push(request); return ai.respond(); }, testConnection: async () => true }),
  clearClaudeProvider: vi.fn(),
}));
let db: SqliteTestDb;
let clickup: ReturnType<typeof createClickUpFetchStub>;
vi.mock("@tauri-apps/plugin-sql", () => ({ default: { load: async () => ({
  select: (sql: string, params?: unknown[]) => db.select(sql, params),
  execute: (sql: string, params?: unknown[]) => db.execute(sql, params),
}) } }));
vi.mock("@/utils/crypto", () => ({ encryptValue: async (v: string) => `enc:${v}`, decryptValue: async (v: string) => v.slice(4), isEncrypted: (v: string) => v.startsWith("enc:") }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: (url: string, init?: RequestInit) => clickup.fetch(url, init) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import { runMigrations } from "@/services/db/migrations";
import { setSetting } from "@/services/db/settings";
import { getMessagesForThread } from "@/services/db/messages";
import { connectWorkspace } from "@/services/clickup/connection";
import { linkTask, type LinkedItem } from "@/services/clickup/links";
import { clearProviderClients } from "@/services/ai/providerManager";
import { AiSendPreviewHost } from "@/components/ai/AiSendPreview";
import { InlineReply } from "@/components/email/InlineReply";
import { Composer } from "@/components/composer/Composer";
import { useComposerStore } from "@/stores/composerStore";
import { useAccountStore } from "@/stores/accountStore";
import { useUIStore } from "@/stores/uiStore";
import { listAiAuditLog } from "@/services/db/aiAuditLog";
import type { Thread } from "@/stores/threadStore";

const EMAIL: LinkedItem = { kind: "email", accountId: "mail-1", threadId: "thread-1" };
const thread = { id: "thread-1", subject: "Export fails" } as Thread;
const editorText = () => document.querySelector(".ProseMirror")?.textContent;

beforeEach(async () => {
  db = createSqliteTestDb();
  vi.spyOn(console, "log").mockImplementation(() => {});
  await runMigrations();
  await db.execute("INSERT INTO accounts (id, email, provider) VALUES ('mail-1', 'operator@example.test', 'imap')");
  await db.execute("INSERT INTO threads (id, account_id, subject) VALUES ('thread-1', 'mail-1', 'Export fails')");
  await db.execute("INSERT INTO messages (id, account_id, thread_id, subject, body_text, from_address, date) VALUES ('m1', 'mail-1', 'thread-1', 'Export fails', 'Export times out. Please investigate.', 'header-only@example.test', 1760000000000)");
  useAccountStore.setState({ activeAccountId: "mail-1", accounts: [{ id: "mail-1", email: "operator@example.test", displayName: null, avatarUrl: null, isActive: true, provider: "imap" }] });
  useUIStore.setState({ isOnline: true });
  useComposerStore.setState(useComposerStore.getInitialState(), true);
  clickup = createClickUpFetchStub(clickupTokens);
  await connectWorkspace({ token: ALPHA_TOKEN });
  await linkTask(EMAIL, alphaExportBugWithNotes.id);
  clickup.replaceTask(alphaExportBugWithNotes);
  clickup.requests.length = 0;
  ai.requests.length = 0;
  ai.respond = async () => "<p>The export fix is in review, not deployed yet. Contact [EMAIL_1].</p>";
  clearProviderClients();
  await setSetting("ai_auto_draft_enabled", "false");
  await setSetting("ai_provider", "claude");
  await setSetting("claude_api_key", "fixture-key");
  await setSetting("ai_approved_provider", "claude");
  await setSetting("ai_previewed_data_kinds", JSON.stringify(["subject", "message_text"]));
  Element.prototype.scrollIntoView = vi.fn();
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});

afterEach(() => {
  cleanup();
  const timer = useComposerStore.getState().undoSendTimer;
  if (timer) clearTimeout(timer);
  db.close();
});

it.each(["inline", "composer"] as const)("offers a linked task draft in the %s email reply, with preview, redaction and explicit application", async (surface) => {
  if (surface === "inline") {
    render(<><InlineReply thread={thread} messages={await getMessagesForThread("mail-1", "thread-1")} accountId="mail-1" onSent={() => {}} /><AiSendPreviewHost /></>);
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
  } else {
    act(() => useComposerStore.getState().openComposer({ mode: "reply", threadId: "thread-1", bodyHtml: "<p>My own update.</p>", to: ["customer@example.test"], subject: "Export fails" }));
    render(<><Composer /><AiSendPreviewHost /></>);
  }
  const generate = await screen.findByRole("button", { name: "Draft from task" });
  await waitFor(() => expect(generate).toBeEnabled());
  fireEvent.click(generate);
  const send = await screen.findByRole("button", { name: "Send to Claude API (Anthropic)" });
  expect(ai.requests).toHaveLength(0);
  expect(screen.getByText(/data not sent before/)).toHaveTextContent("ClickUp task comments");
  fireEvent.click(send);
  const proposal = within(await screen.findByRole("region", { name: "Task reply draft" }));
  expect(editorText()).toBe(surface === "composer" ? "My own update." : "");
  const sent = ai.requests[0]!.userContent;
  expect(sent).toContain("fixture in progress (not done)");
  expect(sent).toContain("Export of accounts over 50k rows");
  expect(sent).toContain("Fix is in review, not deployed yet");
  expect(sent).toContain("Please investigate");
  expect(sent).not.toContain("mia.fake@example.test");
  expect(sent).not.toContain("555 01 23");
  expect(sent).not.toContain("sk-ant-api03-");
  expect(sent).not.toContain("header-only");
  expect(proposal.getByText(/Contact mia.fake@example.test/)).toBeInTheDocument();
  fireEvent.click(proposal.getByRole("button", { name: "Insert" }));
  expect(editorText()).toContain("not deployed yet");
  if (surface === "composer") expect(useComposerStore.getState().bodyHtml).toContain("My own update.");
  expect(clickup.requests.every((r) => r.method === "GET")).toBe(true);
  expect(useComposerStore.getState().undoSendVisible).toBe(false);
  expect((await listAiAuditLog())[0]).toMatchObject({ feature: "task_reply", provider: "claude" });
  await waitFor(() => expect(screen.queryByRole("region", { name: "Task reply draft" })).not.toBeInTheDocument());
});

it("ignores a cancelled task draft when the provider later answers, preserving the email reply", async () => {
  let finish: (text: string) => void = () => {};
  ai.respond = () => new Promise<string>((resolve) => { finish = resolve; });
  act(() => useComposerStore.getState().openComposer({ mode: "reply", threadId: "thread-1", bodyHtml: "<p>My own update.</p>" }));
  render(<><Composer /><AiSendPreviewHost /></>);
  fireEvent.click(await screen.findByRole("button", { name: "Draft from task" }));
  fireEvent.click(await screen.findByRole("button", { name: "Send to Claude API (Anthropic)" }));
  await waitFor(() => expect(ai.requests).toHaveLength(1));
  fireEvent.click(screen.getByRole("button", { name: "Cancel task draft" }));
  await act(async () => finish("<p>Late draft.</p>"));
  expect(screen.queryByRole("region", { name: "Task reply draft" })).not.toBeInTheDocument();
  expect(editorText()).toBe("My own update.");
  expect(useComposerStore.getState().undoSendVisible).toBe(false);
});
