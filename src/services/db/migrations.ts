import { getDb } from "./connection";

const MIGRATIONS = [
  {
    version: 1,
    description: "Initial schema",
    sql: `
      -- Accounts
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        display_name TEXT,
        avatar_url TEXT,
        access_token TEXT,
        refresh_token TEXT,
        token_expires_at INTEGER,
        history_id TEXT,
        last_sync_at INTEGER,
        is_active INTEGER DEFAULT 1,
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch())
      );

      -- Labels
      CREATE TABLE IF NOT EXISTS labels (
        id TEXT NOT NULL,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        color_bg TEXT,
        color_fg TEXT,
        visible INTEGER DEFAULT 1,
        sort_order INTEGER DEFAULT 0,
        PRIMARY KEY (account_id, id)
      );
      CREATE INDEX IF NOT EXISTS idx_labels_account ON labels(account_id);

      -- Threads
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT NOT NULL,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        subject TEXT,
        snippet TEXT,
        last_message_at INTEGER,
        message_count INTEGER DEFAULT 0,
        is_read INTEGER DEFAULT 0,
        is_starred INTEGER DEFAULT 0,
        is_important INTEGER DEFAULT 0,
        has_attachments INTEGER DEFAULT 0,
        is_snoozed INTEGER DEFAULT 0,
        snooze_until INTEGER,
        PRIMARY KEY (account_id, id)
      );
      CREATE INDEX IF NOT EXISTS idx_threads_date ON threads(account_id, last_message_at DESC);
      CREATE INDEX IF NOT EXISTS idx_threads_snoozed ON threads(is_snoozed, snooze_until);

      -- Thread-Label junction
      CREATE TABLE IF NOT EXISTS thread_labels (
        thread_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        label_id TEXT NOT NULL,
        PRIMARY KEY (account_id, thread_id, label_id),
        FOREIGN KEY (account_id, thread_id) REFERENCES threads(account_id, id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_thread_labels_label ON thread_labels(account_id, label_id);

      -- Messages
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT NOT NULL,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL,
        from_address TEXT,
        from_name TEXT,
        to_addresses TEXT,
        cc_addresses TEXT,
        bcc_addresses TEXT,
        reply_to TEXT,
        subject TEXT,
        snippet TEXT,
        date INTEGER NOT NULL,
        is_read INTEGER DEFAULT 0,
        is_starred INTEGER DEFAULT 0,
        body_html TEXT,
        body_text TEXT,
        body_cached INTEGER DEFAULT 0,
        raw_size INTEGER,
        internal_date INTEGER,
        PRIMARY KEY (account_id, id),
        FOREIGN KEY (account_id, thread_id) REFERENCES threads(account_id, id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(account_id, thread_id, date ASC);
      CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(account_id, date DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_address);

      -- Attachments
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        filename TEXT,
        mime_type TEXT,
        size INTEGER,
        gmail_attachment_id TEXT,
        content_id TEXT,
        is_inline INTEGER DEFAULT 0,
        local_path TEXT,
        FOREIGN KEY (account_id, message_id) REFERENCES messages(account_id, id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(account_id, message_id);
      CREATE INDEX IF NOT EXISTS idx_attachments_cid ON attachments(content_id);

      -- Contacts
      CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        display_name TEXT,
        avatar_url TEXT,
        frequency INTEGER DEFAULT 1,
        last_contacted_at INTEGER,
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);
      CREATE INDEX IF NOT EXISTS idx_contacts_frequency ON contacts(frequency DESC);

      -- Signatures
      CREATE TABLE IF NOT EXISTS signatures (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        body_html TEXT NOT NULL,
        is_default INTEGER DEFAULT 0,
        sort_order INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch())
      );

      -- Scheduled emails
      CREATE TABLE IF NOT EXISTS scheduled_emails (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        to_addresses TEXT NOT NULL,
        cc_addresses TEXT,
        bcc_addresses TEXT,
        subject TEXT,
        body_html TEXT NOT NULL,
        reply_to_message_id TEXT,
        thread_id TEXT,
        scheduled_at INTEGER NOT NULL,
        signature_id TEXT,
        attachment_paths TEXT,
        status TEXT DEFAULT 'pending',
        created_at INTEGER DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_scheduled_status ON scheduled_emails(status, scheduled_at);

      -- App settings
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- Default settings
      INSERT OR IGNORE INTO settings (key, value) VALUES
        ('theme', 'system'),
        ('sidebar_collapsed', 'false'),
        ('reading_pane_position', 'right'),
        ('sync_period_days', '365'),
        ('notifications_enabled', 'true'),
        ('undo_send_delay_seconds', '5'),
        ('default_font', 'system'),
        ('font_size', 'default');

      -- Migration tracking
      CREATE TABLE IF NOT EXISTS _migrations (
        version INTEGER PRIMARY KEY,
        description TEXT,
        applied_at INTEGER DEFAULT (unixepoch())
      );
    `,
  },
  {
    version: 2,
    description: "Full-text search",
    sql: `
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        subject,
        from_name,
        from_address,
        body_text,
        snippet,
        content='messages',
        content_rowid='rowid',
        tokenize='trigram'
      );

      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, subject, from_name, from_address, body_text, snippet)
        VALUES (new.rowid, new.subject, new.from_name, new.from_address, new.body_text, new.snippet);
      END;

      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, subject, from_name, from_address, body_text, snippet)
        VALUES ('delete', old.rowid, old.subject, old.from_name, old.from_address, old.body_text, old.snippet);
      END;

      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, subject, from_name, from_address, body_text, snippet)
        VALUES ('delete', old.rowid, old.subject, old.from_name, old.from_address, old.body_text, old.snippet);
        INSERT INTO messages_fts(rowid, subject, from_name, from_address, body_text, snippet)
        VALUES (new.rowid, new.subject, new.from_name, new.from_address, new.body_text, new.snippet);
      END;
    `,
  },
  {
    version: 3,
    description: "Add List-Unsubscribe header storage",
    sql: `
      ALTER TABLE messages ADD COLUMN list_unsubscribe TEXT;
    `,
  },
  {
    version: 4,
    description: "Filter rules, templates, image allowlist",
    sql: `
      -- Filter rules
      CREATE TABLE IF NOT EXISTS filter_rules (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        is_enabled INTEGER DEFAULT 1,
        criteria_json TEXT NOT NULL,
        actions_json TEXT NOT NULL,
        sort_order INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_filter_rules_account ON filter_rules(account_id);

      -- Templates
      CREATE TABLE IF NOT EXISTS templates (
        id TEXT PRIMARY KEY,
        account_id TEXT,
        name TEXT NOT NULL,
        subject TEXT,
        body_html TEXT NOT NULL,
        shortcut TEXT,
        sort_order INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch()),
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_templates_account ON templates(account_id);

      -- Image allowlist
      CREATE TABLE IF NOT EXISTS image_allowlist (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        sender_address TEXT NOT NULL,
        created_at INTEGER DEFAULT (unixepoch()),
        UNIQUE(account_id, sender_address)
      );
      CREATE INDEX IF NOT EXISTS idx_image_allowlist_sender ON image_allowlist(account_id, sender_address);

      INSERT OR IGNORE INTO settings (key, value) VALUES ('block_remote_images', 'true');
    `,
  },
  {
    version: 5,
    description: "Pin support, AI cache, thread categories, calendar events, contact enrichment, attachment caching",
    sql: `
      -- Pin support
      ALTER TABLE threads ADD COLUMN is_pinned INTEGER DEFAULT 0;
      CREATE INDEX idx_threads_pinned ON threads(account_id, is_pinned DESC, last_message_at DESC);

      -- AI cache
      CREATE TABLE ai_cache (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER DEFAULT (unixepoch()),
        UNIQUE(account_id, thread_id, type)
      );
      CREATE INDEX idx_ai_cache_lookup ON ai_cache(account_id, thread_id, type);

      -- Thread categories (split inbox)
      CREATE TABLE thread_categories (
        account_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        category TEXT NOT NULL,
        is_manual INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch()),
        PRIMARY KEY (account_id, thread_id),
        FOREIGN KEY (account_id, thread_id) REFERENCES threads(account_id, id) ON DELETE CASCADE
      );
      CREATE INDEX idx_thread_categories_cat ON thread_categories(account_id, category);

      -- Calendar events
      CREATE TABLE calendar_events (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        google_event_id TEXT NOT NULL,
        summary TEXT,
        description TEXT,
        location TEXT,
        start_time INTEGER NOT NULL,
        end_time INTEGER NOT NULL,
        is_all_day INTEGER DEFAULT 0,
        status TEXT DEFAULT 'confirmed',
        organizer_email TEXT,
        attendees_json TEXT,
        html_link TEXT,
        updated_at INTEGER DEFAULT (unixepoch()),
        UNIQUE(account_id, google_event_id)
      );
      CREATE INDEX idx_cal_events_time ON calendar_events(account_id, start_time, end_time);

      -- Contact enrichment
      ALTER TABLE contacts ADD COLUMN first_contacted_at INTEGER;

      -- Attachment cache tracking
      ALTER TABLE attachments ADD COLUMN cached_at INTEGER;
      ALTER TABLE attachments ADD COLUMN cache_size INTEGER;

      -- New settings
      INSERT OR IGNORE INTO settings (key, value) VALUES
        ('ai_enabled', 'true'),
        ('ai_auto_categorize', 'true'),
        ('contact_sidebar_visible', 'true'),
        ('attachment_cache_max_mb', '500'),
        ('calendar_enabled', 'false');
    `,
  },
  {
    version: 6,
    description: "Follow-up reminders, smart notifications, unsubscribe manager, newsletter bundling",
    sql: `
      -- Follow-up reminders (Feature 1)
      CREATE TABLE IF NOT EXISTS follow_up_reminders (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        remind_at INTEGER NOT NULL,
        status TEXT DEFAULT 'pending',
        created_at INTEGER DEFAULT (unixepoch()),
        FOREIGN KEY (account_id, thread_id) REFERENCES threads(account_id, id) ON DELETE CASCADE
      );
      CREATE INDEX idx_followup_status ON follow_up_reminders(status, remind_at);
      CREATE INDEX idx_followup_thread ON follow_up_reminders(account_id, thread_id);

      -- VIP notification senders (Feature 2)
      CREATE TABLE IF NOT EXISTS notification_vips (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        email_address TEXT NOT NULL,
        display_name TEXT,
        created_at INTEGER DEFAULT (unixepoch()),
        UNIQUE(account_id, email_address)
      );
      CREATE INDEX idx_notification_vips ON notification_vips(account_id, email_address);

      -- Unsubscribe tracking (Feature 3)
      CREATE TABLE IF NOT EXISTS unsubscribe_actions (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL,
        from_address TEXT NOT NULL,
        from_name TEXT,
        method TEXT NOT NULL,
        unsubscribe_url TEXT NOT NULL,
        status TEXT DEFAULT 'subscribed',
        unsubscribed_at INTEGER,
        created_at INTEGER DEFAULT (unixepoch()),
        UNIQUE(account_id, from_address)
      );
      CREATE INDEX idx_unsub_account ON unsubscribe_actions(account_id, status);

      -- Bundle rules (Feature 4)
      CREATE TABLE IF NOT EXISTS bundle_rules (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        category TEXT NOT NULL,
        is_bundled INTEGER DEFAULT 1,
        delivery_enabled INTEGER DEFAULT 0,
        delivery_schedule TEXT,
        last_delivered_at INTEGER,
        created_at INTEGER DEFAULT (unixepoch()),
        UNIQUE(account_id, category)
      );
      CREATE INDEX idx_bundle_rules_account ON bundle_rules(account_id);

      -- Held threads for delivery schedules (Feature 4)
      CREATE TABLE IF NOT EXISTS bundled_threads (
        account_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        category TEXT NOT NULL,
        held_until INTEGER,
        PRIMARY KEY (account_id, thread_id),
        FOREIGN KEY (account_id, thread_id) REFERENCES threads(account_id, id) ON DELETE CASCADE
      );
      CREATE INDEX idx_bundled_held ON bundled_threads(held_until);

      -- List-Unsubscribe-Post header (Feature 3)
      ALTER TABLE messages ADD COLUMN list_unsubscribe_post TEXT;

      -- New settings
      INSERT OR IGNORE INTO settings (key, value) VALUES
        ('smart_notifications', 'true'),
        ('notify_categories', 'Primary'),
        ('auto_archive_after_unsubscribe', 'true');
    `,
  },
  {
    version: 7,
    description: "Send-as aliases",
    sql: `
      CREATE TABLE IF NOT EXISTS send_as_aliases (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        email TEXT NOT NULL,
        display_name TEXT,
        reply_to_address TEXT,
        signature_id TEXT,
        is_primary INTEGER DEFAULT 0,
        is_default INTEGER DEFAULT 0,
        treat_as_alias INTEGER DEFAULT 1,
        verification_status TEXT DEFAULT 'accepted',
        created_at INTEGER DEFAULT (unixepoch()),
        UNIQUE(account_id, email)
      );
      CREATE INDEX idx_send_as_account ON send_as_aliases(account_id);
    `,
  },
  {
    version: 8,
    description: "Smart folders",
    sql: `
      CREATE TABLE IF NOT EXISTS smart_folders (
        id TEXT PRIMARY KEY,
        account_id TEXT,
        name TEXT NOT NULL,
        query TEXT NOT NULL,
        icon TEXT DEFAULT 'Search',
        color TEXT,
        sort_order INTEGER DEFAULT 0,
        is_default INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch()),
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_smart_folders_account ON smart_folders(account_id);

      INSERT INTO smart_folders (id, account_id, name, query, icon, sort_order, is_default) VALUES
        ('sf-unread', NULL, 'Unread', 'is:unread', 'MailOpen', 0, 1),
        ('sf-attachments', NULL, 'Has Attachments', 'has:attachment', 'Paperclip', 1, 1),
        ('sf-starred-recent', NULL, 'Starred This Week', 'is:starred after:__LAST_7_DAYS__', 'Star', 2, 1);
    `,
  },
  {
    version: 9,
    description: "Email authentication results",
    sql: `ALTER TABLE messages ADD COLUMN auth_results TEXT;`,
  },
  {
    version: 10,
    description: "Mute thread support",
    sql: `
      ALTER TABLE threads ADD COLUMN is_muted INTEGER DEFAULT 0;
      CREATE INDEX idx_threads_muted ON threads(account_id, is_muted);
    `,
  },
  {
    version: 11,
    description: "Phishing detection cache and allowlist",
    sql: `
      CREATE TABLE IF NOT EXISTS link_scan_results (
        message_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        result_json TEXT NOT NULL,
        scanned_at INTEGER DEFAULT (unixepoch()),
        PRIMARY KEY (account_id, message_id)
      );

      CREATE TABLE IF NOT EXISTS phishing_allowlist (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        sender_address TEXT NOT NULL,
        created_at INTEGER DEFAULT (unixepoch()),
        UNIQUE(account_id, sender_address)
      );

      INSERT OR IGNORE INTO settings (key, value) VALUES
        ('phishing_detection_enabled', 'true'),
        ('phishing_sensitivity', 'default');
    `,
  },
  {
    version: 12,
    description: "Quick steps",
    sql: `
      CREATE TABLE IF NOT EXISTS quick_steps (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        shortcut TEXT,
        actions_json TEXT NOT NULL,
        icon TEXT,
        is_enabled INTEGER DEFAULT 1,
        continue_on_error INTEGER DEFAULT 0,
        sort_order INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch())
      );
      CREATE INDEX idx_quick_steps_account ON quick_steps(account_id);
    `,
  },
  {
    version: 13,
    description: "Contact notes",
    sql: `ALTER TABLE contacts ADD COLUMN notes TEXT;`,
  },
  {
    version: 14,
    description: "IMAP/SMTP provider support",
    sql: `
      -- Accounts: provider and connection settings
      ALTER TABLE accounts ADD COLUMN provider TEXT DEFAULT 'gmail_api';
      ALTER TABLE accounts ADD COLUMN imap_host TEXT;
      ALTER TABLE accounts ADD COLUMN imap_port INTEGER;
      ALTER TABLE accounts ADD COLUMN imap_security TEXT;
      ALTER TABLE accounts ADD COLUMN smtp_host TEXT;
      ALTER TABLE accounts ADD COLUMN smtp_port INTEGER;
      ALTER TABLE accounts ADD COLUMN smtp_security TEXT;
      ALTER TABLE accounts ADD COLUMN auth_method TEXT DEFAULT 'oauth';
      ALTER TABLE accounts ADD COLUMN imap_password TEXT;

      -- Messages: RFC 2822 threading headers and IMAP identifiers
      ALTER TABLE messages ADD COLUMN message_id_header TEXT;
      ALTER TABLE messages ADD COLUMN references_header TEXT;
      ALTER TABLE messages ADD COLUMN in_reply_to_header TEXT;
      ALTER TABLE messages ADD COLUMN imap_uid INTEGER;
      ALTER TABLE messages ADD COLUMN imap_folder TEXT;

      -- Labels: IMAP folder mapping
      ALTER TABLE labels ADD COLUMN imap_folder_path TEXT;
      ALTER TABLE labels ADD COLUMN imap_special_use TEXT;

      -- Attachments: IMAP MIME part identifier
      ALTER TABLE attachments ADD COLUMN imap_part_id TEXT;

      -- Folder sync state for IMAP accounts
      CREATE TABLE IF NOT EXISTS folder_sync_state (
        account_id TEXT NOT NULL,
        folder_path TEXT NOT NULL,
        uidvalidity INTEGER,
        last_uid INTEGER DEFAULT 0,
        modseq INTEGER,
        last_sync_at INTEGER,
        PRIMARY KEY (account_id, folder_path),
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
      );

      -- Indexes for IMAP message lookups
      CREATE INDEX IF NOT EXISTS idx_messages_imap_uid ON messages(account_id, imap_folder, imap_uid);
      CREATE INDEX IF NOT EXISTS idx_messages_message_id ON messages(message_id_header);
    `,
  },
  {
    version: 15,
    description: "OAuth2 provider support for IMAP/SMTP",
    sql: `
      ALTER TABLE accounts ADD COLUMN oauth_provider TEXT;
      ALTER TABLE accounts ADD COLUMN oauth_client_id TEXT;
      ALTER TABLE accounts ADD COLUMN oauth_client_secret TEXT;
    `,
  },
  {
    version: 16,
    description: "Optional IMAP/SMTP username override",
    sql: `ALTER TABLE accounts ADD COLUMN imap_username TEXT;`,
  },
  {
    version: 17,
    description: "Offline mode: pending operations queue and local drafts",
    sql: `
      CREATE TABLE IF NOT EXISTS pending_operations (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        operation_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        params TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        retry_count INTEGER DEFAULT 0,
        max_retries INTEGER DEFAULT 10,
        next_retry_at INTEGER,
        created_at INTEGER DEFAULT (unixepoch()),
        error_message TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pending_ops_status ON pending_operations(status, next_retry_at);
      CREATE INDEX IF NOT EXISTS idx_pending_ops_resource ON pending_operations(account_id, resource_id);

      CREATE TABLE IF NOT EXISTS local_drafts (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        to_addresses TEXT,
        cc_addresses TEXT,
        bcc_addresses TEXT,
        subject TEXT,
        body_html TEXT,
        reply_to_message_id TEXT,
        thread_id TEXT,
        from_email TEXT,
        signature_id TEXT,
        remote_draft_id TEXT,
        attachments TEXT,
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch()),
        sync_status TEXT DEFAULT 'pending'
      );
    `,
  },
  {
    version: 18,
    description: "AI auto-drafts writing style profiles and task manager",
    sql: `
      -- Writing style profiles for AI auto-drafts
      CREATE TABLE IF NOT EXISTS writing_style_profiles (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        profile_text TEXT NOT NULL,
        sample_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch()),
        UNIQUE(account_id)
      );

      -- Tasks
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        account_id TEXT,
        title TEXT NOT NULL,
        description TEXT,
        priority TEXT DEFAULT 'none',
        is_completed INTEGER DEFAULT 0,
        completed_at INTEGER,
        due_date INTEGER,
        parent_id TEXT,
        thread_id TEXT,
        thread_account_id TEXT,
        sort_order INTEGER DEFAULT 0,
        recurrence_rule TEXT,
        next_recurrence_at INTEGER,
        tags_json TEXT DEFAULT '[]',
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch()),
        FOREIGN KEY (parent_id) REFERENCES tasks(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_account ON tasks(account_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_completed_due ON tasks(is_completed, due_date);
      CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_thread ON tasks(thread_account_id, thread_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date);
      CREATE INDEX IF NOT EXISTS idx_tasks_sort ON tasks(sort_order);

      -- Task tags
      CREATE TABLE IF NOT EXISTS task_tags (
        tag TEXT NOT NULL,
        account_id TEXT,
        color TEXT,
        sort_order INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch()),
        PRIMARY KEY (tag, account_id)
      );

      -- Default settings for auto-drafts
      INSERT OR IGNORE INTO settings (key, value) VALUES
        ('ai_auto_draft_enabled', 'true'),
        ('ai_writing_style_enabled', 'true');
    `,
  },
  {
    version: 19,
    description: "CalDAV calendar integration",
    sql: `
      -- Multi-calendar support
      CREATE TABLE IF NOT EXISTS calendars (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        provider TEXT NOT NULL DEFAULT 'google',
        remote_id TEXT NOT NULL,
        display_name TEXT,
        color TEXT,
        is_primary INTEGER DEFAULT 0,
        is_visible INTEGER DEFAULT 1,
        sync_token TEXT,
        ctag TEXT,
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch()),
        UNIQUE(account_id, remote_id)
      );
      CREATE INDEX IF NOT EXISTS idx_calendars_account ON calendars(account_id);

      -- Extend calendar_events with multi-calendar and CalDAV fields
      ALTER TABLE calendar_events ADD COLUMN calendar_id TEXT REFERENCES calendars(id) ON DELETE CASCADE;
      ALTER TABLE calendar_events ADD COLUMN remote_event_id TEXT;
      ALTER TABLE calendar_events ADD COLUMN etag TEXT;
      ALTER TABLE calendar_events ADD COLUMN ical_data TEXT;
      ALTER TABLE calendar_events ADD COLUMN uid TEXT;

      CREATE INDEX IF NOT EXISTS idx_cal_events_calendar ON calendar_events(calendar_id);

      -- CalDAV fields on accounts
      ALTER TABLE accounts ADD COLUMN caldav_url TEXT;
      ALTER TABLE accounts ADD COLUMN caldav_username TEXT;
      ALTER TABLE accounts ADD COLUMN caldav_password TEXT;
      ALTER TABLE accounts ADD COLUMN caldav_principal_url TEXT;
      ALTER TABLE accounts ADD COLUMN caldav_home_url TEXT;
      ALTER TABLE accounts ADD COLUMN calendar_provider TEXT;
    `,
  },
  {
    version: 20,
    description: "Fix IMAP attachment part IDs and trigger resync",
    sql: `
      -- Delete IMAP attachment records that have wrong sequential part IDs.
      -- They will be re-created with correct MIME section paths on next sync.
      DELETE FROM attachments
        WHERE account_id IN (SELECT id FROM accounts WHERE provider = 'imap');

      -- Reset IMAP folder sync state so delta sync re-fetches all messages,
      -- which will re-store attachments with correct part IDs.
      DELETE FROM folder_sync_state
        WHERE account_id IN (SELECT id FROM accounts WHERE provider = 'imap');
    `,
  },
  {
    version: 21,
    description: "Force IMAP full resync for corrected attachment part IDs",
    sql: `
      -- Clear history_id so syncManager routes IMAP accounts through
      -- imapInitialSync (which stores attachments per-message) instead of
      -- the delta path that may skip already-known UIDs.
      UPDATE accounts SET history_id = NULL
        WHERE provider = 'imap';

      -- Ensure folder sync state is clear (may have been partially
      -- repopulated if v20 migration's sync failed due to DB lock).
      DELETE FROM folder_sync_state
        WHERE account_id IN (SELECT id FROM accounts WHERE provider = 'imap');

      -- Ensure stale attachment records are gone.
      DELETE FROM attachments
        WHERE account_id IN (SELECT id FROM accounts WHERE provider = 'imap');
    `,
  },
  {
    version: 22,
    description: "Add smart label rules table for AI-powered auto-labeling",
    sql: `
      CREATE TABLE smart_label_rules (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        label_id TEXT NOT NULL,
        ai_description TEXT NOT NULL,
        criteria_json TEXT,
        is_enabled INTEGER DEFAULT 1,
        sort_order INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch())
      );
      CREATE INDEX idx_smart_label_rules_account ON smart_label_rules(account_id);
    `,
  },
  {
    version: 23,
    description: "Accept self-signed certificates for IMAP/SMTP",
    sql: `ALTER TABLE accounts ADD COLUMN accept_invalid_certs INTEGER DEFAULT 0;`,
  },
  {
    version: 24,
    description: "AI gateway audit log and revision-keyed AI result cache",
    sql: `
      CREATE TABLE IF NOT EXISTS ai_audit_log (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        feature TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        flag_counts TEXT NOT NULL DEFAULT '{}',
        outcome TEXT NOT NULL DEFAULT 'pending'
      );
      CREATE INDEX IF NOT EXISTS idx_ai_audit_log_created ON ai_audit_log(created_at DESC);

      CREATE TABLE IF NOT EXISTS ai_result_cache (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        source_id TEXT NOT NULL,
        feature TEXT NOT NULL,
        content_revision TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER DEFAULT (unixepoch()),
        UNIQUE(scope, source_id, feature, content_revision, model, prompt_version)
      );
    `,
  },
  {
    version: 25,
    description: "Bounded retries with backoff for scheduled emails",
    sql: `
      ALTER TABLE scheduled_emails ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE scheduled_emails ADD COLUMN next_attempt_at INTEGER;
      ALTER TABLE scheduled_emails ADD COLUMN last_error TEXT;
    `,
  },
  {
    version: 26,
    description: "Tenant-scoped integration accounts and Freshdesk metadata",
    sql: `
      CREATE TABLE IF NOT EXISTS integration_accounts (
        kind TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        tenant_host TEXT NOT NULL,
        me_agent_id TEXT,
        me_name TEXT,
        me_email TEXT,
        connected_at INTEGER NOT NULL DEFAULT (unixepoch()),
        metadata_refreshed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS freshdesk_field_choices (
        tenant_id TEXT NOT NULL,
        field_name TEXT NOT NULL,
        choice_id TEXT NOT NULL,
        label TEXT NOT NULL,
        customer_label TEXT,
        position INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (tenant_id, field_name, choice_id)
      );
      CREATE TABLE IF NOT EXISTS freshdesk_ticket_fields (
        tenant_id TEXT NOT NULL,
        field_id TEXT NOT NULL,
        name TEXT NOT NULL,
        label TEXT NOT NULL,
        type TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0,
        required_for_agents INTEGER NOT NULL DEFAULT 0,
        required_for_closure INTEGER NOT NULL DEFAULT 0,
        position INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (tenant_id, field_id)
      );
      CREATE TABLE IF NOT EXISTS freshdesk_agents (
        tenant_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        name TEXT NOT NULL,
        email TEXT,
        PRIMARY KEY (tenant_id, agent_id)
      );
      CREATE TABLE IF NOT EXISTS freshdesk_groups (
        tenant_id TEXT NOT NULL,
        group_id TEXT NOT NULL,
        name TEXT NOT NULL,
        PRIMARY KEY (tenant_id, group_id)
      );
      CREATE TABLE IF NOT EXISTS freshdesk_status_classes (
        tenant_id TEXT NOT NULL,
        status_id TEXT NOT NULL,
        status_class TEXT NOT NULL CHECK (status_class IN ('open', 'waiting', 'done')),
        PRIMARY KEY (tenant_id, status_id)
      );
    `,
  },
  {
    version: 27,
    description: "Send-as alias for scheduled emails",
    sql: `
      ALTER TABLE scheduled_emails ADD COLUMN from_email TEXT;
    `,
  },
  {
    version: 28,
    description: "Freshdesk ticket cache and sync state",
    sql: `
      CREATE TABLE IF NOT EXISTS freshdesk_tickets (
        tenant_id TEXT NOT NULL,
        ticket_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        status_id TEXT NOT NULL,
        priority_id TEXT,
        requester_id TEXT,
        customer_name TEXT,
        customer_email TEXT,
        responder_id TEXT,
        group_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        fetched_on_demand INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (tenant_id, ticket_id)
      );
      CREATE INDEX IF NOT EXISTS idx_freshdesk_tickets_updated ON freshdesk_tickets(tenant_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS freshdesk_sync_state (
        tenant_id TEXT PRIMARY KEY,
        state TEXT NOT NULL DEFAULT 'idle',
        last_success_at INTEGER,
        last_full_sync_at INTEGER,
        last_attempt_at INTEGER,
        retry_after_until INTEGER,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        outstanding_total INTEGER,
        outstanding_downloaded INTEGER,
        coverage_complete INTEGER NOT NULL DEFAULT 0
      );
    `,
  },
  {
    version: 29,
    description: "Freshdesk conversation history and ticket activity metrics",
    sql: `
      CREATE TABLE IF NOT EXISTS freshdesk_ticket_history (
        tenant_id TEXT NOT NULL,
        ticket_id TEXT NOT NULL,
        ticket_source INTEGER,
        description_html TEXT,
        description_text TEXT,
        attachments_json TEXT NOT NULL DEFAULT '[]',
        history_complete INTEGER NOT NULL DEFAULT 0,
        hydrated_for_updated_at INTEGER,
        hydrated_at INTEGER,
        last_answered_at INTEGER,
        last_answered_unknown INTEGER NOT NULL DEFAULT 0,
        unverified_reply_at INTEGER,
        last_customer_message_at INTEGER,
        last_internal_note_at INTEGER,
        last_activity_at INTEGER,
        PRIMARY KEY (tenant_id, ticket_id)
      );
      CREATE TABLE IF NOT EXISTS freshdesk_conversations (
        tenant_id TEXT NOT NULL,
        ticket_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        user_id TEXT,
        from_email TEXT,
        body_html TEXT,
        body_text TEXT,
        attachments_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, ticket_id, conversation_id)
      );
      CREATE INDEX IF NOT EXISTS idx_freshdesk_conversations_ticket ON freshdesk_conversations(tenant_id, ticket_id, created_at);
    `,
  },
  {
    version: 30,
    description: "ClickUp workspace, metadata, task cache and ticket/email-to-task links",
    sql: `
      CREATE TABLE IF NOT EXISTS clickup_workspace (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        tenant_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        workspace_name TEXT NOT NULL,
        me_user_id TEXT,
        me_name TEXT,
        me_email TEXT,
        connected_at INTEGER NOT NULL DEFAULT (unixepoch()),
        metadata_refreshed_at INTEGER,
        default_list_id TEXT,
        ticket_id_field_id TEXT
      );
      CREATE TABLE IF NOT EXISTS clickup_lists (
        tenant_id TEXT NOT NULL,
        list_id TEXT NOT NULL,
        name TEXT NOT NULL,
        space_name TEXT NOT NULL,
        folder_name TEXT,
        position INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (tenant_id, list_id)
      );
      CREATE TABLE IF NOT EXISTS clickup_statuses (
        tenant_id TEXT NOT NULL,
        list_id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        color TEXT,
        position INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (tenant_id, list_id, name)
      );
      CREATE TABLE IF NOT EXISTS clickup_members (
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        email TEXT,
        PRIMARY KEY (tenant_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS clickup_custom_fields (
        tenant_id TEXT NOT NULL,
        list_id TEXT NOT NULL,
        field_id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        PRIMARY KEY (tenant_id, list_id, field_id)
      );
      CREATE TABLE IF NOT EXISTS clickup_tasks (
        tenant_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        custom_id TEXT,
        name TEXT NOT NULL,
        status_name TEXT NOT NULL,
        status_type TEXT NOT NULL,
        status_color TEXT,
        assignees_json TEXT NOT NULL DEFAULT '[]',
        due_at INTEGER,
        list_id TEXT,
        list_name TEXT,
        url TEXT NOT NULL,
        updated_at INTEGER,
        refreshed_at INTEGER NOT NULL,
        missing INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (tenant_id, task_id)
      );
      CREATE TABLE IF NOT EXISTS clickup_sync_state (
        tenant_id TEXT PRIMARY KEY,
        state TEXT NOT NULL DEFAULT 'idle',
        last_success_at INTEGER,
        last_attempt_at INTEGER,
        retry_after_until INTEGER,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        error_message TEXT
      );
      CREATE TABLE IF NOT EXISTS task_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_kind TEXT NOT NULL CHECK (item_kind IN ('ticket', 'email')),
        scope_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        created_by TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        origin TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'active',
        backlinks_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE (item_kind, scope_id, item_id, workspace_id, task_id)
      );
      CREATE INDEX IF NOT EXISTS idx_task_links_task ON task_links(workspace_id, task_id);
    `,
  },
  {
    version: 31,
    description: "Freshdesk saved ticket views, the selected view, and ticket company, tags and SLA due",
    sql: `
      CREATE TABLE IF NOT EXISTS freshdesk_ticket_views (
        tenant_id TEXT NOT NULL,
        view_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('preset', 'custom')),
        name TEXT NOT NULL,
        filter_json TEXT NOT NULL DEFAULT '{}',
        sort TEXT NOT NULL,
        columns_json TEXT NOT NULL DEFAULT '[]',
        density TEXT NOT NULL,
        presentation TEXT NOT NULL DEFAULT 'list',
        board_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, view_id)
      );
      CREATE TABLE IF NOT EXISTS freshdesk_view_selection (
        tenant_id TEXT PRIMARY KEY,
        view_id TEXT NOT NULL
      );
      ALTER TABLE freshdesk_tickets ADD COLUMN company_id TEXT;
      ALTER TABLE freshdesk_tickets ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE freshdesk_tickets ADD COLUMN due_by INTEGER;
    `,
  },
  {
    version: 32,
    description: "Freshdesk operation journal for remote writes",
    sql: `
      CREATE TABLE IF NOT EXISTS freshdesk_operation_journal (
        entry_id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL,
        ticket_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        changes_json TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('pending', 'confirmed', 'failed', 'unconfirmed')),
        error_message TEXT,
        created_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_freshdesk_journal_ticket ON freshdesk_operation_journal(tenant_id, ticket_id);
    `,
  },
  {
    version: 33,
    description: "Freshdesk ticket drafts and the agent signature",
    sql: `
      CREATE TABLE IF NOT EXISTS freshdesk_ticket_drafts (
        tenant_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        ticket_id TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('reply', 'note')),
        body_html TEXT NOT NULL DEFAULT '',
        cc_json TEXT NOT NULL DEFAULT '[]',
        started_at INTEGER NOT NULL,
        assignee_at_start TEXT,
        unconfirmed_entry_id INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, agent_id, ticket_id, mode)
      );
      ALTER TABLE integration_accounts ADD COLUMN me_signature TEXT;
    `,
  },
  {
    version: 34,
    description: "Scheduled Freshdesk ticket replies, kept apart from scheduled emails",
    sql: `
      CREATE TABLE IF NOT EXISTS freshdesk_scheduled_replies (
        reply_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        ticket_id TEXT NOT NULL,
        subject TEXT NOT NULL DEFAULT '',
        recipient TEXT NOT NULL DEFAULT '',
        body_html TEXT NOT NULL,
        cc_json TEXT NOT NULL DEFAULT '[]',
        send_at INTEGER NOT NULL,
        then_status_id TEXT,
        baseline_started_at INTEGER NOT NULL,
        baseline_assignee TEXT,
        baseline_status TEXT,
        state TEXT NOT NULL DEFAULT 'pending'
          CHECK (state IN ('pending', 'sending', 'held', 'unconfirmed', 'sent', 'failed')),
        hold_reasons_json TEXT NOT NULL DEFAULT '[]',
        journal_entry_id INTEGER,
        claimed_at INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER,
        last_error TEXT,
        status_problem TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_freshdesk_scheduled_replies_due ON freshdesk_scheduled_replies(state, send_at);
    `,
  },
  {
    version: 35,
    description: "Operation journal for ClickUp task creation, keyed by its operation marker",
    sql: `
      CREATE TABLE IF NOT EXISTS clickup_task_operations (
        operation_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        item_kind TEXT NOT NULL CHECK (item_kind IN ('ticket', 'email')),
        scope_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        list_id TEXT NOT NULL,
        task_name TEXT NOT NULL,
        request_json TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('pending', 'confirmed', 'failed', 'unconfirmed')),
        task_id TEXT,
        error_message TEXT,
        created_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_clickup_task_operations_item
        ON clickup_task_operations(workspace_id, item_kind, scope_id, item_id);
    `,
  },
];

/**
 * Split a SQL string into individual statements, correctly handling
 * BEGIN...END blocks (e.g. inside CREATE TRIGGER) that contain semicolons.
 */
function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let depth = 0;
  const upper = sql.toUpperCase();

  for (let i = 0; i < sql.length; i++) {
    // Check for BEGIN keyword at word boundary
    if (
      upper.startsWith("BEGIN", i) &&
      (i === 0 || /\W/.test(sql[i - 1]!)) &&
      (i + 5 >= sql.length || /\W/.test(sql[i + 5]!))
    ) {
      depth++;
    }

    // Check for END keyword at word boundary
    if (
      upper.startsWith("END", i) &&
      (i === 0 || /\W/.test(sql[i - 1]!)) &&
      (i + 3 >= sql.length || /\W/.test(sql[i + 3]!)) &&
      depth > 0
    ) {
      depth--;
    }

    if (sql[i] === ";" && depth === 0) {
      const trimmed = current.trim();
      if (trimmed.length > 0) statements.push(trimmed);
      current = "";
    } else {
      current += sql[i];
    }
  }

  const trimmed = current.trim();
  if (trimmed.length > 0) statements.push(trimmed);

  return statements;
}

export async function runMigrations(): Promise<void> {
  const db = await getDb();

  // Ensure migrations table exists
  await db.execute(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      description TEXT,
      applied_at INTEGER DEFAULT (unixepoch())
    )
  `);

  // Get already-applied versions
  const applied = await db.select<{ version: number }[]>(
    "SELECT version FROM _migrations ORDER BY version",
  );
  const appliedVersions = new Set(applied.map((r) => r.version));

  // Repair: if migration 18 is marked applied but tasks table is missing,
  // remove the stale record so it re-runs
  if (appliedVersions.has(18)) {
    const tables = await db.select<{ name: string }[]>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'",
    );
    if (tables.length === 0) {
      console.warn("Migration v18 marked applied but tasks table missing — re-running");
      await db.execute("DELETE FROM _migrations WHERE version = 18");
      appliedVersions.delete(18);
    }
  }

  // Run pending migrations
  for (const migration of MIGRATIONS) {
    if (appliedVersions.has(migration.version)) continue;

    console.log(
      `Running migration v${migration.version}: ${migration.description}`,
    );

    // Split SQL into individual statements, respecting BEGIN...END blocks
    const statements = splitStatements(migration.sql);

    // Use a transaction so migrations are all-or-nothing
    await db.execute("BEGIN");
    try {
      for (const statement of statements) {
        try {
          await db.execute(statement);
        } catch (err) {
          // Tolerate "duplicate column" errors from ALTER TABLE ADD COLUMN
          // in case a migration was partially applied previously
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("duplicate column")) {
            console.warn(`Skipping duplicate column in v${migration.version}: ${msg}`);
          } else {
            throw err;
          }
        }
      }

      await db.execute(
        "INSERT OR IGNORE INTO _migrations (version, description) VALUES ($1, $2)",
        [migration.version, migration.description],
      );
      await db.execute("COMMIT");
    } catch (err) {
      await db.execute("ROLLBACK").catch(() => {});
      throw err;
    }
  }

  console.log("All migrations applied.");

  // One-time repair: force IMAP attachment resync with corrected Rust binary.
  // Migrations 20/21 may have run before the Rust fix was compiled in.
  // This uses a settings flag so it only runs once.
  const repairFlag = await db.select<{ value: string }[]>(
    "SELECT value FROM settings WHERE key = 'imap_attachment_repair_v1'",
  );
  if (repairFlag.length === 0) {
    const imapAccounts = await db.select<{ id: string }[]>(
      "SELECT id FROM accounts WHERE provider = 'imap'",
    );
    if (imapAccounts.length > 0) {
      console.log("[repair] Forcing IMAP attachment resync with corrected part IDs...");
      await db.execute(
        "DELETE FROM attachments WHERE account_id IN (SELECT id FROM accounts WHERE provider = 'imap')",
      );
      await db.execute(
        "DELETE FROM folder_sync_state WHERE account_id IN (SELECT id FROM accounts WHERE provider = 'imap')",
      );
      await db.execute(
        "UPDATE accounts SET history_id = NULL WHERE provider = 'imap'",
      );
    }
    await db.execute(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('imap_attachment_repair_v1', '1')",
    );
  }
}
