//! The vendored tauri-plugin-sql opens SQLite with ONE connection
//! (vendor/tauri-plugin-sql/src/wrapper.rs). The app runs BEGIN / COMMIT as
//! separate `execute` calls, exactly as these tests do through the pool.

use std::path::PathBuf;
use std::str::FromStr;
use std::time::Duration;

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Connection, Executor, Pool, Row, Sqlite, SqliteConnection};
use tauri_plugin_sql::connect_sqlite_pool;

struct TempDb(PathBuf);

impl TempDb {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "velo-{name}-{}-{:?}.db",
            std::process::id(),
            std::time::SystemTime::now()
        ));
        Self(path)
    }

    fn url(&self) -> String {
        format!("sqlite:{}?mode=rwc", self.0.display())
    }
}

impl Drop for TempDb {
    fn drop(&mut self) {
        for suffix in ["", "-wal", "-shm", "-journal"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", self.0.display()));
        }
    }
}

async fn create_table(pool: &Pool<Sqlite>) {
    pool.execute("CREATE TABLE labels (id INTEGER PRIMARY KEY, name TEXT)")
        .await
        .unwrap();
}

async fn count_committed(db: &TempDb) -> i64 {
    // A fresh connection only sees committed rows.
    let mut conn = SqliteConnection::connect(&db.url()).await.unwrap();
    let row = sqlx::query("SELECT COUNT(*) AS n FROM labels")
        .fetch_one(&mut conn)
        .await
        .unwrap();
    row.get::<i64, _>("n")
}

/// Opens connections the way the app's concurrent UI reads do.
async fn warm_up(pool: &Pool<Sqlite>, readers: usize) {
    let reads = (0..readers).map(|_| async {
        let mut conn = pool.acquire().await.unwrap();
        conn.execute("SELECT 1").await.unwrap();
        tokio::time::sleep(Duration::from_millis(20)).await;
    });
    futures::future::join_all(reads).await;
}

/// `withTransaction` from src/services/db/connection.ts: each statement is its
/// own `execute` call on the pool.
async fn js_style_transaction(pool: &Pool<Sqlite>, names: &[&str]) -> Result<(), sqlx::Error> {
    pool.execute("BEGIN TRANSACTION").await?;
    for name in names {
        sqlx::query("INSERT INTO labels (name) VALUES (?)")
            .bind(*name)
            .execute(pool)
            .await?;
    }
    pool.execute("COMMIT").await?;
    Ok(())
}

#[tokio::test]
async fn pool_has_exactly_one_connection() {
    let db = TempDb::new("one-conn");
    let pool = connect_sqlite_pool(&db.url()).await.unwrap();

    assert_eq!(pool.options().get_max_connections(), 1);
    // Recycling the connection mid-transaction would roll the transaction back.
    assert_eq!(pool.options().get_max_lifetime(), None);
    assert_eq!(pool.options().get_idle_timeout(), None);
    warm_up(&pool, 8).await;
    assert_eq!(pool.size(), 1);

    let timeout: i64 = sqlx::query("PRAGMA busy_timeout")
        .fetch_one(&pool)
        .await
        .unwrap()
        .get(0);
    assert_eq!(timeout, 30_000);
}

#[tokio::test]
async fn begin_insert_commit_from_separate_execute_calls() {
    let db = TempDb::new("commit");
    let pool = connect_sqlite_pool(&db.url()).await.unwrap();
    create_table(&pool).await;
    warm_up(&pool, 8).await;

    js_style_transaction(&pool, &["INBOX", "Sent", "Drafts", "Trash"])
        .await
        .unwrap();
    assert_eq!(count_committed(&db).await, 4);

    // ROLLBACK through separate calls undoes the transaction's writes.
    pool.execute("BEGIN TRANSACTION").await.unwrap();
    pool.execute("INSERT INTO labels (name) VALUES ('Spam')")
        .await
        .unwrap();
    pool.execute("ROLLBACK").await.unwrap();
    assert_eq!(count_committed(&db).await, 4);
}

#[tokio::test]
async fn second_begin_reports_within_a_transaction() {
    // src/services/db/connection.ts retries BEGIN on this message, for a
    // transaction opened by another window on the shared connection.
    let db = TempDb::new("nested");
    let pool = connect_sqlite_pool(&db.url()).await.unwrap();
    pool.execute("BEGIN TRANSACTION").await.unwrap();
    let err = pool.execute("BEGIN TRANSACTION").await.unwrap_err();
    assert!(
        err.to_string().contains("within a transaction"),
        "unexpected error: {err}"
    );
    pool.execute("COMMIT").await.unwrap();
}

#[tokio::test]
async fn write_outside_the_transaction_does_not_lock_on_one_connection() {
    // Calendar/label upserts run outside the JS transaction mutex while a sync
    // transaction is open. On one connection they join it instead of waiting.
    let db = TempDb::new("outside");
    let pool = connect_sqlite_pool(&db.url()).await.unwrap();
    create_table(&pool).await;

    pool.execute("BEGIN TRANSACTION").await.unwrap();
    pool.execute("INSERT INTO labels (name) VALUES ('INBOX')")
        .await
        .unwrap();
    let outside = tokio::time::timeout(
        Duration::from_secs(2),
        pool.execute("INSERT INTO labels (name) VALUES ('calendar')"),
    )
    .await
    .expect("write outside the transaction must not wait for a lock");
    outside.unwrap();
    pool.execute("COMMIT").await.unwrap();
    assert_eq!(count_committed(&db).await, 2);
}

/// IMAP sync: a `withTransaction` batch while calendar/label upserts run outside
/// the JS mutex. Returns the first error of either side.
async fn sync_batch_with_outside_writes(pool: &Pool<Sqlite>) -> Result<(), sqlx::Error> {
    let names: Vec<String> = (0..20).map(|i| format!("folder-{i}")).collect();
    let names: Vec<&str> = names.iter().map(String::as_str).collect();
    let outside = async {
        for i in 0..20 {
            sqlx::query("INSERT INTO labels (name) VALUES (?)")
                .bind(format!("calendar-{i}"))
                .execute(pool)
                .await?;
            tokio::task::yield_now().await;
        }
        Ok::<(), sqlx::Error>(())
    };
    let (tx, outside) = tokio::join!(js_style_transaction(pool, &names), outside);
    tx.and(outside)
}

#[tokio::test]
async fn old_pool_locks_during_sync_and_one_connection_does_not() {
    // Old pool, busy timeout shortened from 5 s: some statement waits on a write
    // lock whose COMMIT is queued behind it ("database is locked"), or, more
    // rarely, COMMIT lands on a connection without the transaction.
    let old_db = TempDb::new("old-sync");
    let options = SqliteConnectOptions::from_str(&old_db.url())
        .unwrap()
        .busy_timeout(Duration::from_millis(300));
    let old_pool = SqlitePoolOptions::new()
        .max_connections(10)
        .connect_with(options)
        .await
        .unwrap();
    create_table(&old_pool).await;
    warm_up(&old_pool, 3).await;
    let err = sync_batch_with_outside_writes(&old_pool)
        .await
        .expect_err("the old pool should fail");
    let message = err.to_string();
    assert!(
        message.contains("database is locked") || message.contains("no transaction is active"),
        "unexpected error: {message}"
    );

    let db = TempDb::new("new-sync");
    let pool = connect_sqlite_pool(&db.url()).await.unwrap();
    create_table(&pool).await;
    warm_up(&pool, 3).await;
    sync_batch_with_outside_writes(&pool).await.unwrap();
    assert_eq!(count_committed(&db).await, 40);
}
