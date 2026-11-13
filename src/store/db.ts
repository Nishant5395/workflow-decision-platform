import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Thin wrapper over Node's built-in `node:sqlite` (no native compilation needed).
 * Adds the `transaction()` helper (nestable via savepoints) the repository relies on.
 */
export interface Stmt {
  run(...args: any[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...args: any[]): any;
  all(...args: any[]): any[];
}

export class Db {
  private depth = 0;
  constructor(private readonly raw: DatabaseSync) {}
  exec(sql: string): void { this.raw.exec(sql); }
  prepare(sql: string): Stmt { return this.raw.prepare(sql) as unknown as Stmt; }
  close(): void { this.raw.close(); }
  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return (...args: A): R => {
      const name = `sp_${this.depth}`;
      this.raw.exec(this.depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${name}`);
      this.depth++;
      try {
        const result = fn(...args);
        this.depth--;
        this.raw.exec(this.depth === 0 ? 'COMMIT' : `RELEASE ${name}`);
        return result;
      } catch (e) {
        this.depth--;
        this.raw.exec(this.depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${name}; RELEASE ${name}`);
        throw e;
      }
    };
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workflow_definitions (
  id          TEXT    NOT NULL,
  version     INTEGER NOT NULL,
  definition  TEXT    NOT NULL,
  created_at  TEXT    NOT NULL,
  created_by  TEXT    NOT NULL,
  change_note TEXT,
  PRIMARY KEY (id, version)
);

-- Which version new requests are routed to. Switching it is how you roll forward / back.
CREATE TABLE IF NOT EXISTS workflow_active (
  id      TEXT PRIMARY KEY,
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS requests (
  id               TEXT    PRIMARY KEY,
  workflow_id      TEXT    NOT NULL,
  workflow_version INTEGER NOT NULL,
  idempotency_key  TEXT    NOT NULL,
  payload_hash     TEXT    NOT NULL,
  payload          TEXT    NOT NULL,
  status           TEXT    NOT NULL,
  current_stage    TEXT,
  context          TEXT    NOT NULL,
  outcome          TEXT,
  retry_count      INTEGER NOT NULL DEFAULT 0,
  next_retry_at    TEXT,
  row_version      INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL,
  -- The idempotency guarantee is enforced by the database, not by application code.
  UNIQUE (workflow_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_requests_status ON requests (status, next_retry_at);

CREATE TABLE IF NOT EXISTS state_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id  TEXT NOT NULL,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  stage       TEXT,
  reason      TEXT NOT NULL,
  actor       TEXT NOT NULL,
  at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_request ON state_history (request_id, id);

-- Append-only, hash-chained audit log.
CREATE TABLE IF NOT EXISTS audit_log (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT,
  ts         TEXT NOT NULL,
  type       TEXT NOT NULL,
  stage      TEXT,
  actor      TEXT NOT NULL,
  data       TEXT NOT NULL,
  prev_hash  TEXT NOT NULL,
  hash       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_request ON audit_log (request_id, seq);

CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS state_history_no_update BEFORE UPDATE ON state_history
BEGIN SELECT RAISE(ABORT, 'state_history is append-only'); END;
CREATE TRIGGER IF NOT EXISTS state_history_no_delete BEFORE DELETE ON state_history
BEGIN SELECT RAISE(ABORT, 'state_history is append-only'); END;
`;

export function openDb(file: string = ':memory:'): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Db(new DatabaseSync(file));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}
