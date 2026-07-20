import {
  isExpired,
  sortForFlush,
  type Message,
} from "@ntnkit/core";
import type { Outbox, OutboxStats } from "@ntnkit/sdk";
import type Database from "better-sqlite3";
import { messageToRow, rowToMessage, type MessageRow } from "./codec.js";

export class SqliteOutbox implements Outbox {
  constructor(private readonly db: Database.Database) {}

  async enqueue(message: Message): Promise<string | undefined> {
    const row = messageToRow(message);
    let replacedId: string | undefined;

    const run = this.db.transaction(() => {
      if (message.dedupKey) {
        const existing = this.db
          .prepare(
            "SELECT id FROM messages WHERE dedup_key = ? AND id != ?",
          )
          .get(message.dedupKey, message.id) as { id: string } | undefined;
        if (existing) {
          this.db.prepare("DELETE FROM messages WHERE id = ?").run(existing.id);
          this.db.prepare("DELETE FROM attempts WHERE id = ?").run(existing.id);
          replacedId = existing.id;
        }
      }

      this.db
        .prepare(
          `INSERT INTO messages (
            id, payload, priority, ttl_ms, created_at_ms, dedup_key,
            max_bytes, delivery, content_type, metadata_json
          ) VALUES (
            @id, @payload, @priority, @ttl_ms, @created_at_ms, @dedup_key,
            @max_bytes, @delivery, @content_type, @metadata_json
          )
          ON CONFLICT(id) DO UPDATE SET
            payload = excluded.payload,
            priority = excluded.priority,
            ttl_ms = excluded.ttl_ms,
            created_at_ms = excluded.created_at_ms,
            dedup_key = excluded.dedup_key,
            max_bytes = excluded.max_bytes,
            delivery = excluded.delivery,
            content_type = excluded.content_type,
            metadata_json = excluded.metadata_json`,
        )
        .run(row);
    });

    run();
    return replacedId;
  }

  async remove(id: string): Promise<boolean> {
    const run = this.db.transaction(() => {
      const result = this.db.prepare("DELETE FROM messages WHERE id = ?").run(id);
      if (result.changes > 0) {
        this.db.prepare("DELETE FROM attempts WHERE id = ?").run(id);
        return true;
      }
      return false;
    });
    return run();
  }

  async removeByDedupKey(dedupKey: string): Promise<string | undefined> {
    const run = this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT id FROM messages WHERE dedup_key = ?")
        .get(dedupKey) as { id: string } | undefined;
      if (!row) return undefined;
      this.db.prepare("DELETE FROM messages WHERE id = ?").run(row.id);
      this.db.prepare("DELETE FROM attempts WHERE id = ?").run(row.id);
      return row.id;
    });
    return run();
  }

  async has(id: string): Promise<boolean> {
    const row = this.db
      .prepare("SELECT 1 AS ok FROM messages WHERE id = ?")
      .get(id) as { ok: number } | undefined;
    return row !== undefined;
  }

  async pruneExpired(now = Date.now()): Promise<Message[]> {
    const rows = this.db
      .prepare("SELECT * FROM messages")
      .all() as MessageRow[];
    const expired: Message[] = [];
    const del = this.db.prepare("DELETE FROM messages WHERE id = ?");
    const delAttempt = this.db.prepare("DELETE FROM attempts WHERE id = ?");

    const run = this.db.transaction(() => {
      for (const row of rows) {
        const msg = rowToMessage(row);
        if (isExpired(msg, now)) {
          expired.push(msg);
          del.run(msg.id);
          delAttempt.run(msg.id);
        }
      }
    });
    run();
    return expired;
  }

  async list(now = Date.now()): Promise<Message[]> {
    await this.pruneExpired(now);
    const rows = this.db
      .prepare("SELECT * FROM messages")
      .all() as MessageRow[];
    return sortForFlush(rows.map(rowToMessage));
  }

  async stats(now = Date.now()): Promise<OutboxStats> {
    const rows = this.db
      .prepare("SELECT created_at_ms FROM messages")
      .all() as { created_at_ms: number }[];
    if (rows.length === 0) {
      return { depth: 0, oldestAgeMs: null };
    }
    let oldest = Number.POSITIVE_INFINITY;
    for (const row of rows) {
      if (row.created_at_ms < oldest) oldest = row.created_at_ms;
    }
    return {
      depth: rows.length,
      oldestAgeMs: now - oldest,
    };
  }
}
