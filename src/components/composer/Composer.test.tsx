import { TaskDrawer } from "@/components/clickup/TaskDrawer";
import { InlineReply } from "@/components/email/InlineReply";
import type { Thread } from "@/stores/threadStore";
import type { DbMessage } from "@/services/db/messages";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createSqliteTestDb, type SqliteTestDb } from "@/test/sqliteTestDb";

let db: SqliteTestDb;
// Tauri SQL plugin boundary: every getDb() call lands on the current in-memory DB.
vi.mock("@tauri-apps/plugin-sql", () => ({
  default: {
    load: async () => ({
      select: (sql: string, params?: unknown[]) => db.select(sql, params),
      execute: (sql: string, params?: unknown[]) => db.execute(sql, params),
    }),
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

import { Composer } from "./Composer";
import { runMigrations } from "@/services/db/migrations";
import { useComposerStore } from "@/stores/composerStore";
import { useAccountStore } from "@/stores/accountStore";
import { useShortcutStore } from "@/stores/shortcutStore";
import { getDefaultKeyMap } from "@/constants/shortcuts";
import { pretendPlatform, restoreUserAgent } from "@/test/platform";

const PICKER_NOTE = /sends when Velo is next open/i;

function editorElement(): HTMLElement {
  const el = document.querySelector<HTMLElement>(".ProseMirror");
  if (!el) throw new Error("editor not rendered");
  return el;
}

/** Press a key combination with focus inside the message editor. */
function pressInEditor(init: KeyboardEventInit) {
  const editor = editorElement();
  editor.focus();
  fireEvent.keyDown(editor, init);
}

async function renderComposer() {
  render(<Composer />);
  await waitFor(() => editorElement());
}

beforeEach(async () => {
  db = createSqliteTestDb();
  vi.spyOn(console, "log").mockImplementation(() => {});
  await runMigrations();
  await db.execute(
    "INSERT INTO accounts (id, email, provider) VALUES ('gmail-1', 'me@gmail.com', 'gmail_api')",
  );
  useAccountStore.setState({
    accounts: [{ id: "gmail-1", email: "me@gmail.com", displayName: null, avatarUrl: null, isActive: true, provider: "gmail_api" }],
    activeAccountId: "gmail-1",
  });
  useShortcutStore.setState({ keyMap: getDefaultKeyMap() });
  useComposerStore.setState({ undoSendVisible: false, undoSendTimer: null });
  act(() => {
    useComposerStore.getState().openComposer({ to: ["customer@example.com"], subject: "Renewal" });
  });
});

afterEach(() => {
  const timer = useComposerStore.getState().undoSendTimer;
  if (timer) clearTimeout(timer);
  act(() => useComposerStore.getState().closeComposer());
});

describe("Composer send-later shortcut", () => {
  it("opens the send-later picker on Cmd+Shift+L while typing in the editor", async () => {
    await renderComposer();

    pressInEditor({ key: "L", metaKey: true, shiftKey: true });

    expect(await screen.findByText(PICKER_NOTE)).toBeInTheDocument();
  });

  it("follows a rebound send-later key and ignores the old one", async () => {
    useShortcutStore.setState({ keyMap: { ...getDefaultKeyMap(), "app.sendLater": "Ctrl+Shift+K" } });
    await renderComposer();

    pressInEditor({ key: "L", metaKey: true, shiftKey: true });
    expect(screen.queryByText(PICKER_NOTE)).not.toBeInTheDocument();

    pressInEditor({ key: "K", metaKey: true, shiftKey: true });
    expect(await screen.findByText(PICKER_NOTE)).toBeInTheDocument();
  });
});

describe("Composer shortcut hints", () => {
  afterEach(restoreUserAgent);

  it("names the send and send-later keys with Cmd wording on macOS", async () => {
    pretendPlatform("mac");
    await renderComposer();

    expect(screen.getByRole("button", { name: "Send" })).toHaveAttribute("title", "Send (Cmd+Enter)");
    expect(screen.getByTitle("Send later (Cmd+Shift+L)")).toBeInTheDocument();
  });

  it("names the keys with Ctrl wording on Windows and follows a rebound key", async () => {
    pretendPlatform("windows");
    useShortcutStore.setState({ keyMap: { ...getDefaultKeyMap(), "app.sendLater": "Alt+K" } });
    await renderComposer();

    expect(screen.getByRole("button", { name: "Send" })).toHaveAttribute("title", "Send (Ctrl+Enter)");
    expect(screen.getByTitle("Send later (Alt+K)")).toBeInTheDocument();
  });
});

describe("Composer send-now shortcut", () => {
  it("sends on Cmd+Enter from the editor", async () => {
    await renderComposer();

    pressInEditor({ key: "Enter", metaKey: true });

    await waitFor(() => expect(useComposerStore.getState().undoSendVisible).toBe(true));
    expect(useComposerStore.getState().isOpen).toBe(false);
  });

  it("follows a rebound send-now key and ignores the old one", async () => {
    useShortcutStore.setState({ keyMap: { ...getDefaultKeyMap(), "app.send": "Ctrl+J" } });
    await renderComposer();

    pressInEditor({ key: "Enter", metaKey: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(useComposerStore.getState().isOpen).toBe(true);

    pressInEditor({ key: "j", metaKey: true });
    await waitFor(() => expect(useComposerStore.getState().undoSendVisible).toBe(true));
    expect(useComposerStore.getState().isOpen).toBe(false);
  });
});

describe("Composer scheduling", () => {
  it("stores the picked time and the attachments with the scheduled email", async () => {
    await renderComposer();
    act(() => {
      useComposerStore.getState().addAttachment({
        id: "att-1",
        file: new File(["x"], "terms.pdf"),
        filename: "terms.pdf",
        mimeType: "application/pdf",
        size: 1,
        content: "eA==",
      });
    });

    pressInEditor({ key: "L", metaKey: true, shiftKey: true });
    fireEvent.click(await screen.findByText("Tomorrow 8am"));

    await waitFor(() => expect(useComposerStore.getState().isOpen).toBe(false));
    const rows = await db.select<{ subject: string; status: string; attachment_paths: string }[]>(
      "SELECT subject, status, attachment_paths FROM scheduled_emails",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subject: "Renewal", status: "pending" });
    expect(JSON.parse(rows[0]!.attachment_paths)).toEqual([
      { filename: "terms.pdf", mimeType: "application/pdf", content: "eA==" },
    ]);
  });
});

describe("Composer scheduling from a send-as alias", () => {
  it("stores the alias chosen in the From selector with the scheduled email", async () => {
    await db.execute(
      `INSERT INTO send_as_aliases (id, account_id, email, is_primary, is_default)
       VALUES ('alias-main', 'gmail-1', 'me@gmail.com', 1, 1), ('alias-support', 'gmail-1', 'support@acme.com', 0, 0)`,
    );
    await renderComposer();
    await waitFor(() => expect(useComposerStore.getState().fromEmail).toBe("me@gmail.com"));
    act(() => useComposerStore.getState().setFromEmail("support@acme.com"));

    pressInEditor({ key: "L", metaKey: true, shiftKey: true });
    fireEvent.click(await screen.findByText("Tomorrow 8am"));

    await waitFor(() => expect(useComposerStore.getState().isOpen).toBe(false));
    const rows = await db.select<{ from_email: string | null }[]>("SELECT from_email FROM scheduled_emails");
    expect(rows).toEqual([{ from_email: "support@acme.com" }]);
  });
});


it.each(["standalone", "inline"])("keeps the %s email composer untouched by send keys in the ClickUp drawer", async (kind) => {
  if (kind === "standalone") await renderComposer();
  else {
    act(() => useComposerStore.getState().closeComposer());
    Element.prototype.scrollIntoView = vi.fn();
    render(<InlineReply thread={{ id: "t1", subject: "Help" } as Thread}
      messages={[{ id: "m1", from_address: "customer@example.test", subject: "Help" } as DbMessage]}
      accountId="gmail-1" onSent={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    await waitFor(() => editorElement());
  }
  const drawer = render(<TaskDrawer title="Create task" onClose={() => {}}><input aria-label="Task name" /></TaskDrawer>);
  const input = screen.getByRole("textbox", { name: "Task name" });
  input.focus();
  fireEvent.keyDown(input, { key: "Enter", metaKey: true });
  fireEvent.keyDown(input, { key: "L", metaKey: true, shiftKey: true });
  await act(async () => {});
  expect(useComposerStore.getState().undoSendVisible).toBe(false);
  expect(useComposerStore.getState().isOpen).toBe(kind === "standalone");
  expect(screen.queryByText(PICKER_NOTE)).not.toBeInTheDocument();
  expect(editorElement()).toBeInTheDocument();
  drawer.unmount();
  // Sending while typing in this composer's own editor still works.
  pressInEditor({ key: "Enter", metaKey: true });
  await waitFor(() => expect(useComposerStore.getState().undoSendVisible).toBe(true));
});
