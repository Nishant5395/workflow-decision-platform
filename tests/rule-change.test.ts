import { describe, expect, it } from 'vitest';
import { loanPayload, makeSystem } from './helpers';

const clone = (s: ReturnType<typeof makeSystem>) => JSON.parse(JSON.stringify(s.repo.getActiveWorkflow('loan_application')));

describe('rule change scenarios (requirements change without code changes)', () => {
  it('raising a threshold in config changes outcomes for new requests', async () => {
    const s = makeSystem();
    expect((await s.engine.submit({ workflowId: 'loan_application', payload: loanPayload({ id: 'FAIR-1' }) })).request.status).toBe('MANUAL_REVIEW');
    const def = clone(s);
    def.stages.risk_assessment.rules.find((r: any) => r.id === 'credit_score_good').when.value = 600; // FAIR persona = 650
    const out = s.engine.publishWorkflow(def, { changeNote: 'lower auto-approve score to 600' });
    expect(out.version).toBe(2);
    const r = await s.engine.submit({ workflowId: 'loan_application', payload: loanPayload({ id: 'FAIR-2' }) });
    expect(r.request.status).toBe('APPROVED');
    expect(r.request.workflowVersion).toBe(2);
  });

  it('in-flight requests stay pinned to the version they started with', async () => {
    const s = makeSystem();
    s.simulated.get('credit_bureau')!.setFault({ mode: 'down' });
    const parked = (await s.engine.submit({ workflowId: 'loan_application', payload: loanPayload() })).request;
    const def = clone(s);
    def.stages.mandatory_checks.rules.find((r: any) => r.id === 'min_age').when.value = 99; // would reject everyone
    s.engine.publishWorkflow(def);
    s.simulated.get('credit_bureau')!.setFault({ mode: 'none' });
    const done = await s.engine.retry(parked.id);
    expect(done.workflowVersion).toBe(1);
    expect(done.status).toBe('APPROVED');
    const fresh = await s.engine.submit({ workflowId: 'loan_application', payload: loanPayload({ id: 'GOOD-2' }) });
    expect(fresh.request.status).toBe('REJECTED');
  });

  it('adding a new rule and new stage purely through config', async () => {
    const s = makeSystem();
    const def = clone(s);
    def.stages.mandatory_checks.rules.push({ id: 'max_amount', description: 'Loan must be at most 100,000', when: { field: 'input.loan.amount', op: 'lte', value: 100000 }, onFail: 'reject' });
    s.engine.publishWorkflow(def);
    const r = await s.engine.submit({ workflowId: 'loan_application', payload: loanPayload() });
    expect(r.request.status).toBe('REJECTED');
    expect(r.request.outcome!.reasons[0].ruleId).toBe('max_amount');
  });

  it('invalid config is rejected with precise errors and nothing is stored', async () => {
    const s = makeSystem();
    const def = clone(s);
    def.stages.mandatory_checks.next = 'nowhere';
    def.stages.credit_check.dependency = 'ghost';
    def.stages.risk_assessment.rules[0].when.op = 'approx';
    const res = await s.http.post('/api/workflows').send({ definition: def });
    expect(res.status).toBe(422);
    const msgs: string[] = res.body.error.details;
    expect(msgs.some((m) => /unknown stage "nowhere"/.test(m))).toBe(true);
    expect(msgs.some((m) => /unknown dependency "ghost"/.test(m))).toBe(true);
    expect(msgs.some((m) => /unknown operator "approx"/.test(m))).toBe(true);
    expect(s.repo.listVersions('loan_application')).toHaveLength(1);
  });

  it('detects cycles and warns on unreachable stages', async () => {
    const s = makeSystem();
    const def = clone(s);
    def.stages.amount_routing.default = 'mandatory_checks';
    expect(s.engine.validateWorkflow(def).errors.join()).toMatch(/cycle detected/);
    const def2 = clone(s);
    def2.stages.orphan = { type: 'decision', outcome: 'reject', reason: 'x' };
    expect(s.engine.validateWorkflow(def2).warnings.join()).toMatch(/orphan.*unreachable/);
  });

  it('rollback: activating an older version restores old behaviour', async () => {
    const s = makeSystem();
    const def = clone(s);
    def.stages.mandatory_checks.rules.find((r: any) => r.id === 'min_age').when.value = 99;
    s.engine.publishWorkflow(def);
    expect((await s.engine.submit({ workflowId: 'loan_application', payload: loanPayload() })).request.status).toBe('REJECTED');
    const res = await s.http.post('/api/workflows/loan_application/activate').send({ version: 1 });
    expect(res.status).toBe(200);
    expect((await s.engine.submit({ workflowId: 'loan_application', payload: loanPayload({ id: 'GOOD-3' }) })).request.status).toBe('APPROVED');
  });

  it('publishing is audited and a brand-new workflow can be added at runtime', async () => {
    const s = makeSystem();
    const def = {
      id: 'document_verification', name: 'Document Verification', inputSchema: { type: 'object', required: ['docType', 'pages'], properties: { docType: { type: 'string' }, pages: { type: 'integer' } } },
      initialStage: 'checks',
      stages: {
        checks: { type: 'rules', rules: [{ id: 'has_pages', description: 'Document must have pages', when: { field: 'input.pages', op: 'gt', value: 0 }, onFail: 'reject' }], next: 'ok' },
        ok: { type: 'decision', outcome: 'approve', reason: 'Document accepted' },
      },
    };
    s.engine.publishWorkflow(def, { actor: 'tester' });
    expect((await s.engine.submit({ workflowId: 'document_verification', payload: { docType: 'passport', pages: 2 } })).request.status).toBe('APPROVED');
    expect((await s.engine.submit({ workflowId: 'document_verification', payload: { docType: 'passport', pages: 0 } })).request.status).toBe('REJECTED');
    expect(s.repo.getAudit().some((e) => e.type === 'workflow_published' && e.actor === 'tester')).toBe(true);
  });
});

describe('explainability', () => {
  it('explanation shows input, rules triggered with values and data references, and output', async () => {
    const s = makeSystem();
    const { request } = await s.engine.submit({ workflowId: 'loan_application', payload: loanPayload({ id: 'POOR-1' }) });
    const exp = s.engine.explain(request.id);
    const floor = exp.failedRules.find((r) => r.ruleId === 'credit_score_floor')!;
    expect(floor.evaluation).toBe('deps.credit.score (520) gte 550 → false');
    expect(floor.dataReferences).toEqual([{ path: 'deps.credit.score', value: 520 }]);
    expect(exp.status).toBe('REJECTED');
    expect(exp.text).toContain('FAIL  credit_score_floor');
    const http = await s.http.get(`/api/requests/${request.id}/explanation?format=text`);
    expect(http.type).toBe('text/plain');
  });
});
