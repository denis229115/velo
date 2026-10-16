// Minimal typings for Node's built-in SQLite (the project has no @types/node).
// Only what src/test/sqliteTestDb.ts uses.
declare module "node:sqlite" {
  export type SQLInputValue = null | number | bigint | string | Uint8Array;

  interface StatementSync {
    all(...params: SQLInputValue[]): unknown[];
    get(...params: SQLInputValue[]): unknown;
    run(...params: SQLInputValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  }

  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
