import path from 'node:path';
import { createApp } from './api/app';
import { buildSystem, ROOT } from './bootstrap';

async function main() {
  const port = Number(process.env.PORT ?? 3000);
  const dbFile = process.env.DB_PATH ?? path.join(ROOT, 'data', 'workflow.db');
  const log = (msg: string, extra?: unknown) => console.warn(`[engine] ${msg}`, extra instanceof Error ? extra.message : extra ?? '');

  const sys = buildSystem({ dbFile, syncConfig: process.env.SYNC_CONFIG_ON_START === 'true', log });
  console.log(`Workflows published: ${sys.seeded.published.join(', ') || 'none'}; already present: ${sys.seeded.skipped.join(', ') || 'none'}`);

  // Crash recovery: anything left RECEIVED / IN_PROGRESS by a previous run is resumed.
  const recovered = await sys.engine.recoverStuck(0);
  if (recovered.length) console.log(`Recovered ${recovered.length} interrupted request(s)`);

  // Background worker: retry parked requests when their time comes. 0 disables it.
  const interval = Number(process.env.RETRY_WORKER_INTERVAL_MS ?? 5000);
  let timer: NodeJS.Timeout | undefined;
  if (interval > 0) {
    timer = setInterval(() => {
      sys.engine.processDueRetries().catch((e) => log('retry worker error', e));
      sys.engine.recoverStuck(60_000).catch((e) => log('recovery sweep error', e));
    }, interval);
  }

  const server = createApp({ engine: sys.engine, simulated: sys.simulated, samples: sys.samples }).listen(port, () => {
    console.log(`Workflow Decision Platform listening on http://localhost:${port}  (UI at /, API at /api)`);
  });

  const shutdown = () => {
    if (timer) clearInterval(timer);
    server.close(() => { sys.db.close(); process.exit(0); });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => { console.error(e); process.exit(1); });
