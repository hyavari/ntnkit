import type Database from "better-sqlite3";

export const SCHEMA_VERSION = 1;

export function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY NOT NULL,
      payload BLOB NOT NULL,
      priority INTEGER NOT NULL,
      ttl_ms INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      dedup_key TEXT,
      max_bytes INTEGER,
      delivery TEXT NOT NULL,
      content_type TEXT,
      metadata_json TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS messages_dedup_key
      ON messages(dedup_key)
      WHERE dedup_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS attempts (
      id TEXT PRIMARY KEY NOT NULL,
      attempts INTEGER NOT NULL,
      next_allowed_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS budget (
      id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
      day_key TEXT NOT NULL,
      used_bytes INTEGER NOT NULL
    );
  `);

  const row = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string } | undefined;

  if (!row) {
    db.prepare(
      "INSERT INTO meta (key, value) VALUES ('schema_version', ?)",
    ).run(String(SCHEMA_VERSION));
    return;
  }

  const version = Number(row.value);
  if (version !== SCHEMA_VERSION) {
    throw new Error(
      `unsupported outbox schema_version ${version}; expected ${SCHEMA_VERSION}`,
    );
  }
}
