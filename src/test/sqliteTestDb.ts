import { DatabaseSync } from "node:sqlite";

/**
 * A real in-memory SQLite database behind the same select/execute surface as
 * the Tauri SQL plugin, for tests that must prove persisted state.
 */
export function createSqliteTestDb() {
  const sqlite = new DatabaseSync(":memory:");
  // Tauri SQL uses $1-style placeholders; SQLite's numbered form is ?1.
  const toSqlite = (sql: string) => sql.replace(/\$(\d+)/g, "?$1");
  const toParams = (params: unknown[] = []) =>
    params.map((p) => (typeof p === "boolean" ? (p ? 1 : 0) : p === undefined ? null : p));

  return {
    async select<T>(sql: string, params?: unknown[]): Promise<T> {
      return sqlite.prepare(toSqlite(sql)).all(...toParams(params)) as T;
    },
    async execute(sql: string, params?: unknown[]) {
      if (!params || params.length === 0) {
        if (!/\$\d/.test(sql)) {
          sqlite.exec(sql);
          return { rowsAffected: 0, lastInsertId: 0 };
        }
      }
      const result = sqlite.prepare(toSqlite(sql)).run(...toParams(params));
      return { rowsAffected: Number(result.changes), lastInsertId: Number(result.lastInsertRowid) };
    },
    close() {
      sqlite.close();
    },
  };
}

export type SqliteTestDb = ReturnType<typeof createSqliteTestDb>;
