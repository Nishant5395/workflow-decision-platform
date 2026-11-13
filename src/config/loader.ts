import fs from 'node:fs';
import path from 'node:path';
import type { WorkflowEngine } from '../engine/engine';
import type { WorkflowDefinition } from '../domain/types';

export function readWorkflowFiles(dir: string): WorkflowDefinition[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as WorkflowDefinition);
}

/**
 * Seed workflows from JSON files.
 *
 * Files are the *bootstrap* source: a workflow that does not exist yet is published as v1.
 * Once it exists, the database (with its version history) is the source of truth, so
 * edits made through the API are never silently overwritten on restart. Pass
 * `sync: true` (env SYNC_CONFIG_ON_START=true) to publish a new version whenever a file's
 * content differs from the active version ("config as code" mode).
 */
export function seedWorkflows(engine: WorkflowEngine, dir: string, opts: { sync?: boolean } = {}): { published: string[]; skipped: string[] } {
  const published: string[] = [];
  const skipped: string[] = [];
  for (const def of readWorkflowFiles(dir)) {
    const active = engine.repo.getActiveWorkflow(def.id);
    if (active) {
      const { version: _v, ...activeBody } = active;
      const { version: _f, ...fileBody } = def;
      const differs = JSON.stringify(sortDeep(activeBody)) !== JSON.stringify(sortDeep(fileBody));
      if (!(opts.sync && differs)) { skipped.push(def.id); continue; }
      const r = engine.publishWorkflow(def, { actor: 'config-sync', changeNote: 'Synced from config file' });
      published.push(`${r.id}@v${r.version}`);
      continue;
    }
    const r = engine.publishWorkflow(def, { actor: 'config-seed', changeNote: 'Initial version from config file' });
    published.push(`${r.id}@v${r.version}`);
  }
  return { published, skipped };
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep((v as Record<string, unknown>)[k])]));
  return v;
}
