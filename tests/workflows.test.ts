import { describe, expect, it } from 'vitest';
import { claimPayload, loanPayload, makeSystem } from './helpers';

/** Happy paths and business outcomes for the three shipped workflow configs. */
describe('sample scenarios (all shipped samples behave as documented)', () => {
  const sys = makeSystem();
  const all = Object.entries(sys.samples as Record<string, { name: string; expect: string; payload: unknown }[]>)
    .flatMap(([workflowId, list]) => list.map((s) => ({ workflowId, ...s })));

  it.each(all.map((s) => [`${s.workflowId}: ${s.name}`, s] as const))('%s', async (_n, s) => {
    const { request } = await sys.engine.submit({ workflowId: s.workflowId, payload: s.payload });
    expect(request.status).toBe(s.expect);
  });
});

describe('loan_application', () => {
  it('happy path: approved, full path recorded, one dependency call', async () => {
    const { engine, simulated } = makeSystem();
    const { request, replayed } = await engine.submit({ workflowId: 'loan_application', payload: loanPayload() });
    expect(replayed).toBe(false);
    expect(request.status).toBe('APPROVED');
    expect(request.context.path).toEqual(['mandatory_checks', 'credit_check', 'risk_assessment', 'amount_routing', 'auto_approve']);
    expect(request.context.deps.credit).toMatchObject({ score: 780 });
    expect(request.outcome?.reasons[0].message).toMatch(/All mandatory and risk checks passed/);
    expect(simulated.get('credit_bureau')!.stats.calls).toBe(1);
  });

  it('mandatory rule failure rejects WITHOUT calling the external dependency', async () => {
    const { engine, simulated } = makeSystem();
    const { request } = await engine.submit({ workflowId: 'loan_application', payload: loanPayload({ age: 19 }) });
    expect(request.status).toBe('REJECTED');
    expect(request.context.path).toEqual(['mandatory_checks']);
    expect(simulated.get('credit_bureau')!.stats.calls).toBe(0);
  });

  it('multi-step evaluation: reject outranks manual_review when both fail', async () => {
    const { engine } = makeSystem();
    const { request } = await engine.submit({ workflowId: 'loan_application', payload: loanPayload({ id: 'POOR-1' }) });
    expect(request.status).toBe('REJECTED');
    const actions = request.outcome!.reasons.map((r) => r.action);
    expect(actions).toContain('reject');
    expect(actions).toContain('manual_review'); // secondary findings are still reported
  });

  it('threshold: score between floor and good → MANUAL_REVIEW', async () => {
    const { engine } = makeSystem();
    const { request } = await engine.submit({ workflowId: 'loan_application', payload: loanPayload({ id: 'FAIR-1' }) });
    expect(request.status).toBe('MANUAL_REVIEW');
  });

  it('computed threshold: debt-to-income uses existing debt + new EMI', async () => {
    const { engine } = makeSystem();
    // EMI = 600000/24 = 25000; (10000 + 25000) / 30000 > 0.5
    const { request } = await engine.submit({ workflowId: 'loan_application', payload: loanPayload({ income: 30000, debt: 10000, amount: 600000, tenure: 24 }) });
    expect(request.status).toBe('REJECTED');
    expect(request.outcome!.reasons.map((r) => r.ruleId)).toContain('debt_to_income');
  });

  it('conditional branching: very large loan is routed to senior review', async () => {
    const { engine } = makeSystem();
    const { request } = await engine.submit({ workflowId: 'loan_application', payload: loanPayload({ id: 'GOOD-7', income: 400000, debt: 0, amount: 2_000_000, tenure: 120 }) });
    expect(request.status).toBe('MANUAL_REVIEW');
    expect(request.context.path.at(-1)).toBe('senior_review');
  });
});

describe('claim_processing', () => {
  it('fast-track vs standard routing by amount', async () => {
    const { engine } = makeSystem();
    const fast = await engine.submit({ workflowId: 'claim_processing', payload: claimPayload({ claimId: 'A', amount: 3000 }) });
    const std = await engine.submit({ workflowId: 'claim_processing', payload: claimPayload({ claimId: 'B', amount: 20000 }) });
    const big = await engine.submit({ workflowId: 'claim_processing', payload: claimPayload({ claimId: 'C', amount: 90000 }) });
    expect(fast.request.context.path.at(-1)).toBe('fast_track_approve');
    expect(std.request.context.path.at(-1)).toBe('standard_approve');
    expect(big.request.status).toBe('MANUAL_REVIEW');
  });

  it('rules can reference dependency results (coverage limit, covered types)', async () => {
    const { engine } = makeSystem();
    const over = await engine.submit({ workflowId: 'claim_processing', payload: claimPayload({ claimId: 'D', policy: 'POL-LOW-1', amount: 30000 }) });
    expect(over.request.status).toBe('REJECTED');
    expect(over.request.outcome!.reasons.map((r) => r.ruleId)).toEqual(['within_coverage_limit']);
    const type = await engine.submit({ workflowId: 'claim_processing', payload: claimPayload({ claimId: 'E', policy: 'POL-AUTO-1', type: 'health' }) });
    expect(type.request.outcome!.reasons.map((r) => r.ruleId)).toContain('type_covered');
  });
});

describe('vendor_approval: fail-closed dependency policy', () => {
  const vendor = { vendor: { name: 'Acme', country: 'IN', registrationNumber: 'REG-100234', category: 'software', yearsInBusiness: 8, annualRevenue: 5_000_000 }, requestedContractValue: 400000, documents: { taxCertificate: true, bankDetailsVerified: true } };

  it('when sanctions screening is down, the request fails closed to MANUAL_REVIEW (never auto-approved)', async () => {
    const { engine, simulated } = makeSystem();
    simulated.get('sanctions_screening')!.setFault({ mode: 'down' });
    const { request } = await engine.submit({ workflowId: 'vendor_approval', payload: vendor });
    expect(request.status).toBe('MANUAL_REVIEW');
    expect(request.outcome!.reasons[0].message).toMatch(/compliance requires a human decision/);
  });

  it('manual review can then be resolved by a human with full attribution', async () => {
    const { engine, simulated } = makeSystem();
    simulated.get('sanctions_screening')!.setFault({ mode: 'down' });
    const { request } = await engine.submit({ workflowId: 'vendor_approval', payload: vendor });
    const done = engine.review(request.id, { decision: 'approve', reviewer: 'sam.compliance', note: 'Verified manually' });
    expect(done.status).toBe('APPROVED');
    expect(done.outcome).toMatchObject({ decision: 'APPROVED', decidedBy: 'sam.compliance' });
    expect(engine.repo.getHistory(request.id).at(-1)).toMatchObject({ fromStatus: 'MANUAL_REVIEW', toStatus: 'APPROVED', actor: 'sam.compliance' });
  });
});

describe('manual review', () => {
  it('rejects invalid review input and double resolution', async () => {
    const { engine } = makeSystem();
    const { request } = await engine.submit({ workflowId: 'loan_application', payload: loanPayload({ id: 'FAIR-2' }) });
    expect(() => engine.review(request.id, { decision: 'maybe', reviewer: 'x' })).toThrow(/Invalid review/);
    expect(() => engine.review(request.id, { decision: 'approve', reviewer: '' })).toThrow(/Invalid review/);
    engine.review(request.id, { decision: 'reject', reviewer: 'r1' });
    expect(() => engine.review(request.id, { decision: 'approve', reviewer: 'r2' })).toThrow(/only MANUAL_REVIEW/);
    expect(engine.repo.requireRequest(request.id).status).toBe('REJECTED'); // first decision stands
  });

  it('only MANUAL_REVIEW requests can be reviewed', async () => {
    const { engine } = makeSystem();
    const { request } = await engine.submit({ workflowId: 'loan_application', payload: loanPayload() });
    expect(() => engine.review(request.id, { decision: 'reject', reviewer: 'r' })).toThrow(/only MANUAL_REVIEW/);
  });
});
