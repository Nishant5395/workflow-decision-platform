import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { validateCondition, validateOperand } from '../rules/expression';
import type { Stage, WorkflowDefinition } from '../domain/types';

export const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

export interface DefinitionValidation {
  errors: string[];
  warnings: string[];
}

/** Stage ids this stage can hand control to. */
export function successors(stage: Stage): string[] {
  switch (stage.type) {
    case 'rules': {
      const gotos = stage.rules.flatMap((r) => (typeof r.onFail === 'object' ? [r.onFail.goto] : []));
      return [stage.next, ...gotos];
    }
    case 'branch': return [...stage.branches.map((b) => b.goto), stage.default];
    case 'dependency': return [stage.next];
    case 'decision': return [];
  }
}

/**
 * Static validation of a workflow definition. This is the safety net that lets
 * non-engineers change configuration: a bad edit is rejected at publish time
 * with precise messages instead of failing a live request.
 */
export function validateDefinition(def: unknown, knownDependencies: string[]): DefinitionValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!def || typeof def !== 'object' || Array.isArray(def)) return { errors: ['definition must be a JSON object'], warnings };
  const d = def as WorkflowDefinition;

  if (typeof d.id !== 'string' || !/^[a-z][a-z0-9_]*$/.test(d.id)) errors.push('id: must match /^[a-z][a-z0-9_]*$/');
  if (typeof d.name !== 'string' || !d.name.trim()) errors.push('name: required');

  if (!d.inputSchema || typeof d.inputSchema !== 'object') errors.push('inputSchema: required JSON Schema object');
  else {
    try { ajv.compile(d.inputSchema); } catch (e) { errors.push(`inputSchema: not a valid JSON Schema (${(e as Error).message})`); }
  }

  if (d.idempotency?.keyFields !== undefined && (!Array.isArray(d.idempotency.keyFields) || d.idempotency.keyFields.some((k) => typeof k !== 'string'))) {
    errors.push('idempotency.keyFields: must be a list of path strings');
  }

  if (!d.stages || typeof d.stages !== 'object' || Object.keys(d.stages).length === 0) {
    errors.push('stages: at least one stage is required');
    return { errors, warnings };
  }
  if (typeof d.initialStage !== 'string' || !d.stages[d.initialStage]) errors.push(`initialStage: "${String(d.initialStage)}" is not a defined stage`);

  const exists = (id: unknown): boolean => typeof id === 'string' && Object.prototype.hasOwnProperty.call(d.stages, id);

  for (const [id, stage] of Object.entries(d.stages)) {
    const at = `stages.${id}`;
    switch (stage?.type) {
      case 'rules': {
        if (!Array.isArray(stage.rules) || stage.rules.length === 0) errors.push(`${at}.rules: at least one rule required`);
        const seen = new Set<string>();
        (stage.rules ?? []).forEach((r, i) => {
          const rat = `${at}.rules[${i}]`;
          if (!r.id) errors.push(`${rat}.id: required`);
          else if (seen.has(r.id)) errors.push(`${rat}.id: duplicate rule id "${r.id}" in stage`);
          else seen.add(r.id);
          if (!r.description) errors.push(`${rat}.description: required (it is shown in decision explanations)`);
          validateCondition(r.when, `${rat}.when`, errors);
          const f = r.onFail;
          const okAction = f === 'reject' || f === 'manual_review' || f === 'flag' || (typeof f === 'object' && f !== null && typeof f.goto === 'string');
          if (!okAction) errors.push(`${rat}.onFail: must be reject | manual_review | flag | {goto}`);
          else if (typeof f === 'object' && !exists(f.goto)) errors.push(`${rat}.onFail.goto: unknown stage "${f.goto}"`);
        });
        if (!exists(stage.next)) errors.push(`${at}.next: unknown stage "${String(stage.next)}"`);
        break;
      }
      case 'branch': {
        if (!Array.isArray(stage.branches) || stage.branches.length === 0) errors.push(`${at}.branches: at least one branch required`);
        (stage.branches ?? []).forEach((b, i) => {
          validateCondition(b.when, `${at}.branches[${i}].when`, errors);
          if (!exists(b.goto)) errors.push(`${at}.branches[${i}].goto: unknown stage "${String(b.goto)}"`);
        });
        if (!exists(stage.default)) errors.push(`${at}.default: unknown stage "${String(stage.default)}"`);
        break;
      }
      case 'dependency': {
        if (!knownDependencies.includes(stage.dependency)) errors.push(`${at}.dependency: unknown dependency "${String(stage.dependency)}" (known: ${knownDependencies.join(', ')})`);
        if (!stage.resultKey || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(stage.resultKey)) errors.push(`${at}.resultKey: required identifier`);
        if (!stage.input || typeof stage.input !== 'object') errors.push(`${at}.input: required object`);
        else for (const [k, v] of Object.entries(stage.input)) validateOperand(v, `${at}.input.${k}`, errors);
        if (!exists(stage.next)) errors.push(`${at}.next: unknown stage "${String(stage.next)}"`);
        if (stage.retry && (!(stage.retry.maxAttempts >= 1) || !(stage.retry.backoffMs >= 0))) errors.push(`${at}.retry: maxAttempts >= 1 and backoffMs >= 0 required`);
        const a = stage.onFailure?.action;
        if (!['park', 'manual_review', 'reject', 'fallback'].includes(a as string)) errors.push(`${at}.onFailure.action: must be park | manual_review | reject | fallback`);
        if (a === 'fallback' && stage.onFailure.fallback === undefined) errors.push(`${at}.onFailure.fallback: required when action is "fallback"`);
        break;
      }
      case 'decision':
        if (!['approve', 'reject', 'manual_review'].includes(stage.outcome)) errors.push(`${at}.outcome: must be approve | reject | manual_review`);
        if (!stage.reason) errors.push(`${at}.reason: required`);
        break;
      default:
        errors.push(`${at}.type: must be rules | branch | dependency | decision`);
    }
  }
  if (errors.length > 0) return { errors, warnings };

  // Graph checks (only meaningful once references resolve): reachability + cycles.
  const reachable = new Set<string>();
  const visit = (id: string): void => {
    if (reachable.has(id)) return;
    reachable.add(id);
    successors(d.stages[id]).forEach(visit);
  };
  visit(d.initialStage);
  for (const id of Object.keys(d.stages)) if (!reachable.has(id)) warnings.push(`stage "${id}" is unreachable from initialStage`);

  const state = new Map<string, 'visiting' | 'done'>();
  const cycle = (id: string, trail: string[]): void => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') { errors.push(`cycle detected: ${[...trail, id].join(' -> ')}`); return; }
    state.set(id, 'visiting');
    successors(d.stages[id]).forEach((n) => cycle(n, [...trail, id]));
    state.set(id, 'done');
  };
  cycle(d.initialStage, []);

  return { errors, warnings };
}
