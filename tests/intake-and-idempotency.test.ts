import { describe, expect, it } from 'vitest';
import { claimPayload, loanPayload, makeSystem } from './helpers';

describe('input validation (intake)', () => {
  it('rejects a missing required field with a precise 422 and creates no request', async () => {
    const { http, engine } = makeSystem();
    const bad: any = loanPayload();
    delete bad.applicant.age;
    const res = await http.post('/api/requests').send({ workflowId: 'loan_application', payload: bad });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.details.some((d: any) => d.keyword === 'required' && d.params.missingProperty === 'age')).toBe(true);
    expect(engine.repo.listRequests()).toHaveLength(0);
  });

  it.each([
    ['wrong type', (p: any) => { p.applicant.age = 'thirty'; }, '/applicant/age'],
    ['out of range', (p: any) => { p.loan.tenureMonths = 9999; }, '/loan/tenureMonths'],
    ['invalid enum value', (p: any) => { p.applicant.employmentStatus = 'astronaut'; }, '/applicant/employmentStatus'],
    ['negative amount', (p: any) => { p.loan.amount = -5; }, '/loan/amount'],
    ['unexpected extra field', (p: any) => { p.applicant.shoeSize = 9; }, '/applicant'],
  ])('rejects %s', async (_name, mutate, path) => {
    const { http } = makeSystem();
    const p: any = loanPayload();
    mutate(p);
    const res = await http.post('/api/requests').send({ workflowId: 'loan_application', payload: p });
    expect(res.status).toBe(422);
    expect(res.body.error.details.map((d: any) => d.path)).toContain(path);
  });

  it('validates formats (dates) from the config schema', async () => {
    const { http } = makeSystem();
    const res = await http.post('/api/requests').send({ workflowId: 'claim_processing', payload: claimPayload({ incident: 'yesterday' }) });
    expect(res.status).toBe(422);
  });

  it('rejects non-object payloads, missing workflowId, unknown workflows and malformed JSON', async () => {
    const { http } = makeSystem();
    expect((await http.post('/api/requests').send({ workflowId: 'loan_application', payload: 'nope' })).status).toBe(422);
    expect((await http.post('/api/requests').send({ payload: {} })).status).toBe(422);
    const unknown = await http.post('/api/requests').send({ workflowId: 'nope', payload: {} });
    expect(unknown.status).toBe(404);
    const bad = await http.post('/api/requests').set('Content-Type', 'application/json').send('{not json');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('BAD_JSON');
  });

  it('records every rejected intake in the audit log (for forensic review)', async () => {
    const { http, repo } = makeSystem();
    await http.post('/api/requests').send({ workflowId: 'loan_application', payload: {} });
    const rejected = repo.getAudit().filter((e) => e.type === 'intake_rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0].requestId).toBeNull();
    expect((rejected[0].data as any).errors.length).toBeGreaterThan(0);
  });
});

describe('idempotency & duplicate requests', () => {
  it('same Idempotency-Key + same payload → one request, original returned, no re-execution', async () => {
    const { http, repo, simulated } = makeSystem();
    const send = () => http.post('/api/requests').set('Idempotency-Key', 'order-1').send({ workflowId: 'loan_application', payload: loanPayload() });
    const a = await send();
    const b = await send();
    const c = await send();
    expect(a.status).toBe(201);
    expect(a.body.replayed).toBe(false);
    expect(b.status).toBe(200);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.body.request.id).toBe(a.body.request.id);
    expect(c.body.request.id).toBe(a.body.request.id);
    expect(repo.listRequests()).toHaveLength(1);
    expect(simulated.get('credit_bureau')!.stats.calls).toBe(1);
    expect(repo.getAudit(a.body.request.id).filter((e) => e.type === 'duplicate_request_replayed')).toHaveLength(2);
  });

  it('same key + DIFFERENT payload → 409 conflict, original untouched', async () => {
    const { http, repo } = makeSystem();
    const a = await http.post('/api/requests').set('Idempotency-Key', 'k1').send({ workflowId: 'loan_application', payload: loanPayload() });
    const b = await http.post('/api/requests').set('Idempotency-Key', 'k1').send({ workflowId: 'loan_application', payload: loanPayload({ amount: 999 }) });
    expect(b.status).toBe(409);
    expect(b.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(repo.listRequests()).toHaveLength(1);
    expect(repo.requireRequest(a.body.request.id).status).toBe('APPROVED');
    expect(repo.getAudit(a.body.request.id).some((e) => e.type === 'idempotency_conflict')).toBe(true);
  });

  it('without a header, an identical payload is still deduplicated (derived key); key order does not matter', async () => {
    const { engine, repo } = makeSystem();
    const p1 = loanPayload();
    const p2 = JSON.parse(JSON.stringify({ loan: p1.loan, applicant: p1.applicant })); // keys in different order
    const a = await engine.submit({ workflowId: 'loan_application', payload: p1 });
    const b = await engine.submit({ workflowId: 'loan_application', payload: p2 });
    expect(b.replayed).toBe(true);
    expect(b.request.id).toBe(a.request.id);
    expect(repo.listRequests()).toHaveLength(1);
  });

  it('configured business key: same claimId with a changed amount is a conflict, not a second claim', async () => {
    const { engine, repo } = makeSystem();
    await engine.submit({ workflowId: 'claim_processing', payload: claimPayload({ claimId: 'CLM-9', amount: 3000 }) });
    await expect(engine.submit({ workflowId: 'claim_processing', payload: claimPayload({ claimId: 'CLM-9', amount: 4000 }) })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(repo.listRequests()).toHaveLength(1);
  });

  it('different workflows may use the same key independently', async () => {
    const { engine, repo } = makeSystem();
    await engine.submit({ workflowId: 'loan_application', payload: loanPayload(), idempotencyKey: 'shared' });
    await engine.submit({ workflowId: 'claim_processing', payload: claimPayload(), idempotencyKey: 'shared' });
    expect(repo.listRequests()).toHaveLength(2);
  });

  it('concurrent identical submissions create exactly one request and one dependency effect', async () => {
    const { engine, repo, simulated } = makeSystem();
    const results = await Promise.all(Array.from({ length: 10 }, () => engine.submit({ workflowId: 'loan_application', payload: loanPayload(), idempotencyKey: 'burst' })));
    expect(new Set(results.map((r) => r.request.id)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(repo.listRequests()).toHaveLength(1);
    expect(simulated.get('credit_bureau')!.stats.effects).toBe(1);
  });

  it('the database itself refuses duplicate (workflow, key) rows even if app logic were bypassed', async () => {
    const { engine, db } = makeSystem();
    const { request } = await engine.submit({ workflowId: 'loan_application', payload: loanPayload(), idempotencyKey: 'dup' });
    const row = db.prepare('SELECT * FROM requests WHERE id = ?').get(request.id) as any;
    expect(() => db.prepare('INSERT INTO requests (id, workflow_id, workflow_version, idempotency_key, payload_hash, payload, status, context, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run('other-id', row.workflow_id, 1, row.idempotency_key, 'h', '{}', 'RECEIVED', '{}', 'now', 'now')).toThrow(/UNIQUE/);
  });

  it('rejects absurd idempotency keys', async () => {
    const { http } = makeSystem();
    const res = await http.post('/api/requests').set('Idempotency-Key', 'x'.repeat(300)).send({ workflowId: 'loan_application', payload: loanPayload() });
    expect(res.status).toBe(422);
  });
});
