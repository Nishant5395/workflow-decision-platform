import { describe, expect, it } from 'vitest';
import { evaluateCondition, validateCondition } from '../src/rules/expression';
import type { Condition } from '../src/domain/types';

const ctx = { input: { age: 30, name: 'Asha', tags: ['a', 'b'], income: 1000, debt: 250, d1: '2026-10-01', d2: '2026-10-11' }, deps: { score: 700 } };
const run = (c: Condition) => evaluateCondition(c, ctx);

describe('expression evaluator', () => {
  it.each([
    [{ field: 'input.age', op: 'gte', value: 30 }, true],
    [{ field: 'input.age', op: 'gt', value: 30 }, false],
    [{ field: 'input.age', op: 'lt', value: 31 }, true],
    [{ field: 'input.age', op: 'lte', value: 29 }, false],
    [{ field: 'input.name', op: 'eq', value: 'Asha' }, true],
    [{ field: 'input.name', op: 'ne', value: 'Asha' }, false],
    [{ field: 'input.name', op: 'in', value: ['Asha', 'Bo'] }, true],
    [{ field: 'input.name', op: 'nin', value: ['Asha'] }, false],
    [{ field: 'input.tags', op: 'contains', value: 'b' }, true],
    [{ field: 'input.name', op: 'contains', value: 'sh' }, true],
    [{ field: 'input.name', op: 'matches', value: '^A.+a$' }, true],
    [{ field: 'input.age', op: 'between', value: [18, 65] }, true],
    [{ field: 'input.age', op: 'between', value: [31, 65] }, false],
    [{ field: 'input.name', op: 'exists' }, true],
    [{ field: 'input.nothing', op: 'missing' }, true],
  ] as [Condition, boolean][])('%j → %s', (cond, expected) => {
    expect(run(cond).passed).toBe(expected);
  });

  it('supports all / any / not nesting', () => {
    expect(run({ all: [{ field: 'input.age', op: 'gte', value: 18 }, { any: [{ field: 'input.name', op: 'eq', value: 'X' }, { not: { field: 'input.age', op: 'gt', value: 99 } }] }] }).passed).toBe(true);
    expect(run({ any: [{ field: 'input.age', op: 'lt', value: 1 }, { field: 'input.age', op: 'gt', value: 99 }] }).passed).toBe(false);
  });

  it('computes derived values with functions', () => {
    const c: Condition = { left: { fn: 'div', args: [{ ref: 'input.debt' }, { ref: 'input.income' }] }, op: 'lte', value: 0.25 };
    expect(run(c).passed).toBe(true);
    expect(run({ left: { fn: 'daysBetween', args: [{ ref: 'input.d1' }, { ref: 'input.d2' }] }, op: 'eq', value: 10 }).passed).toBe(true);
  });

  it('compares against other fields', () => {
    expect(run({ field: 'deps.score', op: 'gte', right: { ref: 'input.age' } }).passed).toBe(true);
  });

  it('fails safely (never throws) on missing data, type mismatch and division by zero', () => {
    const missing = run({ field: 'input.nothing', op: 'gte', value: 1 });
    expect(missing.passed).toBe(false);
    expect(missing.note).toMatch(/missing/);
    expect(run({ field: 'input.name', op: 'gt', value: 5 }).note).toMatch(/type mismatch/);
    const div = run({ left: { fn: 'div', args: [1, 0] }, op: 'gt', value: 0 });
    expect(div.passed).toBe(false);
    expect(div.note).toMatch(/division by zero/);
  });

  it('records a trace with the data references and values it read', () => {
    const t = run({ field: 'input.age', op: 'gte', value: 31 });
    expect(t.summary).toBe('input.age (30) gte 31 → false');
    expect(t.refs).toEqual([{ path: 'input.age', value: 30 }]);
    expect(t.left).toEqual({ expression: 'input.age', value: 30 });
    const nested = run({ all: [{ field: 'input.age', op: 'gte', value: 1 }, { field: 'deps.score', op: 'gte', value: 600 }] });
    expect(nested.refs.map((r) => r.path)).toEqual(['input.age', 'deps.score']);
    expect(nested.children).toHaveLength(2);
  });

  it('is data, not code: no eval — a malicious-looking string is just a literal', () => {
    expect(run({ field: 'input.name', op: 'eq', value: "process.exit(1)" }).passed).toBe(false);
  });
});

describe('static condition validation', () => {
  const errs = (c: unknown) => { const e: string[] = []; validateCondition(c, 'c', e); return e; };
  it('accepts valid conditions', () => expect(errs({ field: 'input.a', op: 'eq', value: 1 })).toEqual([]));
  it('rejects unknown operators', () => expect(errs({ field: 'a', op: 'approx', value: 1 })[0]).toMatch(/unknown operator/));
  it('rejects missing operands', () => {
    expect(errs({ op: 'eq', value: 1 })[0]).toMatch(/needs "field" or "left"/);
    expect(errs({ field: 'a', op: 'eq' })[0]).toMatch(/needs "value" or "right"/);
  });
  it('rejects unknown functions and empty groups', () => {
    expect(errs({ left: { fn: 'sqrt', args: [1] }, op: 'eq', value: 1 })[0]).toMatch(/unknown function/);
    expect(errs({ all: [] })[0]).toMatch(/non-empty/);
  });
});
