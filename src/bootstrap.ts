import fs from 'node:fs';
import path from 'node:path';
import { seedWorkflows } from './config/loader';
import { createSimulatedDependencies } from './dependencies/simulated';
import { WorkflowEngine } from './engine/engine';
import { openDb } from './store/db';
import { Repository } from './store/repository';
import type { Clock, Sleep } from './domain/util';

export const ROOT = path.resolve(__dirname, '..');

export interface BuildOptions {
  dbFile?: string;
  workflowsDir?: string;
  seed?: boolean;
  syncConfig?: boolean;
  clock?: Clock;
  sleep?: Sleep;
  log?: (msg: string, extra?: unknown) => void;
}

/** Wire the whole system together. Used by the server, the tests and the examples script. */
export function buildSystem(o: BuildOptions = {}) {
  const db = openDb(o.dbFile ?? ':memory:');
  const repo = new Repository(db, o.clock);
  const { registry, simulated } = createSimulatedDependencies();
  const engine = new WorkflowEngine({ repo, dependencies: registry, clock: o.clock, sleep: o.sleep, log: o.log });
  const seeded = (o.seed ?? true)
    ? seedWorkflows(engine, o.workflowsDir ?? path.join(ROOT, 'config', 'workflows'), { sync: o.syncConfig })
    : { published: [], skipped: [] };
  const samples = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'samples.json'), 'utf8'));
  return { db, repo, engine, simulated, registry, samples, seeded };
}
