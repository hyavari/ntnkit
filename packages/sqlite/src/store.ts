import type { AttemptState, DurableStore, Outbox } from "@ntnkit/sdk";
import Database from "better-sqlite3";
import { migrate } from "./migrate.js";
import { SqliteOutbox } from "./outbox.js";

export interface OpenSqliteStoreOptions {
  /** File path, or `:memory:` for tests. */
  path: string;
}

class SqliteStore implements DurableStore {
  readonly outbox: Outbox;
  private closed = false;

  constructor(private readonly db: Database.Database) {
    this.outbox = new SqliteOutbox(db);
  }

  async loadAttempts(): Promise<ReadonlyMap<string, AttemptState>> {
    this.assertOpen();
    const rows = this.db
      .prepare("SELECT id, attempts, next_allowed_at FROM attempts")
      .all() as { id: string; attempts: number; next_allowed_at: number }[];
    const map = new Map<string, AttemptState>();
    for (const row of rows) {
      map.set(row.id, {
        attempts: row.attempts,
        nextAllowedAt: row.next_allowed_at,
      });
    }
    return map;
  }

  async saveAttempt(id: string, state: AttemptState): Promise<void> {
    this.assertOpen();
    this.db
      .prepare(
        `INSERT INTO attempts (id, attempts, next_allowed_at)
         VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           attempts = excluded.attempts,
           next_allowed_at = excluded.next_allowed_at`,
      )
      .run(id, state.attempts, state.nextAllowedAt);
  }

  async clearAttempt(id: string): Promise<void> {
    this.assertOpen();
    this.db.prepare("DELETE FROM attempts WHERE id = ?").run(id);
  }

  async clearAllAttempts(): Promise<void> {
    this.assertOpen();
    this.db.prepare("DELETE FROM attempts").run();
  }

  async loadBudget(): Promise<{ dayKey: string; usedBytes: number } | null> {
    this.assertOpen();
    const row = this.db
      .prepare("SELECT day_key, used_bytes FROM budget WHERE id = 1")
      .get() as { day_key: string; used_bytes: number } | undefined;
    if (!row) return null;
    return { dayKey: row.day_key, usedBytes: row.used_bytes };
  }

  async saveBudget(state: {
    dayKey: string;
    usedBytes: number;
  }): Promise<void> {
    this.assertOpen();
    this.db
      .prepare(
        `INSERT INTO budget (id, day_key, used_bytes)
         VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           day_key = excluded.day_key,
           used_bytes = excluded.used_bytes`,
      )
      .run(state.dayKey, state.usedBytes);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("sqlite store is closed");
    }
  }
}

export async function openSqliteStore(
  options: OpenSqliteStoreOptions,
): Promise<DurableStore> {
  const db = new Database(options.path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return new SqliteStore(db);
}
