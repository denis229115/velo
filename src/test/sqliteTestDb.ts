import { DatabaseSync, type SQLInputValue } from "node:sqlite";

/**
 * In-memory SQLite database exposing the subset of the Tauri SQL plugin API
 * the service layer uses (`select` / `execute` with `$1`-style parameters).
 * Lets service tests run the real migrations and observe persisted state.
 *
 * Usage: `vi.mock("@/services/db/connection", ...)` so `getDb()` returns it.
 */
export function createSqliteTestDb() {
  const sqlite = new DatabaseSync(":memory:");

  // Tauri's plugin uses `$1`; node:sqlite binds positional arrays to `?1`.
  const toNumbered = (sql: string) => sql.replace(/\$(\d+)/g, "?$1");
  const toInput = (params: unknown[]) =>
    params.map((p) => {
      if (p === undefined) return null;
      if (typeof p === "boolean") return p ? 1 : 0;
      return p as SQLInputValue;
    });

  return {
    async select<T>(sql: string, params: unknown[] = []): Promise<T> {
      return sqlite.prepare(toNumbered(sql)).all(...toInput(params)) as T;
    },
    async execute(
      sql: string,
      params: unknown[] = [],
    ): Promise<{ rowsAffected: number; lastInsertId: number }> {
      if (params.length === 0 && !/\$\d/.test(sql)) {
        const before = sqlite.prepare("SELECT total_changes() AS n").get() as { n: number };
        sqlite.exec(sql);
        const after = sqlite.prepare("SELECT total_changes() AS n").get() as { n: number };
        return { rowsAffected: after.n - before.n, lastInsertId: 0 };
      }
      const result = sqlite.prepare(toNumbered(sql)).run(...toInput(params));
      return {
        rowsAffected: Number(result.changes),
        lastInsertId: Number(result.lastInsertRowid),
      };
    },
    close() {
      sqlite.close();
    },
  };
}

export type SqliteTestDb = ReturnType<typeof createSqliteTestDb>;
