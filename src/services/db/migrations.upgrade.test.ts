import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createSqliteTestDb, type SqliteTestDb } from "@/test/sqliteTestDb";

let db: SqliteTestDb;
vi.mock("@tauri-apps/plugin-sql", () => ({
  default: {
    load: vi.fn(async () => ({
      select: (sql: string, params?: unknown[]) => db.select(sql, params),
      execute: (sql: string, params?: unknown[]) => db.execute(sql, params),
    })),
  },
}));

import { runMigrations } from "./migrations";

vi.spyOn(console, "log").mockImplementation(() => {});

const V26_TABLES = [
  "integration_accounts",
  "freshdesk_field_choices",
  "freshdesk_ticket_fields",
  "freshdesk_agents",
  "freshdesk_groups",
  "freshdesk_status_classes",
];

/** Roll a fresh database back to how a v26 install looks. */
async function rollBackToV26() {
  // The v27 column on scheduled_emails must go, or re-running v27 would add it twice.
  await db.execute("ALTER TABLE scheduled_emails DROP COLUMN from_email");
  await db.execute("DELETE FROM _migrations WHERE version >= 27");
}

/** Roll a fresh database back to how a v25 install looks. */
async function rollBackToV25() {
  await rollBackToV26();
  for (const table of V26_TABLES) {
    await db.execute(`DROP TABLE IF EXISTS ${table}`);
  }
  await db.execute("DELETE FROM _migrations WHERE version >= 26");
}

/** Roll a fresh database back to how a v23 install looks. */
async function rollBackToV23() {
  await rollBackToV25();
  await db.execute("DROP TABLE IF EXISTS ai_audit_log");
  await db.execute("DROP TABLE IF EXISTS ai_result_cache");
  // v25 columns on scheduled_emails must go too, or re-running v25 would add them twice.
  for (const column of ["attempts", "next_attempt_at", "last_error"]) {
    await db.execute(`ALTER TABLE scheduled_emails DROP COLUMN ${column}`);
  }
  await db.execute("DELETE FROM _migrations WHERE version >= 24");
}

async function seedEmailData() {
  await db.execute(
    "INSERT INTO accounts (id, email, display_name) VALUES ('acc-1', 'ops.fake@example.test', 'Ops Fake')",
  );
  await db.execute(
    `INSERT INTO threads (id, account_id, subject, snippet, last_message_at, message_count)
     VALUES ('thread-1', 'acc-1', 'Invoice question', 'Could you resend', 1700000000000, 1)`,
  );
  await db.execute(
    `INSERT INTO messages (id, account_id, thread_id, from_address, subject, snippet, date, body_text)
     VALUES ('m1', 'acc-1', 'thread-1', 'jane.fake@example.test', 'Invoice question',
             'Could you resend', 1700000000000, 'Could you resend the invoice for October?')`,
  );
  await db.execute(
    "INSERT INTO thread_labels (account_id, thread_id, label_id) VALUES ('acc-1', 'thread-1', 'INBOX')",
  );
  await db.execute(
    "INSERT INTO ai_cache (id, account_id, thread_id, type, content) VALUES ('c1', 'acc-1', 'thread-1', 'summary', 'Old summary')",
  );
  await db.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('theme', 'dark')");
}

beforeEach(() => {
  db = createSqliteTestDb();
});

afterEach(() => {
  db.close();
});

describe("migration v24 (AI gateway)", () => {
  it("upgrades a v23 install without losing email data or settings", async () => {
    await runMigrations();
    await rollBackToV23();
    await seedEmailData();

    await runMigrations();

    expect(await db.select("SELECT id, email FROM accounts")).toEqual([
      { id: "acc-1", email: "ops.fake@example.test" },
    ]);
    expect(await db.select("SELECT id, subject FROM threads")).toEqual([
      { id: "thread-1", subject: "Invoice question" },
    ]);
    expect(await db.select("SELECT id, body_text FROM messages")).toEqual([
      { id: "m1", body_text: "Could you resend the invoice for October?" },
    ]);
    expect(await db.select("SELECT label_id FROM thread_labels")).toEqual([{ label_id: "INBOX" }]);
    expect(await db.select("SELECT content FROM ai_cache")).toEqual([{ content: "Old summary" }]);
    expect(await db.select("SELECT value FROM settings WHERE key = 'theme'")).toEqual([{ value: "dark" }]);
    // Full-text search still finds the message.
    expect(
      await db.select("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'invoice'"),
    ).toHaveLength(1);
  });

  it("adds the AI audit log and result cache tables", async () => {
    await runMigrations();

    const tables = await db.select<{ name: string }[]>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('ai_audit_log', 'ai_result_cache') ORDER BY name",
    );
    expect(tables.map((t) => t.name)).toEqual(["ai_audit_log", "ai_result_cache"]);
    expect(await db.select("SELECT version FROM _migrations WHERE version = 24")).toHaveLength(1);
  });
});

describe("migration v26 (Freshdesk connection)", () => {
  it("upgrades a v25 install without losing email data or settings", async () => {
    await runMigrations();
    await rollBackToV25();
    await seedEmailData();

    await runMigrations();

    expect(await db.select("SELECT id, email FROM accounts")).toEqual([
      { id: "acc-1", email: "ops.fake@example.test" },
    ]);
    expect(await db.select("SELECT id, subject FROM threads")).toEqual([
      { id: "thread-1", subject: "Invoice question" },
    ]);
    expect(await db.select("SELECT id, body_text FROM messages")).toEqual([
      { id: "m1", body_text: "Could you resend the invoice for October?" },
    ]);
    expect(await db.select("SELECT label_id FROM thread_labels")).toEqual([{ label_id: "INBOX" }]);
    expect(await db.select("SELECT value FROM settings WHERE key = 'theme'")).toEqual([{ value: "dark" }]);
    expect(
      await db.select("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'invoice'"),
    ).toHaveLength(1);
  });

  it("adds the tenant-scoped integration tables", async () => {
    await runMigrations();

    const tables = await db.select<{ name: string }[]>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${V26_TABLES.map((t) => `'${t}'`).join(", ")}) ORDER BY name`,
    );
    expect(tables.map((t) => t.name)).toEqual([...V26_TABLES].sort());
    expect(await db.select("SELECT version FROM _migrations WHERE version = 26")).toHaveLength(1);
  });
});

describe("migration v27 (scheduled email send-as alias)", () => {
  it("upgrades a v26 install and keeps existing scheduled emails", async () => {
    await runMigrations();
    await rollBackToV26();
    await seedEmailData();
    await db.execute(
      `INSERT INTO scheduled_emails (id, account_id, to_addresses, subject, body_html, scheduled_at)
       VALUES ('s1', 'acc-1', 'jane.fake@example.test', 'Later', '<p>Hi</p>', 1700000000000)`,
    );

    await runMigrations();

    expect(await db.select("SELECT id, from_email FROM scheduled_emails")).toEqual([
      { id: "s1", from_email: null },
    ]);
    expect(await db.select("SELECT version FROM _migrations WHERE version = 27")).toHaveLength(1);
  });
});

describe("migration v37 (ticket reply attachments)", () => {
  it("keeps files from the earlier attachment-v36 branch and still adds the CC schema", async () => {
    await runMigrations();
    for (const column of ["cc_emails_json", "reply_cc_emails_json", "fwd_emails_json"]) {
      await db.execute(`ALTER TABLE freshdesk_tickets DROP COLUMN ${column}`);
    }
    await db.execute("DELETE FROM _migrations WHERE version >= 36");
    await db.execute(`INSERT INTO _migrations (version, description)
      VALUES (36, 'Files attached to Freshdesk ticket drafts and scheduled replies')`);
    for (const [id, owner] of [["draft-file", "draft:freshdesk:fixture.test|me|1001|reply"], ["scheduled-file", "scheduled:later"]]) {
      await db.execute(`INSERT INTO freshdesk_reply_attachments
        (attachment_id, owner, position, name, content_type, size, data_base64, created_at)
        VALUES ($1, $2, 1, 'server.log', 'text/plain', 5, 'aGVsbG8=', 1)`, [id, owner]);
    }

    await runMigrations();
    await runMigrations(); // Restarting must keep both migrations and the same bytes.

    const columns = await db.select<{ name: string }[]>("PRAGMA table_info(freshdesk_tickets)");
    expect(columns.map((c) => c.name)).toEqual(expect.arrayContaining(["cc_emails_json", "reply_cc_emails_json", "fwd_emails_json"]));
    expect(await db.select("SELECT attachment_id, owner, data_base64 FROM freshdesk_reply_attachments ORDER BY attachment_id")).toEqual([
      { attachment_id: "draft-file", owner: "draft:freshdesk:fixture.test|me|1001|reply", data_base64: "aGVsbG8=" },
      { attachment_id: "scheduled-file", owner: "scheduled:later", data_base64: "aGVsbG8=" },
    ]);
    expect(await db.select("SELECT version, description FROM _migrations WHERE version BETWEEN 36 AND 37 ORDER BY version")).toEqual([
      { version: 36, description: "Freshdesk ticket CC, reply-CC and forward lists (NULL when Freshdesk gave none)" },
      { version: 37, description: "Files attached to Freshdesk ticket drafts and scheduled replies" },
    ]);
  });

  it("upgrades the CC v36 database without losing saved CC or drafts", async () => {
    await runMigrations();
    await db.execute("DROP TABLE freshdesk_reply_attachments");
    await db.execute("DELETE FROM _migrations WHERE version >= 37");
    await db.execute(`INSERT INTO freshdesk_tickets
      (tenant_id, ticket_id, subject, status_id, created_at, updated_at, cc_emails_json)
      VALUES ('freshdesk:fixture.test', '1001', 'Help', '2', 1, 1, '["copied@example.test"]')`);
    await db.execute(`INSERT INTO freshdesk_ticket_drafts
      (tenant_id, agent_id, ticket_id, mode, body_html, started_at, updated_at)
      VALUES ('freshdesk:fixture.test', 'me', '1001', 'reply', '<p>Keep me</p>', 1, 1)`);

    await runMigrations();

    expect(await db.select("SELECT * FROM freshdesk_reply_attachments")).toEqual([]);
    expect(await db.select("SELECT cc_emails_json FROM freshdesk_tickets")).toEqual([{ cc_emails_json: '["copied@example.test"]' }]);
    expect(await db.select("SELECT body_html FROM freshdesk_ticket_drafts")).toEqual([{ body_html: "<p>Keep me</p>" }]);
    expect(await db.select("SELECT version FROM _migrations WHERE version BETWEEN 36 AND 37 ORDER BY version")).toEqual([{ version: 36 }, { version: 37 }]);
  });
});


describe("obsolete AI preferences upgrade", () => {
  it.each([true, false])("removes the obsolete auto-summary key from existing v37 history (key present: %s)", async (present) => {
    await runMigrations();
    await db.execute("ALTER TABLE integration_accounts DROP COLUMN connection_generation");
    await db.execute("DELETE FROM _migrations WHERE version >= 38");
    if (present) await db.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('ai_auto_summarize', 'true')");
    await db.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('theme', 'dark')");

    await runMigrations();
    await runMigrations();

    expect(await db.select("SELECT value FROM settings WHERE key = 'ai_auto_summarize'")).toEqual([]);
    expect(await db.select("SELECT value FROM settings WHERE key = 'theme'")).toEqual([{ value: "dark" }]);
  });
});
