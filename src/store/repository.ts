import { randomUUID } from 'node:crypto';
import { ConcurrencyError, IllegalTransitionError, NotFoundError } from '../domain/errors';
import { assertTransition } from '../domain/lifecycle';
import type {
  AuditEvent, AuditEventInput, Json, Outcome, RequestContext, RequestRecord, RequestStatus, StateChange, WorkflowDefinition,
} from '../domain/types';
import { canonicalJson, Clock, sha256, systemClock } from '../domain/util';
import type { Db } from './db';

export const GENESIS_HASH = '0'.repeat(64);

export interface StepPatch {
  status?: RequestStatus;
  currentStage?: string | null;
  context?: RequestContext;
  outcome?: Outcome | null;
  retryCount?: number;
  nextRetryAt?: string | null;
}
export interface HistoryInput { reason: string; actor: string }

export interface NewRequest {
  workflowId: string;
  workflowVersion: number;
  idempotencyKey: string;
  payloadHash: string;
  payload: Json;
  context: RequestContext;
  actor: string;
}

export interface ChainVerification { valid: boolean; checked: number; brokenAtSeq?: number; reason?: string }

/**
 * All persistence lives here. The important property: **one stage's outcome is
 * saved in one transaction** (`commitStep`): audit events + request state +
 * history row either all land or none do. Nothing else in the system writes
 * request state.
 */
export class Repository {
  /** Fault injection for tests/demos: make the next N commits fail mid-transaction. */
  readonly faults = { failNextCommits: 0 };

  constructor(readonly db: Db, private readonly clock: Clock = systemClock) {}

  // ---- Workflow definitions ------------------------------------------------

  saveWorkflowVersion(def: WorkflowDefinition, createdBy: string, changeNote?: string, activate = true): number {
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM workflow_definitions WHERE id = ?').get(def.id) as { v: number };
      const version = row.v + 1;
      const stored = { ...def, version };
      this.db.prepare('INSERT INTO workflow_definitions (id, version, definition, created_at, created_by, change_note) VALUES (?,?,?,?,?,?)')
        .run(def.id, version, JSON.stringify(stored), this.clock.now().toISOString(), createdBy, changeNote ?? null);
      if (activate) this.setActiveVersion(def.id, version);
      this.insertAudit([{ type: 'workflow_published', actor: createdBy, data: { workflowId: def.id, version, activated: activate, changeNote: changeNote ?? null } }]);
      return version;
    })();
  }

  setActiveVersion(id: string, version: number): void {
    this.db.prepare('INSERT INTO workflow_active (id, version) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version').run(id, version);
  }

  activateVersion(id: string, version: number, actor: string): void {
    if (!this.getWorkflow(id, version)) throw new NotFoundError(`Workflow ${id} v${version} not found`);
    this.db.transaction(() => {
      this.setActiveVersion(id, version);
      this.insertAudit([{ type: 'workflow_activated', actor, data: { workflowId: id, version } }]);
    })();
  }

  getWorkflow(id: string, version: number): WorkflowDefinition | null {
    const row = this.db.prepare('SELECT definition FROM workflow_definitions WHERE id = ? AND version = ?').get(id, version) as { definition: string } | undefined;
    return row ? (JSON.parse(row.definition) as WorkflowDefinition) : null;
  }

  getActiveWorkflow(id: string): WorkflowDefinition | null {
    const row = this.db.prepare('SELECT version FROM workflow_active WHERE id = ?').get(id) as { version: number } | undefined;
    return row ? this.getWorkflow(id, row.version) : null;
  }

  listWorkflows(): { id: string; name: string; activeVersion: number; versions: number[] }[] {
    const active = this.db.prepare('SELECT id, version FROM workflow_active ORDER BY id').all() as { id: string; version: number }[];
    return active.map((a) => {
      const def = this.getWorkflow(a.id, a.version)!;
      const versions = (this.db.prepare('SELECT version FROM workflow_definitions WHERE id = ? ORDER BY version').all(a.id) as { version: number }[]).map((r) => r.version);
      return { id: a.id, name: def.name, activeVersion: a.version, versions };
    });
  }

  listVersions(id: string): { version: number; createdAt: string; createdBy: string; changeNote: string | null }[] {
    return (this.db.prepare('SELECT version, created_at, created_by, change_note FROM workflow_definitions WHERE id = ? ORDER BY version').all(id) as
      { version: number; created_at: string; created_by: string; change_note: string | null }[])
      .map((r) => ({ version: r.version, createdAt: r.created_at, createdBy: r.created_by, changeNote: r.change_note }));
  }

  // ---- Requests ------------------------------------------------------------

  /**
   * Insert a new request, or return the existing one for the same
   * (workflow, idempotency key). Atomic; the UNIQUE constraint is the final arbiter
   * if two callers race.
   */
  createRequest(n: NewRequest): { created: boolean; request: RequestRecord } {
    return this.db.transaction(() => {
      const existing = this.findByKey(n.workflowId, n.idempotencyKey);
      if (existing) return { created: false, request: existing };
      const now = this.clock.now().toISOString();
      const id = randomUUID();
      this.db.prepare(`INSERT INTO requests
        (id, workflow_id, workflow_version, idempotency_key, payload_hash, payload, status, current_stage, context, outcome, retry_count, next_retry_at, row_version, created_at, updated_at)
        VALUES (?,?,?,?,?,?, 'RECEIVED', NULL, ?, NULL, 0, NULL, 0, ?, ?)`)
        .run(id, n.workflowId, n.workflowVersion, n.idempotencyKey, n.payloadHash, JSON.stringify(n.payload), JSON.stringify(n.context), now, now);
      this.db.prepare('INSERT INTO state_history (request_id, from_status, to_status, stage, reason, actor, at) VALUES (?,?,?,?,?,?,?)')
        .run(id, null, 'RECEIVED', null, 'Request accepted', n.actor, now);
      this.insertAudit([{
        requestId: id, type: 'request_received', actor: n.actor,
        data: { workflowId: n.workflowId, workflowVersion: n.workflowVersion, idempotencyKey: n.idempotencyKey, payloadHash: n.payloadHash, payload: n.payload },
      }]);
      return { created: true, request: this.getRequest(id)! };
    })();
  }

  findByKey(workflowId: string, key: string): RequestRecord | null {
    const row = this.db.prepare('SELECT * FROM requests WHERE workflow_id = ? AND idempotency_key = ?').get(workflowId, key);
    return row ? this.mapRequest(row as RequestRow) : null;
  }

  getRequest(id: string): RequestRecord | null {
    const row = this.db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
    return row ? this.mapRequest(row as RequestRow) : null;
  }

  requireRequest(id: string): RequestRecord {
    const r = this.getRequest(id);
    if (!r) throw new NotFoundError(`Request ${id} not found`);
    return r;
  }

  listRequests(filter: { status?: string; workflowId?: string; limit?: number } = {}): RequestRecord[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.status) { where.push('status = ?'); args.push(filter.status); }
    if (filter.workflowId) { where.push('workflow_id = ?'); args.push(filter.workflowId); }
    const sql = `SELECT * FROM requests ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC, rowid DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...args, filter.limit ?? 100) as RequestRow[]).map((r) => this.mapRequest(r));
  }

  /** Requests parked for retry whose time has come. */
  dueRetries(): RequestRecord[] {
    const rows = this.db.prepare("SELECT * FROM requests WHERE status = 'PENDING_RETRY' AND (next_retry_at IS NULL OR next_retry_at <= ?) ORDER BY next_retry_at").all(this.clock.now().toISOString());
    return (rows as RequestRow[]).map((r) => this.mapRequest(r));
  }

  /** Requests left IN_PROGRESS / RECEIVED (crash or persistence failure) for longer than `olderThanMs`. */
  stuckRequests(olderThanMs: number): RequestRecord[] {
    const cutoff = new Date(this.clock.now().getTime() - olderThanMs).toISOString();
    const rows = this.db.prepare("SELECT * FROM requests WHERE status IN ('RECEIVED','IN_PROGRESS') AND updated_at <= ? ORDER BY created_at").all(cutoff);
    return (rows as RequestRow[]).map((r) => this.mapRequest(r));
  }

  /**
   * Atomically apply one step: audit events, request update (guarded by optimistic
   * locking on `row_version`) and, if the status changed, a state-history row.
   */
  commitStep(requestId: string, expectedRowVersion: number, patch: StepPatch, history: HistoryInput | null, events: AuditEventInput[]): RequestRecord {
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM requests WHERE id = ?').get(requestId) as RequestRow | undefined;
      if (!row) throw new NotFoundError(`Request ${requestId} not found`);
      if (row.row_version !== expectedRowVersion) {
        throw new ConcurrencyError(`Request ${requestId} was modified concurrently (expected v${expectedRowVersion}, found v${row.row_version})`);
      }
      const from = row.status as RequestStatus;
      const statusChanges = patch.status !== undefined && patch.status !== from;
      if (statusChanges) assertTransition(from, patch.status!);
      else if (from !== 'IN_PROGRESS') throw new IllegalTransitionError(`Request is ${from}; it cannot be updated in place`);

      this.insertAudit(events.map((e) => ({ ...e, requestId })));

      // Simulated "partial save" failure: audit rows are written, then the update fails.
      // The surrounding transaction must roll everything back.
      if (this.faults.failNextCommits > 0) {
        this.faults.failNextCommits--;
        throw new Error('Simulated persistence failure during commit');
      }

      const now = this.clock.now().toISOString();
      const sets: string[] = ['row_version = row_version + 1', 'updated_at = ?'];
      const args: unknown[] = [now];
      const set = (col: string, v: unknown) => { sets.push(`${col} = ?`); args.push(v); };
      if (patch.status !== undefined) set('status', patch.status);
      if (patch.currentStage !== undefined) set('current_stage', patch.currentStage);
      if (patch.context !== undefined) set('context', JSON.stringify(patch.context));
      if (patch.outcome !== undefined) set('outcome', patch.outcome === null ? null : JSON.stringify(patch.outcome));
      if (patch.retryCount !== undefined) set('retry_count', patch.retryCount);
      if (patch.nextRetryAt !== undefined) set('next_retry_at', patch.nextRetryAt);
      const info = this.db.prepare(`UPDATE requests SET ${sets.join(', ')} WHERE id = ? AND row_version = ?`).run(...args, requestId, expectedRowVersion);
      if (info.changes !== 1) throw new ConcurrencyError(`Request ${requestId} was modified concurrently`);

      if (statusChanges) {
        this.db.prepare('INSERT INTO state_history (request_id, from_status, to_status, stage, reason, actor, at) VALUES (?,?,?,?,?,?,?)')
          .run(requestId, from, patch.status, patch.currentStage ?? row.current_stage, history?.reason ?? 'state change', history?.actor ?? 'system', now);
      }
      return this.getRequest(requestId)!;
    })();
  }

  // ---- History & audit -----------------------------------------------------

  getHistory(requestId: string): StateChange[] {
    return (this.db.prepare('SELECT * FROM state_history WHERE request_id = ? ORDER BY id').all(requestId) as {
      id: number; request_id: string; from_status: RequestStatus | null; to_status: RequestStatus; stage: string | null; reason: string; actor: string; at: string;
    }[]).map((r) => ({ id: r.id, requestId: r.request_id, fromStatus: r.from_status, toStatus: r.to_status, stage: r.stage, reason: r.reason, actor: r.actor, at: r.at }));
  }

  /** Standalone atomic audit append (intake rejections, duplicates, persistence failures...). */
  appendAudit(events: AuditEventInput[]): void {
    this.db.transaction(() => this.insertAudit(events))();
  }

  getAudit(requestId?: string): AuditEvent[] {
    const rows = (requestId
      ? this.db.prepare('SELECT * FROM audit_log WHERE request_id = ? ORDER BY seq').all(requestId)
      : this.db.prepare('SELECT * FROM audit_log ORDER BY seq DESC LIMIT 500').all()) as AuditRow[];
    return rows.map(mapAudit);
  }

  /** Recompute the whole hash chain; any edit, deletion or reordering breaks it. */
  verifyAuditChain(): ChainVerification {
    const rows = this.db.prepare('SELECT * FROM audit_log ORDER BY seq').all() as AuditRow[];
    let prev = GENESIS_HASH;
    for (const r of rows) {
      if (r.prev_hash !== prev) return { valid: false, checked: rows.indexOf(r), brokenAtSeq: r.seq, reason: 'prev_hash does not match previous entry (entry removed or reordered)' };
      if (computeHash(r.prev_hash, r.request_id, r.ts, r.type, r.stage, r.actor, r.data) !== r.hash) {
        return { valid: false, checked: rows.indexOf(r), brokenAtSeq: r.seq, reason: 'entry content does not match its hash (entry modified)' };
      }
      prev = r.hash;
    }
    return { valid: true, checked: rows.length };
  }

  private insertAudit(events: AuditEventInput[]): void {
    if (events.length === 0) return;
    const last = this.db.prepare('SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1').get() as { hash: string } | undefined;
    let prev = last?.hash ?? GENESIS_HASH;
    const ts = this.clock.now().toISOString();
    const stmt = this.db.prepare('INSERT INTO audit_log (request_id, ts, type, stage, actor, data, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?)');
    for (const e of events) {
      const data = canonicalJson(e.data ?? null);
      const actor = e.actor ?? 'system';
      const hash = computeHash(prev, e.requestId ?? null, ts, e.type, e.stage ?? null, actor, data);
      stmt.run(e.requestId ?? null, ts, e.type, e.stage ?? null, actor, data, prev, hash);
      prev = hash;
    }
  }

  private mapRequest(r: RequestRow): RequestRecord {
    return {
      id: r.id, workflowId: r.workflow_id, workflowVersion: r.workflow_version, idempotencyKey: r.idempotency_key,
      payloadHash: r.payload_hash, payload: JSON.parse(r.payload), status: r.status as RequestStatus, currentStage: r.current_stage,
      context: JSON.parse(r.context), outcome: r.outcome ? JSON.parse(r.outcome) : null, retryCount: r.retry_count,
      nextRetryAt: r.next_retry_at, rowVersion: r.row_version, createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }
}

function computeHash(prev: string, requestId: string | null, ts: string, type: string, stage: string | null, actor: string, data: string): string {
  return sha256([prev, requestId ?? '', ts, type, stage ?? '', actor, data].join('|'));
}

interface RequestRow {
  id: string; workflow_id: string; workflow_version: number; idempotency_key: string; payload_hash: string; payload: string;
  status: string; current_stage: string | null; context: string; outcome: string | null; retry_count: number;
  next_retry_at: string | null; row_version: number; created_at: string; updated_at: string;
}
interface AuditRow { seq: number; request_id: string | null; ts: string; type: string; stage: string | null; actor: string; data: string; prev_hash: string; hash: string }

function mapAudit(r: AuditRow): AuditEvent {
  return { seq: r.seq, requestId: r.request_id, ts: r.ts, type: r.type, stage: r.stage, actor: r.actor, data: JSON.parse(r.data), prevHash: r.prev_hash, hash: r.hash };
}
