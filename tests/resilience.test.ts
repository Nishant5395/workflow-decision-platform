import { describe, expect, it } from 'vitest';
import { loanPayload, makeSystem } from './helpers';

/** Arm persistence faults starting at the Nth commitStep call (1 = start-of-workflow, 2 = first stage, ...). */
function failFromCommit(s: ReturnType<typeof makeSystem>, nth: number, count = 1) {
  const orig = s.repo.commitStep.bind(s.repo);
  let n = 0;
  s.repo.commitStep = (...args: Parameters<typeof orig>) => {
    n++;
    if (n === nth) s.repo.faults.failNextCommits = count;
    return orig(...args);
  };
}

const credit = (s: ReturnType<typeof makeSystem>) => s.simulated.get('credit_bureau')!;
const submitLoan = (s: ReturnType<typeof makeSystem>, id = 'GOOD-1') => s.engine.submit({ workflowId: 'loan_application', payload: loanPayload({ id }) });
const attempts = (s: ReturnType<typeof makeSystem>, requestId: string) =>
  s.repo.getAudit(requestId).filter((e) => e.type === 'dependency_attempt').map((e) => (e.data as any).outcome);

describe('dependency failure: in-call retries', () => {
  it('transient failures are absorbed by in-call retry with exponential backoff', async () => {
    const s = makeSystem();
    credit(s).setFault({ mode: 'fail_next', remaining: 2 });
    const { request } = await submitLoan(s);
    expect(request.status).toBe('APPROVED');
    expect(attempts(s, request.id)).toEqual(['failure', 'failure', 'success']);
    expect(s.sleeps).toEqual([100, 200]); // backoffMs 100, factor 2
    expect(request.retryCount).toBe(0); // never had to be parked
  });

  it('non-retryable errors stop immediately (no pointless retries)', async () => {
    const s = makeSystem();
    credit(s).setFault({ mode: 'down', retryable: false });
    const { request } = await submitLoan(s);
    expect(attempts(s, request.id)).toEqual(['failure']);
    expect(s.sleeps).toEqual([]);
    expect(request.status).toBe('PENDING_RETRY');
  });

  it('a slow dependency hits the stage timeout and is treated as a retryable failure', async () => {
    const s = makeSystem();
    const def: any = JSON.parse(JSON.stringify(s.repo.getActiveWorkflow('loan_application')));
    def.stages.credit_check.timeoutMs = 20;
    def.stages.credit_check.retry = { maxAttempts: 1, backoffMs: 0 };
    s.engine.publishWorkflow(def, { changeNote: 'tight timeout' });
    credit(s).setFault({ mode: 'slow', latencyMs: 200 });
    const { request } = await submitLoan(s);
    expect(request.status).toBe('PENDING_RETRY');
    const attempt = s.repo.getAudit(request.id).find((e) => e.type === 'dependency_attempt')!;
    expect((attempt.data as any).errorCode).toBe('TIMEOUT');
  });
});

describe('dependency failure: parking and retry flow', () => {
  it('outage → PENDING_RETRY at the dependency stage, earlier work preserved', async () => {
    const s = makeSystem();
    credit(s).setFault({ mode: 'down' });
    const { request } = await submitLoan(s);
    expect(request.status).toBe('PENDING_RETRY');
    expect(request.currentStage).toBe('credit_check');
    expect(request.retryCount).toBe(1);
    expect(request.nextRetryAt).toBe('2026-11-13T10:00:30.000Z'); // clock + 30s
    expect(request.context.path).toEqual(['mandatory_checks']); // stage 1 is done and saved
    expect(attempts(s, request.id)).toEqual(['failure', 'failure', 'failure']);
    expect(s.repo.getHistory(request.id).map((h) => h.toStatus)).toEqual(['RECEIVED', 'IN_PROGRESS', 'PENDING_RETRY']);
  });

  it('retry after recovery completes the request and does NOT redo finished stages', async () => {
    const s = makeSystem();
    credit(s).setFault({ mode: 'down' });
    const { request } = await submitLoan(s);
    credit(s).setFault({ mode: 'none' });

    const done = await s.engine.retry(request.id, 'ops.alice');
    expect(done.status).toBe('APPROVED');
    expect(done.context.path).toEqual(['mandatory_checks', 'credit_check', 'risk_assessment', 'amount_routing', 'auto_approve']);
    const rulesRuns = s.repo.getAudit(request.id).filter((e) => e.type === 'rules_evaluated' && e.stage === 'mandatory_checks');
    expect(rulesRuns).toHaveLength(1); // mandatory_checks ran once, not again on retry
    const trail = s.repo.getHistory(request.id).map((h) => `${h.fromStatus}>${h.toStatus}`);
    expect(trail).toEqual(['null>RECEIVED', 'RECEIVED>IN_PROGRESS', 'IN_PROGRESS>PENDING_RETRY', 'PENDING_RETRY>IN_PROGRESS', 'IN_PROGRESS>APPROVED']);
    expect(s.repo.getAudit(request.id).find((e) => e.type === 'retry_started')!.actor).toBe('ops.alice');
  });

  it('retry while the dependency is still down parks again with a longer delay (exponential)', async () => {
    const s = makeSystem();
    credit(s).setFault({ mode: 'down' });
    const { request } = await submitLoan(s);
    const again = await s.engine.retry(request.id);
    expect(again.status).toBe('PENDING_RETRY');
    expect(again.retryCount).toBe(2);
    expect(again.nextRetryAt).toBe('2026-11-13T10:01:00.000Z'); // 30s * 2^1
  });

  it('retries are bounded: after maxParkedRetries the request escalates to MANUAL_REVIEW', async () => {
    const s = makeSystem();
    credit(s).setFault({ mode: 'down' });
    let r = (await submitLoan(s)).request; // park 1
    r = await s.engine.retry(r.id); // park 2 (maxParkedRetries = 2)
    expect(r.status).toBe('PENDING_RETRY');
    r = await s.engine.retry(r.id); // exhausted
    expect(r.status).toBe('MANUAL_REVIEW');
    expect(r.outcome!.reasons[0].message).toMatch(/still failing after 2 parked retries, escalating/);
  });

  it('only PENDING_RETRY requests can be retried; concurrent retries cannot double-run', async () => {
    const s = makeSystem();
    const ok = await submitLoan(s);
    await expect(s.engine.retry(ok.request.id)).rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' });

    credit(s).setFault({ mode: 'down' });
    const parked = (await submitLoan(s, 'GOOD-2')).request;
    credit(s).setFault({ mode: 'none' });
    const results = await Promise.allSettled([s.engine.retry(parked.id), s.engine.retry(parked.id)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(credit(s).stats.effects).toBe(2); // GOOD-1 and GOOD-2, once each
  });

  it('scheduler only retries requests whose nextRetryAt has passed', async () => {
    const s = makeSystem();
    credit(s).setFault({ mode: 'down' });
    const { request } = await submitLoan(s);
    credit(s).setFault({ mode: 'none' });
    expect(await s.engine.processDueRetries()).toEqual([]); // too early
    expect(s.repo.requireRequest(request.id).status).toBe('PENDING_RETRY');
    s.clock.advance(31_000);
    expect(await s.engine.processDueRetries()).toEqual([request.id]);
    expect(s.repo.requireRequest(request.id).status).toBe('APPROVED');
    expect(s.repo.getAudit(request.id).find((e) => e.type === 'retry_started')!.actor).toBe('scheduler');
  });

  it('retry via the REST API', async () => {
    const s = makeSystem();
    credit(s).setFault({ mode: 'down' });
    const created = await s.http.post('/api/requests').send({ workflowId: 'loan_application', payload: loanPayload() });
    expect(created.body.request.status).toBe('PENDING_RETRY');
    credit(s).setFault({ mode: 'none' });
    const retried = await s.http.post(`/api/requests/${created.body.request.id}/retry`).send({});
    expect(retried.status).toBe(200);
    expect(retried.body.request.status).toBe('APPROVED');
    const again = await s.http.post(`/api/requests/${created.body.request.id}/retry`).send({});
    expect(again.status).toBe(409);
  });

  it('configurable fallback policy: continue with a default and flag it', async () => {
    const s = makeSystem();
    const def: any = JSON.parse(JSON.stringify(s.repo.getActiveWorkflow('loan_application')));
    def.stages.credit_check.onFailure = { action: 'fallback', fallback: { score: 600, openLoans: 0 } };
    s.engine.publishWorkflow(def, { changeNote: 'use fallback score when bureau is down' });
    credit(s).setFault({ mode: 'down' });
    const { request } = await submitLoan(s);
    expect(request.status).toBe('MANUAL_REVIEW'); // fallback 600 → below auto-approve threshold
    expect(request.context.flags[0].action).toBe('fallback');
    expect(request.context.deps.credit).toEqual({ score: 600, openLoans: 0 });
  });
});

describe('dependency idempotency', () => {
  it('every call for a (request, stage) carries the same idempotency key, so retries cause one effect', async () => {
    const s = makeSystem();
    credit(s).setFault({ mode: 'fail_next', remaining: 2 });
    const { request } = await submitLoan(s);
    expect(credit(s).stats.calls).toBe(3);
    expect(credit(s).stats.effects).toBe(1);
    expect(request.status).toBe('APPROVED');
  });
});

describe('partial save / persistence failures', () => {
  it('a failure mid-commit rolls back EVERYTHING from that step (no half-written audit or state)', async () => {
    const s = makeSystem();
    const { request } = await s.engine.submit({ workflowId: 'loan_application', payload: loanPayload({ age: 19 }) }); // finish quickly later
    expect(request.status).toBe('REJECTED');

    const before = s.repo.getAudit().length;
    failFromCommit(s, 1 + 1); // commit 1 = start, commit 2 = first stage
    const r2 = (await submitLoan(s, 'GOOD-5')).request;
    // The first stage commit failed after its audit rows were inserted → rolled back; request was parked.
    expect(r2.status).toBe('PENDING_RETRY');
    expect(r2.currentStage).toBe('mandatory_checks');
    expect(r2.context.path).toEqual([]);
    const audit = s.repo.getAudit(r2.id).map((e) => e.type);
    expect(audit).not.toContain('rules_evaluated'); // the unsaved stage left no trace in the log...
    expect(audit).toContain('persistence_failure'); // ...except an explicit note that it was lost
    expect(s.repo.getAudit().length).toBeGreaterThan(before);
    expect(s.repo.verifyAuditChain().valid).toBe(true);
  });

  it('after a persistence failure the request resumes cleanly with no duplicate effects or entries', async () => {
    const s = makeSystem();
    // Fail the *second* commit (the credit_check result), so the dependency was already called.
    failFromCommit(s, 3); // commits: 1=start, 2=mandatory_checks, 3=credit_check
    const { request } = await submitLoan(s);
    expect(request.status).toBe('PENDING_RETRY');
    expect(request.currentStage).toBe('credit_check');
    expect(credit(s).stats.effects).toBe(1);

    const done = await s.engine.retry(request.id);
    expect(done.status).toBe('APPROVED');
    expect(credit(s).stats.calls).toBe(2); // called again after the lost commit...
    expect(credit(s).stats.effects).toBe(1); // ...but the same idempotency key made it ONE effect
    expect(credit(s).stats.replays).toBe(1);
    const types = s.repo.getAudit(done.id).map((e) => e.type);
    expect(types.filter((t) => t === 'dependency_completed')).toHaveLength(1);
    expect(types.filter((t) => t === 'rules_evaluated')).toHaveLength(2); // mandatory + risk, each once
  });

  it('if even the failure marker cannot be saved, the request stays IN_PROGRESS and recoverStuck resumes it', async () => {
    const s = makeSystem();
    failFromCommit(s, 2, 2); // the first stage commit fails AND the PENDING_RETRY marker fails
    const a = await s.engine.submit({ workflowId: 'loan_application', payload: loanPayload() });
    expect(a.request.status).toBe('IN_PROGRESS'); // storage was unavailable: last committed state is all we have
    expect(a.request.currentStage).toBe('mandatory_checks');

    const recovered = await s.engine.recoverStuck(0);
    expect(recovered).toContain(a.request.id);
    expect(s.repo.requireRequest(a.request.id).status).toBe('APPROVED');
    expect(s.repo.getAudit(a.request.id).some((e) => e.type === 'recovery_started')).toBe(true);
  });

  it('recovery resumes an IN_PROGRESS request orphaned by a crash from its last committed stage', async () => {
    const s = makeSystem();
    // Simulate a crash: request created and moved to IN_PROGRESS + 1 stage done, process dies.
    const def = s.repo.getActiveWorkflow('loan_application')!;
    const { request } = s.repo.createRequest({
      workflowId: def.id, workflowVersion: def.version!, idempotencyKey: 'crash', payloadHash: 'h', payload: loanPayload() as any,
      context: { deps: {}, flags: [], reasons: [], path: [], steps: 0 }, actor: 'api',
    });
    const started = s.repo.commitStep(request.id, request.rowVersion, { status: 'IN_PROGRESS', currentStage: 'credit_check', context: { deps: {}, flags: [], reasons: [], path: ['mandatory_checks'], steps: 1 } }, { reason: 'x', actor: 'api' }, []);
    expect(started.status).toBe('IN_PROGRESS');
    s.clock.advance(120_000);
    expect(await s.engine.recoverStuck(60_000)).toEqual([request.id]);
    expect(s.repo.requireRequest(request.id).status).toBe('APPROVED');
  });

  it('optimistic locking: a stale writer is refused instead of overwriting', async () => {
    const s = makeSystem();
    const { request } = await submitLoan(s);
    expect(() => s.repo.commitStep(request.id, 0 /* stale */, { status: 'REJECTED' }, null, [])).toThrow(/modified concurrently|cannot be updated/);
  });

  it('the state machine refuses illegal transitions', async () => {
    const s = makeSystem();
    const { request } = await submitLoan(s);
    expect(request.status).toBe('APPROVED');
    expect(() => s.repo.commitStep(request.id, request.rowVersion, { status: 'REJECTED' }, null, [])).toThrow(/Illegal state transition APPROVED -> REJECTED/);
    const m = (await submitLoan(s, 'FAIR-1')).request;
    expect(() => s.repo.commitStep(m.id, m.rowVersion, { status: 'IN_PROGRESS' }, null, [])).toThrow(/Illegal state transition MANUAL_REVIEW -> IN_PROGRESS/);
  });
});

describe('audit log', () => {
  it('records every step of a request, in order, with a state-history that matches', async () => {
    const s = makeSystem();
    const { request } = await submitLoan(s);
    const types = s.repo.getAudit(request.id).map((e) => e.type);
    expect(types[0]).toBe('request_received');
    expect(types).toContain('input_validated');
    expect(types.filter((t) => t === 'rules_evaluated')).toHaveLength(2);
    expect(types).toContain('dependency_completed');
    expect(types).toContain('branch_evaluated');
    expect(types).toContain('decision_made');
    expect(types.at(-1)).toBe('state_changed');
    const seqs = s.repo.getAudit(request.id).map((e) => e.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  it('is append-only at the database level (UPDATE and DELETE are refused)', async () => {
    const s = makeSystem();
    await submitLoan(s);
    expect(() => s.db.prepare("UPDATE audit_log SET type = 'x'").run()).toThrow(/append-only/);
    expect(() => s.db.prepare('DELETE FROM audit_log').run()).toThrow(/append-only/);
    expect(() => s.db.prepare("UPDATE state_history SET reason = 'x'").run()).toThrow(/append-only/);
    expect(() => s.db.prepare('DELETE FROM state_history').run()).toThrow(/append-only/);
  });

  it('hash chain detects tampering even by someone who bypasses the triggers', async () => {
    const s = makeSystem();
    const { request } = await submitLoan(s);
    expect(s.repo.verifyAuditChain()).toMatchObject({ valid: true });

    s.db.exec('DROP TRIGGER audit_log_no_update');
    s.db.prepare("UPDATE audit_log SET data = replace(data, '780', '999') WHERE type = 'dependency_completed' AND request_id = ?").run(request.id);
    const check = s.repo.verifyAuditChain();
    expect(check.valid).toBe(false);
    expect(check.reason).toMatch(/modified/);
    expect((await s.http.get('/api/health')).body.auditChain).toBe('BROKEN');
  });

  it('detects deleted entries', async () => {
    const s = makeSystem();
    await submitLoan(s);
    s.db.exec('DROP TRIGGER audit_log_no_delete');
    s.db.exec('DELETE FROM audit_log WHERE seq = 3');
    expect(s.repo.verifyAuditChain()).toMatchObject({ valid: false, reason: expect.stringMatching(/removed or reordered/) });
  });
});
