import type { AuditEvent, Json, Outcome, Reason, RequestRecord, StateChange } from '../domain/types';
import type { DataRef } from '../rules/expression';
import type { Repository } from '../store/repository';

export interface RuleExplanation {
  stage: string;
  ruleId: string;
  description: string;
  passed: boolean;
  onFail: string;
  /** The evaluated expression with the actual values, e.g. `input.applicant.age (19) gte 21 → false`. */
  evaluation: string;
  /** Exactly which input/dependency values the rule read. */
  dataReferences: DataRef[];
}

export interface Explanation {
  requestId: string;
  workflow: { id: string; version: number };
  status: string;
  summary: string;
  input: Json;
  outcome: Outcome | null;
  path: string[];
  rules: RuleExplanation[];
  failedRules: RuleExplanation[];
  branches: { stage: string; chosen: string; goto: string; evaluated: { branchId: string; passed: boolean; evaluation: string }[] }[];
  dependencyCalls: { stage: string; dependency: string; attempts: { attempt: number; outcome: string; errorCode?: string; message?: string }[]; result?: Json; resolution: string }[];
  flags: Reason[];
  reasons: Reason[];
  stateHistory: StateChange[];
  auditEvents: number;
  text: string;
}

type Data = Record<string, any>; // audit payloads are free-form JSON written by the executor

function dedupeRefs(refs: DataRef[]): DataRef[] {
  const seen = new Map<string, DataRef>();
  for (const r of refs) seen.set(`${r.path}=${JSON.stringify(r.value)}`, r);
  return [...seen.values()];
}

/** Build a decision explanation purely from persisted facts (request row + audit log + history). */
export function buildExplanation(repo: Repository, req: RequestRecord, workflowName: string): Explanation {
  const events: AuditEvent[] = repo.getAudit(req.id);
  const history = repo.getHistory(req.id);

  const rules: RuleExplanation[] = [];
  const branches: Explanation['branches'] = [];
  const dependencyCalls: Explanation['dependencyCalls'] = [];

  for (const e of events) {
    const d = e.data as Data;
    if (e.type === 'rules_evaluated') {
      for (const r of d.results as Data[]) {
        rules.push({
          stage: e.stage!, ruleId: r.ruleId, description: r.description, passed: r.passed, onFail: r.onFail,
          evaluation: r.trace.summary, dataReferences: dedupeRefs(r.trace.refs ?? []),
        });
      }
    } else if (e.type === 'branch_evaluated') {
      branches.push({
        stage: e.stage!, chosen: d.chosen, goto: d.goto,
        evaluated: (d.evaluated as Data[]).map((b) => ({ branchId: b.branchId, passed: b.passed, evaluation: b.trace.summary })),
      });
    } else if (e.type === 'dependency_attempt') {
      let call = dependencyCalls.find((c) => c.stage === e.stage && c.resolution === 'in_progress');
      if (!call) {
        call = { stage: e.stage!, dependency: d.dependency, attempts: [], resolution: 'in_progress' };
        dependencyCalls.push(call);
      }
      call.attempts.push({ attempt: d.attempt, outcome: d.outcome, ...(d.errorCode ? { errorCode: d.errorCode, message: d.message } : {}) });
    } else if (e.type === 'dependency_completed') {
      const call = dependencyCalls.filter((c) => c.stage === e.stage).pop();
      if (call) { call.result = d.result; call.resolution = 'succeeded'; }
    } else if (e.type === 'dependency_failed') {
      const call = dependencyCalls.filter((c) => c.stage === e.stage).pop();
      if (call) call.resolution = d.outcome;
    }
  }

  const failedRules = rules.filter((r) => !r.passed);
  const outcome = req.outcome;
  const reasons = outcome?.reasons ?? req.context.reasons;
  const summary = summarise(req, reasons);

  const exp: Explanation = {
    requestId: req.id,
    workflow: { id: req.workflowId, version: req.workflowVersion },
    status: req.status, summary, input: req.payload, outcome, path: req.context.path,
    rules, failedRules, branches, dependencyCalls, flags: req.context.flags, reasons, stateHistory: history, auditEvents: events.length,
    text: '',
  };
  exp.text = renderText(exp, workflowName);
  return exp;
}

function summarise(req: RequestRecord, reasons: Reason[]): string {
  const why = reasons.map((r) => r.message).join('; ');
  switch (req.status) {
    case 'APPROVED': return `Approved. ${why}`.trim();
    case 'REJECTED': return `Rejected: ${why}`;
    case 'MANUAL_REVIEW': return `Sent to manual review: ${why}`;
    case 'PENDING_RETRY': return `Waiting for retry at stage "${req.currentStage}" (retry ${req.retryCount}).`;
    case 'FAILED': return 'Processing failed due to an engine or configuration error (see audit log).';
    default: return `In progress at stage "${req.currentStage}".`;
  }
}

function renderText(x: Explanation, workflowName: string): string {
  const L: string[] = [];
  L.push(`Request ${x.requestId}`);
  L.push(`Workflow: ${workflowName} (${x.workflow.id} v${x.workflow.version})`);
  L.push(`Status:   ${x.status}${x.outcome ? ` — decided by ${x.outcome.decidedBy} at ${x.outcome.decidedAt}` : ''}`);
  L.push(`Summary:  ${x.summary}`);
  L.push('');
  L.push(`Input: ${JSON.stringify(x.input)}`);
  L.push(`Path:  ${x.path.join(' → ') || '(not started)'}`);
  const stages = [...new Set([...x.rules.map((r) => r.stage), ...x.branches.map((b) => b.stage), ...x.dependencyCalls.map((c) => c.stage)])];
  for (const stage of x.path.length ? x.path : stages) {
    const r = x.rules.filter((q) => q.stage === stage);
    const b = x.branches.filter((q) => q.stage === stage);
    const c = x.dependencyCalls.filter((q) => q.stage === stage);
    if (!r.length && !b.length && !c.length) continue;
    L.push('', `[${stage}]`);
    for (const rule of r) L.push(`  ${rule.passed ? 'PASS' : 'FAIL'}  ${rule.ruleId} — ${rule.description}`, `        ${rule.evaluation}${rule.passed ? '' : `   (on fail: ${rule.onFail})`}`);
    for (const br of b) L.push(`  BRANCH chose "${br.chosen}" → ${br.goto}`, ...br.evaluated.map((e) => `        ${e.branchId}: ${e.evaluation}`));
    for (const call of c) {
      L.push(`  CALL ${call.dependency}: ${call.attempts.map((a) => `#${a.attempt} ${a.outcome}${a.errorCode ? ` (${a.errorCode})` : ''}`).join(', ')} → ${call.resolution}`);
      if (call.result !== undefined) L.push(`        result: ${JSON.stringify(call.result)}`);
    }
  }
  if (x.flags.length) L.push('', 'Flags:', ...x.flags.map((f) => `  - [${f.stage}] ${f.message}`));
  if (x.reasons.length) L.push('', 'Reasons:', ...x.reasons.map((r) => `  - [${r.stage}${r.ruleId ? `/${r.ruleId}` : ''}] ${r.message}  (${r.action})`));
  L.push('', 'State history:', ...x.stateHistory.map((h) => `  ${h.at}  ${h.fromStatus ?? '∅'} → ${h.toStatus}  (${h.actor}) ${h.reason}`));
  L.push('', `Audit events recorded: ${x.auditEvents}`);
  return L.join('\n');
}
