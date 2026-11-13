import express, { NextFunction, Request, Response } from 'express';
import path from 'node:path';
import type { SimulatedDependency, FaultMode } from '../dependencies/simulated';
import {
  ConcurrencyError, ConfigError, ConflictError, IllegalTransitionError, NotFoundError, ValidationError,
} from '../domain/errors';
import type { WorkflowEngine } from '../engine/engine';

export interface AppContext {
  engine: WorkflowEngine;
  simulated: Map<string, SimulatedDependency>;
  samples: unknown;
}

const FAULT_MODES: FaultMode[] = ['none', 'down', 'fail_next', 'slow'];

export function createApp(ctx: AppContext) {
  const { engine } = ctx;
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  const api = express.Router();

  api.get('/health', (_req, res) => res.json({ status: 'ok', auditChain: engine.repo.verifyAuditChain().valid ? 'intact' : 'BROKEN' }));

  // ---- Workflow configuration ------------------------------------------------
  api.get('/workflows', (_req, res) => res.json({ workflows: engine.repo.listWorkflows() }));

  api.get('/workflows/:id', (req, res) => {
    const def = engine.repo.getActiveWorkflow(req.params.id);
    if (!def) throw new NotFoundError(`Unknown workflow "${req.params.id}"`);
    res.json({ active: def, versions: engine.repo.listVersions(req.params.id) });
  });

  api.get('/workflows/:id/versions/:version', (req, res) => {
    const def = engine.repo.getWorkflow(req.params.id, Number(req.params.version));
    if (!def) throw new NotFoundError(`Workflow ${req.params.id} v${req.params.version} not found`);
    res.json(def);
  });

  /** Dry-run validation: nothing is stored. */
  api.post('/workflows/validate', (req, res) => {
    const result = engine.validateWorkflow(req.body?.definition ?? req.body);
    res.status(result.errors.length ? 422 : 200).json({ valid: result.errors.length === 0, ...result });
  });

  /** Publish a new immutable version (becomes active unless `activate: false`). */
  api.post('/workflows', (req, res) => {
    const { definition, changeNote, activate, actor } = req.body ?? {};
    const out = engine.publishWorkflow(definition, { changeNote, activate, actor });
    res.status(201).json(out);
  });

  /** Roll forward / back: make an existing version the active one. */
  api.post('/workflows/:id/activate', (req, res) => {
    const version = Number(req.body?.version);
    if (!Number.isInteger(version)) throw new ValidationError('version (integer) is required', [{ path: 'version' }]);
    engine.repo.activateVersion(req.params.id, version, req.body?.actor ?? 'admin');
    res.json({ id: req.params.id, activeVersion: version });
  });

  api.get('/samples', (_req, res) => res.json(ctx.samples));

  // ---- Requests ----------------------------------------------------------------
  api.post('/requests', async (req, res) => {
    const { workflowId, payload } = req.body ?? {};
    if (typeof workflowId !== 'string') throw new ValidationError('workflowId (string) is required', [{ path: 'workflowId', message: 'required' }]);
    const key = req.header('Idempotency-Key') ?? undefined;
    const { request, replayed } = await engine.submit({ workflowId, payload, idempotencyKey: key });
    res.setHeader('Idempotent-Replayed', String(replayed));
    res.setHeader('Location', `/api/requests/${request.id}`);
    res.status(replayed ? 200 : 201).json({ replayed, request, links: links(request.id) });
  });

  api.get('/requests', (req, res) => {
    const limit = req.query.limit ? Math.min(500, Number(req.query.limit)) : 100;
    res.json({ requests: engine.repo.listRequests({ status: str(req.query.status), workflowId: str(req.query.workflowId), limit }) });
  });

  api.get('/requests/:id', (req, res) => {
    const request = engine.repo.requireRequest(req.params.id);
    res.json({ request, history: engine.repo.getHistory(request.id), links: links(request.id) });
  });

  api.get('/requests/:id/audit', (req, res) => {
    const request = engine.repo.requireRequest(req.params.id);
    res.json({ requestId: request.id, events: engine.repo.getAudit(request.id) });
  });

  api.get('/requests/:id/explanation', (req, res) => {
    const exp = engine.explain(req.params.id);
    if (req.query.format === 'text') return void res.type('text/plain').send(exp.text);
    res.json(exp);
  });

  api.post('/requests/:id/retry', async (req, res) => {
    const request = await engine.retry(req.params.id, req.body?.actor ?? 'operator');
    res.json({ request, links: links(request.id) });
  });

  api.post('/requests/:id/review', (req, res) => {
    const request = engine.review(req.params.id, { decision: req.body?.decision, reviewer: req.body?.reviewer, note: req.body?.note });
    res.json({ request, links: links(request.id) });
  });

  // ---- Audit -------------------------------------------------------------------
  api.get('/audit', (_req, res) => res.json({ events: engine.repo.getAudit() }));
  api.get('/audit/verify', (_req, res) => res.json(engine.repo.verifyAuditChain()));

  // ---- Operations / simulation controls ---------------------------------------
  api.get('/admin/dependencies', (_req, res) => {
    res.json({
      dependencies: [...ctx.simulated.values()].map((d) => ({ name: d.name, description: d.description, fault: d.getFault(), stats: d.stats })),
    });
  });

  api.post('/admin/dependencies/:name/fault', (req, res) => {
    const dep = ctx.simulated.get(req.params.name);
    if (!dep) throw new NotFoundError(`Unknown dependency "${req.params.name}"`);
    const { mode, count, latencyMs, retryable } = req.body ?? {};
    if (!FAULT_MODES.includes(mode)) throw new ValidationError(`mode must be one of ${FAULT_MODES.join(', ')}`, [{ path: 'mode' }]);
    dep.setFault({ mode, remaining: mode === 'fail_next' ? Number(count ?? 1) : undefined, latencyMs, retryable });
    res.json({ name: dep.name, fault: dep.getFault() });
  });

  api.post('/admin/dependencies/:name/reset', (req, res) => {
    const dep = ctx.simulated.get(req.params.name);
    if (!dep) throw new NotFoundError(`Unknown dependency "${req.params.name}"`);
    dep.reset();
    res.json({ name: dep.name, fault: dep.getFault() });
  });

  api.post('/admin/process-retries', async (_req, res) => res.json({ retried: await engine.processDueRetries() }));
  api.post('/admin/recover', async (_req, res) => res.json({ recovered: await engine.recoverStuck(0) }));

  api.use((_req, _res, next) => next(new NotFoundError('Route not found')));
  app.use('/api', api);

  app.use(express.static(path.resolve(__dirname, '../../public')));

  // ---- Error mapping -------------------------------------------------------------
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const send = (status: number, code: string, message: string, details?: unknown) =>
      res.status(status).json({ error: { code, message, ...(details !== undefined ? { details } : {}) } });

    if (err instanceof ValidationError) return send(422, err.code, err.message, err.details);
    if (err instanceof ConfigError) return send(422, err.code, err.message, err.details);
    if (err instanceof NotFoundError) return send(404, err.code, err.message);
    if (err instanceof ConflictError || err instanceof IllegalTransitionError || err instanceof ConcurrencyError) return send(409, err.code, err.message);
    if ((err as { type?: string }).type === 'entity.parse.failed') return send(400, 'BAD_JSON', 'Request body is not valid JSON');
    console.error(err);
    return send(500, 'INTERNAL_ERROR', 'Unexpected server error');
  });

  return app;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const links = (id: string) => ({
  self: `/api/requests/${id}`, audit: `/api/requests/${id}/audit`,
  explanation: `/api/requests/${id}/explanation`, explanationText: `/api/requests/${id}/explanation?format=text`,
});
