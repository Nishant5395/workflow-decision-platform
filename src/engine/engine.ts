import { ConcurrencyError, ConflictError, IllegalTransitionError, NotFoundError, ValidationError, ConfigError } from '../domain/errors';
import type { DependencyRegistry } from '../dependencies/types';
import type { Json, Outcome, RequestRecord, WorkflowDefinition } from '../domain/types';
import { canonicalJson, Clock, getPath, realSleep, sha256, Sleep, systemClock } from '../domain/util';
import { ajv, validateDefinition, DefinitionValidation } from '../config/validator';
import type { Repository } from '../store/repository';
import { buildExplanation, Explanation } from './explain';
import { WorkflowExecutor } from './executor';
import type { ValidateFunction } from 'ajv';

export interface EngineOptions {
  repo: Repository;
  dependencies: DependencyRegistry;
  clock?: Clock;
  sleep?: Sleep;
  log?: (msg: string, extra?: unknown) => void;
}

export interface SubmitInput {
  workflowId: string;
  payload: unknown;
  /** Client-supplied Idempotency-Key. When absent a key is derived from the payload / configured key fields. */
  idempotencyKey?: string;
  actor?: string;
}

/**
 * Application service. The API layer talks only to this class; it owns the
 * request lifecycle (intake → idempotency → execution → retry / review).
 */
export class WorkflowEngine {
  readonly repo: Repository;
  readonly dependencies: DependencyRegistry;
  private readonly clock: Clock;
  private readonly executor: WorkflowExecutor;
  private readonly log: (msg: string, extra?: unknown) => void;
  private readonly validators = new Map<string, ValidateFunction>();

  constructor(o: EngineOptions) {
    this.repo = o.repo;
    this.dependencies = o.dependencies;
    this.clock = o.clock ?? systemClock;
    this.log = o.log ?? (() => undefined);
    this.executor = new WorkflowExecutor({ repo: o.repo, dependencies: o.dependencies, clock: this.clock, sleep: o.sleep ?? realSleep, log: this.log });
  }

  // ---- Configuration --------------------------------------------------------

  validateWorkflow(def: unknown): DefinitionValidation {
    return validateDefinition(def, this.dependencies.names());
  }

  /** Validate, then store as a new immutable version (optionally activating it). */
  publishWorkflow(def: unknown, opts: { actor?: string; changeNote?: string; activate?: boolean } = {}): { id: string; version: number; warnings: string[] } {
    const result = this.validateWorkflow(def);
    if (result.errors.length > 0) throw new ConfigError('Workflow definition is invalid', result.errors);
    const d = def as WorkflowDefinition;
    const version = this.repo.saveWorkflowVersion(d, opts.actor ?? 'admin', opts.changeNote, opts.activate ?? true);
    return { id: d.id, version, warnings: result.warnings };
  }

  // ---- Intake ---------------------------------------------------------------

  async submit(input: SubmitInput): Promise<{ request: RequestRecord; replayed: boolean }> {
    const actor = input.actor ?? 'api';
    const def = this.repo.getActiveWorkflow(input.workflowId);
    if (!def) throw new NotFoundError(`Unknown workflow "${input.workflowId}"`);

    // 1. Schema validation. Invalid input never creates a request, but it is audited.
    const validate = this.validatorFor(def);
    if (!validate(input.payload)) {
      const errors = (validate.errors ?? []).map((e) => ({ path: e.instancePath || '/', message: e.message ?? 'invalid', keyword: e.keyword, params: e.params as Json }));
      this.repo.appendAudit([{ type: 'intake_rejected', actor, data: { workflowId: def.id, workflowVersion: def.version!, errors: errors as unknown as Json } }]);
      throw new ValidationError('Request payload failed schema validation', errors);
    }
    const payload = input.payload as Json;

    // 2. Idempotency. Same key + same payload => same request. Same key + other payload => conflict.
    const payloadHash = sha256(canonicalJson(payload));
    const key = this.resolveKey(def, payload, input.idempotencyKey);
    const { created, request } = this.repo.createRequest({
      workflowId: def.id, workflowVersion: def.version!, idempotencyKey: key, payloadHash, payload,
      context: { deps: {}, flags: [], reasons: [], path: [], steps: 0 }, actor,
    });
    if (!created) {
      if (request.payloadHash !== payloadHash) {
        this.repo.appendAudit([{ requestId: request.id, type: 'idempotency_conflict', actor, data: { idempotencyKey: key, existingPayloadHash: request.payloadHash, newPayloadHash: payloadHash } }]);
        throw new ConflictError(`Idempotency key "${key}" was already used with a different payload (request ${request.id})`);
      }
      this.repo.appendAudit([{ requestId: request.id, type: 'duplicate_request_replayed', actor, data: { idempotencyKey: key, status: request.status } }]);
      return { request, replayed: true };
    }

    // 3. Execute.
    return { request: await this.start(request, def, actor), replayed: false };
  }

  private async start(req: RequestRecord, def: WorkflowDefinition, actor: string): Promise<RequestRecord> {
    let started: RequestRecord;
    try {
      started = this.repo.commitStep(
        req.id, req.rowVersion, { status: 'IN_PROGRESS', currentStage: def.initialStage },
        { reason: `Input validated; workflow ${def.id} v${def.version} started`, actor },
        [
          { type: 'input_validated', data: { workflowId: def.id, workflowVersion: def.version! } },
          { type: 'state_changed', stage: def.initialStage, data: { from: 'RECEIVED', to: 'IN_PROGRESS', reason: 'workflow started' } },
        ],
      );
    } catch (e) {
      if (e instanceof ConcurrencyError) throw e;
      // Request exists as RECEIVED; `recoverStuck` will start it.
      this.log('could not start request', e);
      return req;
    }
    return this.executor.run(started.id);
  }

  private resolveKey(def: WorkflowDefinition, payload: Json, supplied?: string): string {
    if (supplied !== undefined) {
      if (!supplied.trim() || supplied.length > 255) throw new ValidationError('Idempotency-Key must be 1-255 characters', [{ path: 'Idempotency-Key' }]);
      return `client:${supplied}`;
    }
    const fields = def.idempotency?.keyFields;
    const material = fields && fields.length > 0 ? Object.fromEntries(fields.map((f) => [f, getPath(payload, f) ?? null])) : payload;
    return `derived:${sha256(canonicalJson(material))}`;
  }

  private validatorFor(def: WorkflowDefinition): ValidateFunction {
    const cacheKey = `${def.id}@${def.version}`;
    let v = this.validators.get(cacheKey);
    if (!v) { v = ajv.compile(def.inputSchema); this.validators.set(cacheKey, v); }
    return v;
  }

  // ---- Retry / review / recovery ---------------------------------------------

  /** Resume a PENDING_RETRY request from the stage it stopped at. */
  async retry(id: string, actor = 'operator'): Promise<RequestRecord> {
    const req = this.repo.requireRequest(id);
    if (req.status !== 'PENDING_RETRY') throw new IllegalTransitionError(`Request is ${req.status}; only PENDING_RETRY requests can be retried`);
    const resumed = this.repo.commitStep(
      req.id, req.rowVersion, { status: 'IN_PROGRESS', nextRetryAt: null },
      { reason: `Retry #${req.retryCount} resumed at stage "${req.currentStage}"`, actor },
      [
        { type: 'retry_started', stage: req.currentStage, actor, data: { retryCount: req.retryCount, resumeStage: req.currentStage } },
        { type: 'state_changed', stage: req.currentStage, actor, data: { from: 'PENDING_RETRY', to: 'IN_PROGRESS', reason: 'retry' } },
      ],
    );
    return this.executor.run(resumed.id);
  }

  /** A human resolves a MANUAL_REVIEW request. */
  review(id: string, input: { decision: unknown; reviewer: unknown; note?: unknown }): RequestRecord {
    const errors: { path: string; message: string }[] = [];
    if (input.decision !== 'approve' && input.decision !== 'reject') errors.push({ path: 'decision', message: 'must be "approve" or "reject"' });
    if (typeof input.reviewer !== 'string' || !input.reviewer.trim()) errors.push({ path: 'reviewer', message: 'required' });
    if (errors.length) throw new ValidationError('Invalid review', errors);

    const req = this.repo.requireRequest(id);
    if (req.status !== 'MANUAL_REVIEW') throw new IllegalTransitionError(`Request is ${req.status}; only MANUAL_REVIEW requests can be reviewed`);
    const decision = input.decision === 'approve' ? 'APPROVED' : 'REJECTED';
    const reviewer = input.reviewer as string;
    const note = typeof input.note === 'string' ? input.note : '';
    const now = this.clock.now().toISOString();
    const reasons = [...req.context.reasons, { stage: 'manual_review', message: `Reviewer ${reviewer}: ${decision.toLowerCase()}${note ? ` — ${note}` : ''}`, action: input.decision as string }];
    const outcome: Outcome = { decision, reasons, decidedBy: reviewer, decidedAt: now };
    return this.repo.commitStep(
      req.id, req.rowVersion, { status: decision, outcome, context: { ...req.context, reasons } },
      { reason: `Manual review: ${decision}${note ? ` — ${note}` : ''}`, actor: reviewer },
      [
        { type: 'manual_review_resolved', stage: req.currentStage, actor: reviewer, data: { decision, note, previousReasons: req.context.reasons as unknown as Json } },
        { type: 'state_changed', stage: req.currentStage, actor: reviewer, data: { from: 'MANUAL_REVIEW', to: decision, reason: note || 'manual review' } },
      ],
    );
  }

  /** Scheduler tick: retry everything whose `nextRetryAt` has passed. */
  async processDueRetries(): Promise<string[]> {
    const done: string[] = [];
    for (const r of this.repo.dueRetries()) {
      try { await this.retry(r.id, 'scheduler'); done.push(r.id); } catch (e) { this.log(`scheduled retry of ${r.id} skipped`, e); }
    }
    return done;
  }

  /**
   * Crash / persistence-failure recovery: resume requests that were left RECEIVED or
   * IN_PROGRESS. Safe to run at startup and periodically: everything it re-runs is
   * idempotent (see the executor notes).
   */
  async recoverStuck(olderThanMs = 0): Promise<string[]> {
    const done: string[] = [];
    for (const r of this.repo.stuckRequests(olderThanMs)) {
      try {
        this.repo.appendAudit([{ requestId: r.id, type: 'recovery_started', actor: 'recovery', data: { status: r.status, stage: r.currentStage } }]);
        if (r.status === 'RECEIVED') {
          const def = this.repo.getWorkflow(r.workflowId, r.workflowVersion);
          if (def) await this.start(r, def, 'recovery');
        } else {
          await this.executor.run(r.id);
        }
        done.push(r.id);
      } catch (e) { this.log(`recovery of ${r.id} skipped`, e); }
    }
    return done;
  }

  // ---- Read side --------------------------------------------------------------

  explain(id: string): Explanation {
    const req = this.repo.requireRequest(id);
    const def = this.repo.getWorkflow(req.workflowId, req.workflowVersion);
    return buildExplanation(this.repo, req, def?.name ?? req.workflowId);
  }
}
