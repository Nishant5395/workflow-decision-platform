import { ConfigError } from '../domain/errors';
import type { Condition, Json, Operand, Operator } from '../domain/types';
import { getPath, toJson } from '../domain/util';

// ---------------------------------------------------------------------------
// A small, safe, declarative expression language. No eval(), no code in config.
// Every evaluation returns a *trace*: what was compared, with which values, read
// from which data paths. That trace is what makes decisions explainable.
// ---------------------------------------------------------------------------

export const OPERATORS: Operator[] = [
  'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'nin', 'exists', 'missing', 'matches', 'contains', 'between',
];

type FnImpl = (...args: unknown[]) => unknown;
const num = (v: unknown): number => {
  if (typeof v !== 'number' || Number.isNaN(v)) throw new TypeError(`expected number, got ${JSON.stringify(v)}`);
  return v;
};
const DAY_MS = 86_400_000;

export const FUNCTIONS: Record<string, FnImpl> = {
  add: (...a) => a.reduce<number>((s, v) => s + num(v), 0),
  sub: (a, b) => num(a) - num(b),
  mul: (...a) => a.reduce<number>((s, v) => s * num(v), 1),
  div: (a, b) => {
    if (num(b) === 0) throw new RangeError('division by zero');
    return num(a) / num(b);
  },
  min: (...a) => Math.min(...a.map(num)),
  max: (...a) => Math.max(...a.map(num)),
  abs: (a) => Math.abs(num(a)),
  len: (a) => (typeof a === 'string' || Array.isArray(a) ? a.length : (() => { throw new TypeError('len needs string/array'); })()),
  lower: (a) => String(a).toLowerCase(),
  upper: (a) => String(a).toUpperCase(),
  /** Whole days from date `a` to date `b` (ISO strings). */
  daysBetween: (a, b) => {
    const da = Date.parse(String(a));
    const db = Date.parse(String(b));
    if (Number.isNaN(da) || Number.isNaN(db)) throw new TypeError('daysBetween needs ISO dates');
    return Math.round((db - da) / DAY_MS);
  },
};

export interface DataRef { path: string; value: Json }

export interface ConditionTrace {
  kind: 'compare' | 'all' | 'any' | 'not';
  passed: boolean;
  /** Human-readable one-liner, e.g. `input.applicant.age (19) gte 21 → false`. */
  summary: string;
  op?: Operator;
  left?: { expression: string; value: Json };
  right?: { expression: string; value: Json };
  /** Data the evaluation read from the context (path + value at evaluation time). */
  refs: DataRef[];
  note?: string;
  children?: ConditionTrace[];
}

interface Evaluated { value: unknown; label: string; refs: DataRef[]; error?: string }

function isRef(o: unknown): o is { ref: string } {
  return !!o && typeof o === 'object' && !Array.isArray(o) && typeof (o as { ref?: unknown }).ref === 'string' && Object.keys(o).length === 1;
}
function isFn(o: unknown): o is { fn: string; args: Operand[] } {
  return !!o && typeof o === 'object' && !Array.isArray(o) && typeof (o as { fn?: unknown }).fn === 'string' && Array.isArray((o as { args?: unknown }).args);
}

export function evalOperand(operand: Operand | undefined, ctx: unknown): Evaluated {
  if (operand === undefined) return { value: undefined, label: 'undefined', refs: [] };
  if (isRef(operand)) {
    const value = getPath(ctx, operand.ref);
    return { value, label: operand.ref, refs: [{ path: operand.ref, value: toJson(value) }] };
  }
  if (isFn(operand)) {
    const parts = operand.args.map((a) => evalOperand(a, ctx));
    const refs = parts.flatMap((p) => p.refs);
    const label = `${operand.fn}(${parts.map((p) => p.label).join(', ')})`;
    const impl = FUNCTIONS[operand.fn];
    if (!impl) throw new ConfigError(`Unknown function "${operand.fn}"`);
    const argError = parts.find((p) => p.error)?.error;
    if (argError) return { value: undefined, label, refs, error: argError };
    try {
      return { value: impl(...parts.map((p) => p.value)), label, refs };
    } catch (e) {
      // e.g. a missing field fed into arithmetic: the comparison simply fails, with an explanation.
      return { value: undefined, label, refs, error: `${operand.fn} could not be computed: ${(e as Error).message}` };
    }
  }
  return { value: operand, label: JSON.stringify(operand), refs: [] };
}

const same = (a: unknown, b: unknown): boolean =>
  typeof a === 'object' || typeof b === 'object' ? JSON.stringify(a) === JSON.stringify(b) : a === b;

function ordered(a: unknown, b: unknown, test: (c: number) => boolean): { ok: boolean; note?: string } {
  if (a === undefined || a === null || b === undefined || b === null) return { ok: false, note: 'a compared value is missing' };
  if ((typeof a === 'number' && typeof b === 'number') || (typeof a === 'string' && typeof b === 'string')) {
    return { ok: test(a < b ? -1 : a > b ? 1 : 0) };
  }
  return { ok: false, note: 'type mismatch between compared values' };
}

function applyOp(op: Operator, l: unknown, r: unknown): { ok: boolean; note?: string } {
  switch (op) {
    case 'eq': return { ok: same(l, r) };
    case 'ne': return { ok: !same(l, r) };
    case 'gt': return ordered(l, r, (c) => c > 0);
    case 'gte': return ordered(l, r, (c) => c >= 0);
    case 'lt': return ordered(l, r, (c) => c < 0);
    case 'lte': return ordered(l, r, (c) => c <= 0);
    case 'in': return Array.isArray(r) ? { ok: r.some((x) => same(x, l)) } : { ok: false, note: 'right side of "in" must be a list' };
    case 'nin': return Array.isArray(r) ? { ok: !r.some((x) => same(x, l)) } : { ok: false, note: 'right side of "nin" must be a list' };
    case 'exists': return { ok: l !== undefined && l !== null };
    case 'missing': return { ok: l === undefined || l === null };
    case 'matches':
      if (typeof l !== 'string' || typeof r !== 'string') return { ok: false, note: '"matches" needs a string and a pattern' };
      return { ok: new RegExp(r).test(l) };
    case 'contains':
      if (typeof l === 'string' && typeof r === 'string') return { ok: l.includes(r) };
      if (Array.isArray(l)) return { ok: l.some((x) => same(x, r)) };
      return { ok: false, note: '"contains" needs a string or list on the left' };
    case 'between':
      if (!Array.isArray(r) || r.length !== 2) return { ok: false, note: '"between" needs [low, high]' };
      return { ok: ordered(l, r[0], (c) => c >= 0).ok && ordered(l, r[1], (c) => c <= 0).ok };
  }
}

const show = (v: unknown): string => (v === undefined ? 'missing' : JSON.stringify(v));

export function evaluateCondition(cond: Condition, ctx: unknown): ConditionTrace {
  if ('all' in cond) {
    const children = cond.all.map((c) => evaluateCondition(c, ctx));
    const passed = children.every((c) => c.passed);
    return { kind: 'all', passed, summary: `all of ${children.length} conditions → ${passed}`, refs: children.flatMap((c) => c.refs), children };
  }
  if ('any' in cond) {
    const children = cond.any.map((c) => evaluateCondition(c, ctx));
    const passed = children.some((c) => c.passed);
    return { kind: 'any', passed, summary: `any of ${children.length} conditions → ${passed}`, refs: children.flatMap((c) => c.refs), children };
  }
  if ('not' in cond) {
    const child = evaluateCondition(cond.not, ctx);
    return { kind: 'not', passed: !child.passed, summary: `not (${child.summary}) → ${!child.passed}`, refs: child.refs, children: [child] };
  }

  const leftOperand: Operand | undefined = cond.field !== undefined ? { ref: cond.field } : cond.left;
  const rightOperand: Operand | undefined = cond.value !== undefined ? cond.value : cond.right;
  const l = evalOperand(leftOperand, ctx);
  const r = evalOperand(rightOperand, ctx);
  const computeError = l.error ?? r.error;
  const result = computeError ? { ok: false, note: computeError } : applyOp(cond.op, l.value, r.value);
  const unary = cond.op === 'exists' || cond.op === 'missing';
  const summary = unary
    ? `${l.label} (${show(l.value)}) ${cond.op} → ${result.ok}`
    : `${l.label} (${show(l.value)}) ${cond.op} ${r.label === JSON.stringify(r.value) ? '' : `${r.label} `}${show(r.value)} → ${result.ok}`;
  return {
    kind: 'compare',
    passed: result.ok,
    summary: result.note ? `${summary} [${result.note}]` : summary,
    op: cond.op,
    left: { expression: l.label, value: toJson(l.value) },
    ...(unary ? {} : { right: { expression: r.label, value: toJson(r.value) } }),
    refs: [...l.refs, ...r.refs],
    ...(result.note ? { note: result.note } : {}),
  };
}

// ---- Static validation (used when a workflow is published) ----------------

export function validateCondition(cond: unknown, at: string, errors: string[]): void {
  if (!cond || typeof cond !== 'object' || Array.isArray(cond)) {
    errors.push(`${at}: condition must be an object`);
    return;
  }
  const c = cond as Record<string, unknown>;
  if ('all' in c || 'any' in c) {
    const key = 'all' in c ? 'all' : 'any';
    const list = c[key];
    if (!Array.isArray(list) || list.length === 0) errors.push(`${at}.${key}: must be a non-empty list`);
    else list.forEach((child, i) => validateCondition(child, `${at}.${key}[${i}]`, errors));
    return;
  }
  if ('not' in c) return validateCondition(c.not, `${at}.not`, errors);

  if (!OPERATORS.includes(c.op as Operator)) errors.push(`${at}: unknown operator "${String(c.op)}"`);
  if (c.field === undefined && c.left === undefined) errors.push(`${at}: needs "field" or "left"`);
  if (c.field !== undefined && typeof c.field !== 'string') errors.push(`${at}.field: must be a string path`);
  const unary = c.op === 'exists' || c.op === 'missing';
  if (!unary && c.value === undefined && c.right === undefined) errors.push(`${at}: operator "${String(c.op)}" needs "value" or "right"`);
  for (const key of ['left', 'right', 'value'] as const) if (c[key] !== undefined) validateOperand(c[key], `${at}.${key}`, errors);
}

export function validateOperand(op: unknown, at: string, errors: string[]): void {
  if (isFn(op)) {
    if (!FUNCTIONS[op.fn]) errors.push(`${at}: unknown function "${op.fn}"`);
    op.args.forEach((a, i) => validateOperand(a, `${at}.args[${i}]`, errors));
  } else if (op && typeof op === 'object' && !Array.isArray(op)) {
    const keys = Object.keys(op);
    if (keys.includes('fn') || keys.includes('ref')) {
      if (!isRef(op)) errors.push(`${at}: malformed operand (expected {"ref": "path"} or {"fn": name, "args": [...]})`);
    }
  }
}
