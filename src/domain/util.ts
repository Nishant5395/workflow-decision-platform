import { createHash } from 'node:crypto';
import type { Json } from './types';

/** JSON.stringify with sorted object keys, so equal data always serialises identically. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).sort()) out[k] = sortKeys((value as Record<string, unknown>)[k]);
    return out;
  }
  return value;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Read `a.b.0.c` style paths. Returns undefined when any segment is missing. */
export function getPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

export function toJson(value: unknown): Json {
  // undefined has no JSON representation; make it explicit in audit data.
  return value === undefined ? null : (JSON.parse(JSON.stringify(value)) as Json);
}

export interface Clock { now(): Date }
export const systemClock: Clock = { now: () => new Date() };
export type Sleep = (ms: number) => Promise<void>;
export const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));
