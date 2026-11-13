import { ConcurrencyError, ConfigError, DependencyError } from '../domain/errors';
import type {
  AuditEventInput, DependencyStage, Json, Outcome, Reason, RequestContext, RequestRecord, RuleDef, Stage,
} from '../domain/types';
import { Clock, Sleep, toJson } from '../domain/util';
import type { DependencyRegistry } from '../dependencies/types';
import { DataRef, evalOperand, evaluateCondition } from '../rules/expression';
import type { Repository, StepPatch } from '../store/repository';

type FinalDecision = 'APPROVED' | 'REJECTED' | 'MANUAL_REVIEW';

type Next =
  | { kind: 'goto'; stage: string }
  | { kind: 'finish'; decision: FinalDecision }
  | { kind: 'park'; reason: string; nextRetryAt: string }
  | { kind: 'fail'; reason: string };

/** What a single stage produced. Nothing here is persisted until `applyStep` commits it atomically. */
interface StepResult {
  events: AuditEventInput[];
  deps?: Record<string, Json>;
  flags?: Reason[];
  reasons?: Reason[];
  next: Next;
}

export interface ExecutorOptions {
  repo: Repository;
  dependencies: DependencyRegistry;
  clock: Clock;
  sleep: Sleep;
  log?: (msg: string, extra?: unknown) => void;
}

const actionName = (a: RuleDef['onFail']): string => (typeof a === 'object' ? `goto:${a.goto}` : a);

/**
 * Runs a request forward, one stage at a time, until it reaches a terminal
 * state or is parked (PENDING_RETRY / MANUAL_REVIEW).
 *
 * Design rules:
 *  1. A stage is *computed* first (pure for rules/branch, I/O for dependency) and
 *     *committed* second, in a single transaction. A crash between the two
 *     replays the stage; dependency calls are safe to replay because they carry a
 *     stable idempotency key.
 *  2. The request always resumes from `currentStage` with the dependency results
 *     already saved in its context, so a retry never redoes finished work.
 */
export class WorkflowExecutor {
  private readonly repo: Repository;
  private readonly dependencies: DependencyRegistry;
  private readonly clock: Clock;
  private readonly sleep: Sleep;
  private readonly log: (msg: string, extra?: unknown) => void;

  constructor(o: ExecutorOptions) {
    this.repo = o.repo;
    this.dependencies = o.dependencies;
    this.clock = o.clock;
    this.sleep = o.sleep;
    this.log = o.log ?? (() => undefined);
  }

  async run(requestId: string): Promise<RequestRecord> {
    let req = this.repo.requireRequest(requestId);
    if (req.status !== 'IN_PROGRESS') return req;

    const def = this.repo.getWorkflow(req.workflowId, req.workflowVersion);
    if (!def) return this.failRequest(req, req.currentStage, `Workflow ${req.workflowId} v${req.workflowVersion} not found`);
    const maxSteps = def.limits?.maxSteps ?? 50;

    while (req.status === 'IN_PROGRESS') {
      const stageId = req.currentStage;
      const stage = stageId ? def.stages[stageId] : undefined;
      if (!stageId || !stage) return this.failRequest(req, stageId, `Stage "${String(stageId)}" is not defined in workflow ${def.id} v${def.version}`);
      if (req.context.steps >= maxSteps) return this.failRequest(req, stageId, `Step limit (${maxSteps}) exceeded`);

      let step: StepResult;
      try {
        step = await this.executeStage(req, stageId, stage);
      } catch (err) {
        const msg = err instanceof ConfigError ? err.message : `Unexpected engine error: ${(err as Error).message}`;
        this.log('stage execution error', err);
        return this.failRequest(req, stageId, msg);
      }

      try {
        req = this.applyStep(req, stageId, step);
      } catch (err) {
        if (err instanceof ConcurrencyError) throw err; // someone else owns this request now
        return this.onPersistenceFailure(req, stageId, step, err as Error);
      }
    }
    return req;
  }

  // ---- Stage execution ------------------------------------------------------

  private async executeStage(req: RequestRecord, stageId: string, stage: Stage): Promise<StepResult> {
    const evalCtx = { input: req.payload, deps: req.context.deps };
    switch (stage.type) {
      case 'rules': return this.runRules(stageId, stage.rules, stage.next, evalCtx);
      case 'branch': return this.runBranch(stageId, stage, evalCtx);
      case 'dependency': return this.runDependency(req, stageId, stage, evalCtx);
      case 'decision': {
        const decision: FinalDecision = stage.outcome === 'approve' ? 'APPROVED' : stage.outcome === 'reject' ? 'REJECTED' : 'MANUAL_REVIEW';
        const reason: Reason = { stage: stageId, message: stage.reason, action: stage.outcome };
        return {
          events: [{ type: 'decision_made', stage: stageId, data: { decision, reason: stage.reason } }],
          reasons: [reason],
          next: { kind: 'finish', decision },
        };
      }
    }
  }

  private runRules(stageId: string, rules: RuleDef[], nextStage: string, evalCtx: unknown): StepResult {
    // Every rule is evaluated (no short-circuit) so the trace is complete.
    const results = rules.map((rule) => ({ rule, trace: evaluateCondition(rule.when, evalCtx) }));
    const failed = results.filter((r) => !r.trace.passed);
    const toReason = (r: (typeof results)[number]): Reason => ({ stage: stageId, ruleId: r.rule.id, message: r.rule.reason ?? r.rule.description, action: actionName(r.rule.onFail) });

    const rejects = failed.filter((r) => r.rule.onFail === 'reject');
    const reviews = failed.filter((r) => r.rule.onFail === 'manual_review');
    const gotos = failed.filter((r) => typeof r.rule.onFail === 'object');
    const flags = failed.filter((r) => r.rule.onFail === 'flag').map(toReason);

    let next: Next;
    let reasons: Reason[] = [];
    let routing: string;
    if (rejects.length > 0) {
      next = { kind: 'finish', decision: 'REJECTED' };
      reasons = [...rejects, ...reviews].map(toReason);
      routing = 'REJECT (a failed rule has onFail=reject; reject takes precedence over manual_review)';
    } else if (reviews.length > 0) {
      next = { kind: 'finish', decision: 'MANUAL_REVIEW' };
      reasons = reviews.map(toReason);
      routing = 'MANUAL_REVIEW (a failed rule has onFail=manual_review)';
    } else if (gotos.length > 0) {
      const target = (gotos[0].rule.onFail as { goto: string }).goto;
      next = { kind: 'goto', stage: target };
      reasons = gotos.map(toReason);
      routing = `GOTO ${target} (rule ${gotos[0].rule.id} failed)`;
    } else {
      next = { kind: 'goto', stage: nextStage };
      routing = flags.length > 0 ? `CONTINUE to ${nextStage} with ${flags.length} flag(s)` : `CONTINUE to ${nextStage} (all rules passed)`;
    }

    return {
      events: [{
        type: 'rules_evaluated', stage: stageId,
        data: {
          routing,
          results: results.map((r) => ({
            ruleId: r.rule.id, description: r.rule.description, passed: r.trace.passed,
            onFail: actionName(r.rule.onFail), trace: toJson(r.trace),
          })),
        },
      }],
      reasons,
      flags,
      next,
    };
  }

  private runBranch(stageId: string, stage: Extract<Stage, { type: 'branch' }>, evalCtx: unknown): StepResult {
    const evaluated: { branchId: string; passed: boolean; trace: Json }[] = [];
    let target = stage.default;
    let chosen = 'default';
    for (const b of stage.branches) {
      const trace = evaluateCondition(b.when, evalCtx);
      evaluated.push({ branchId: b.id, passed: trace.passed, trace: toJson(trace) });
      if (trace.passed) { target = b.goto; chosen = b.id; break; }
    }
    return {
      events: [{ type: 'branch_evaluated', stage: stageId, data: { chosen, goto: target, evaluated } }],
      next: { kind: 'goto', stage: target },
    };
  }

  private async runDependency(req: RequestRecord, stageId: string, stage: DependencyStage, evalCtx: unknown): Promise<StepResult> {
    const dep = this.dependencies.get(stage.dependency);
    if (!dep) throw new ConfigError(`Dependency "${stage.dependency}" is not registered`);

    const input: Record<string, Json> = {};
    const refs: DataRef[] = [];
    for (const [k, operand] of Object.entries(stage.input)) {
      const ev = evalOperand(operand, evalCtx);
      input[k] = toJson(ev.value);
      refs.push(...ev.refs);
    }
    // Stable per (request, stage): the same call made twice is one business effect.
    const idempotencyKey = `${req.id}:${stageId}`;
    const policy = stage.retry ?? { maxAttempts: 1, backoffMs: 0 };
    const events: AuditEventInput[] = [];
    let lastError: DependencyError | null = null;

    for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
      const started = Date.now();
      try {
        const result = toJson(await this.withTimeout(dep.call({ idempotencyKey, input }), stage.timeoutMs, dep.name));
        events.push({ type: 'dependency_attempt', stage: stageId, data: { dependency: dep.name, attempt, outcome: 'success', durationMs: Date.now() - started } });
        events.push({ type: 'dependency_completed', stage: stageId, data: { dependency: dep.name, resultKey: stage.resultKey, input, dataRefs: toJson(refs), result } });
        return { events, deps: { [stage.resultKey]: result }, next: { kind: 'goto', stage: stage.next } };
      } catch (e) {
        const err = e instanceof DependencyError ? e : new DependencyError(dep.name, 'UNEXPECTED', (e as Error).message, true);
        lastError = err;
        events.push({
          type: 'dependency_attempt', stage: stageId,
          data: { dependency: dep.name, attempt, outcome: 'failure', errorCode: err.errorCode, message: err.message, retryable: err.retryable, durationMs: Date.now() - started },
        });
        if (!err.retryable) break;
        if (attempt < policy.maxAttempts) await this.sleep(policy.backoffMs * (policy.factor ?? 2) ** (attempt - 1));
      }
    }
    return this.dependencyFailed(req, stageId, stage, events, lastError!);
  }

  private dependencyFailed(req: RequestRecord, stageId: string, stage: DependencyStage, events: AuditEventInput[], err: DependencyError): StepResult {
    const f = stage.onFailure;
    const what = `Dependency "${stage.dependency}" failed (${err.errorCode}: ${err.message})`;
    const failEvent = (outcome: string): AuditEventInput => ({ type: 'dependency_failed', stage: stageId, data: { dependency: stage.dependency, policy: f.action, outcome, errorCode: err.errorCode, message: err.message } });

    switch (f.action) {
      case 'fallback': {
        const flag: Reason = { stage: stageId, message: `${what}; continued with configured fallback`, action: 'fallback' };
        return { events: [...events, failEvent('fallback_used')], deps: { [stage.resultKey]: f.fallback ?? null }, flags: [flag], next: { kind: 'goto', stage: stage.next } };
      }
      case 'reject':
      case 'manual_review': {
        const decision: FinalDecision = f.action === 'reject' ? 'REJECTED' : 'MANUAL_REVIEW';
        return {
          events: [...events, failEvent(`fail_closed_${f.action}`)],
          reasons: [{ stage: stageId, message: f.reason ?? `${what}; failing closed to ${f.action}`, action: f.action }],
          next: { kind: 'finish', decision },
        };
      }
      case 'park': {
        const max = f.maxParkedRetries ?? 3;
        if (req.retryCount >= max) {
          const decision: FinalDecision = (f.afterExhausted ?? 'manual_review') === 'reject' ? 'REJECTED' : 'MANUAL_REVIEW';
          return {
            events: [...events, failEvent(`retries_exhausted_${decision.toLowerCase()}`)],
            reasons: [{ stage: stageId, message: `${what}; still failing after ${req.retryCount} parked retries, escalating`, action: f.afterExhausted ?? 'manual_review' }],
            next: { kind: 'finish', decision },
          };
        }
        const delay = (f.retryDelayMs ?? 30_000) * 2 ** req.retryCount;
        const nextRetryAt = new Date(this.clock.now().getTime() + delay).toISOString();
        return {
          events: [...events, failEvent('parked_for_retry'), { type: 'retry_scheduled', stage: stageId, data: { retryCount: req.retryCount + 1, maxParkedRetries: max, nextRetryAt } }],
          next: { kind: 'park', reason: `${what}; parked for retry ${req.retryCount + 1}/${max}`, nextRetryAt },
        };
      }
    }
  }

  private withTimeout<T>(p: Promise<T>, ms: number | undefined, name: string): Promise<T> {
    if (!ms) return p;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new DependencyError(name, 'TIMEOUT', `${name} did not respond within ${ms}ms`, true)), ms);
      p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
    });
  }

  // ---- Committing -----------------------------------------------------------

  private applyStep(req: RequestRecord, stageId: string, step: StepResult): RequestRecord {
    const now = this.clock.now().toISOString();
    const next = step.next;
    const advanced: RequestContext = {
      deps: { ...req.context.deps, ...(step.deps ?? {}) },
      flags: [...req.context.flags, ...(step.flags ?? [])],
      reasons: [...req.context.reasons, ...(step.reasons ?? [])],
      path: [...req.context.path, stageId],
      steps: req.context.steps + 1,
    };

    switch (next.kind) {
      case 'goto': {
        const events: AuditEventInput[] = [...step.events, { type: 'stage_completed', stage: stageId, data: { next: next.stage } }];
        return this.repo.commitStep(req.id, req.rowVersion, { currentStage: next.stage, context: advanced }, null, events);
      }
      case 'finish': {
        const outcome: Outcome = { decision: next.decision, reasons: advanced.reasons, decidedBy: 'system', decidedAt: now };
        const summary = `${next.decision}: ${advanced.reasons.map((r) => r.message).join('; ') || 'no reasons recorded'}`;
        const events: AuditEventInput[] = [
          ...step.events,
          { type: 'stage_completed', stage: stageId, data: { next: null } },
          { type: 'state_changed', stage: stageId, data: { from: 'IN_PROGRESS', to: next.decision, reason: summary } },
        ];
        const patch: StepPatch = { status: next.decision, currentStage: stageId, context: advanced, outcome, nextRetryAt: null };
        return this.repo.commitStep(req.id, req.rowVersion, patch, { reason: summary, actor: 'system' }, events);
      }
      case 'park': {
        const events: AuditEventInput[] = [...step.events, { type: 'state_changed', stage: stageId, data: { from: 'IN_PROGRESS', to: 'PENDING_RETRY', reason: next.reason } }];
        const patch: StepPatch = { status: 'PENDING_RETRY', currentStage: stageId, retryCount: req.retryCount + 1, nextRetryAt: next.nextRetryAt };
        return this.repo.commitStep(req.id, req.rowVersion, patch, { reason: next.reason, actor: 'system' }, events);
      }
      case 'fail':
        return this.failRequest(req, stageId, next.reason);
    }
  }

  /** Persistence failed after the stage was computed. Nothing from the stage was saved. */
  private onPersistenceFailure(req: RequestRecord, stageId: string, step: StepResult, err: Error): RequestRecord {
    this.log('persistence failure', err);
    const reason = `Persistence failure while saving stage "${stageId}": ${err.message}. Nothing from this stage was saved; will resume from the last committed state.`;
    try {
      return this.repo.commitStep(
        req.id, req.rowVersion,
        { status: 'PENDING_RETRY', nextRetryAt: this.clock.now().toISOString() },
        { reason, actor: 'system' },
        [
          // The events we could not save are preserved here so the evidence is not lost.
          { type: 'persistence_failure', stage: stageId, data: { error: err.message, unsavedEventCount: step.events.length, unsavedEventTypes: step.events.map((e) => e.type) } },
          { type: 'state_changed', stage: stageId, data: { from: 'IN_PROGRESS', to: 'PENDING_RETRY', reason } },
        ],
      );
    } catch (secondary) {
      // Storage is really unavailable. Leave the request IN_PROGRESS at its last committed
      // stage; `recoverStuck` will pick it up once storage is back.
      this.log('could not record persistence failure either', secondary);
      return req;
    }
  }

  private failRequest(req: RequestRecord, stage: string | null, reason: string): RequestRecord {
    try {
      return this.repo.commitStep(
        req.id, req.rowVersion,
        { status: 'FAILED', currentStage: stage ?? req.currentStage },
        { reason, actor: 'system' },
        [
          { type: 'engine_error', stage, data: { reason } },
          { type: 'state_changed', stage, data: { from: req.status, to: 'FAILED', reason } },
        ],
      );
    } catch (e) {
      this.log('could not mark request FAILED', e);
      return req;
    }
  }
}
