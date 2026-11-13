import { DependencyError } from '../domain/errors';
import type { Json } from '../domain/types';
import { sha256 } from '../domain/util';
import { Dependency, DependencyRegistry, DependencyRequest } from './types';

export type FaultMode = 'none' | 'down' | 'fail_next' | 'slow';

export interface Fault {
  mode: FaultMode;
  /** fail_next: how many upcoming calls fail. */
  remaining?: number;
  /** slow: artificial latency in ms. */
  latencyMs?: number;
  /** Whether failures are retryable (transient) or permanent (e.g. a 4xx). Default true. */
  retryable?: boolean;
}

export interface DependencyStats {
  /** Every call attempt, including failed ones and replays. */
  calls: number;
  failures: number;
  /** Calls answered from the idempotency cache (the retry/replay was safe). */
  replays: number;
  /** Distinct idempotency keys that actually executed the business effect once. */
  effects: number;
}

type Handler = (input: Record<string, Json>) => Json;

/**
 * An in-process stand-in for an external HTTP service. It behaves like a real
 * one in the ways that matter for the platform: it can be down, flaky, slow,
 * or reject permanently, and it de-duplicates on the idempotency key.
 */
export class SimulatedDependency implements Dependency {
  private fault: Fault = { mode: 'none' };
  private readonly cache = new Map<string, Json>();
  readonly stats: DependencyStats = { calls: 0, failures: 0, replays: 0, effects: 0 };

  constructor(readonly name: string, readonly description: string, private readonly handler: Handler) {}

  setFault(fault: Fault): void { this.fault = { retryable: true, ...fault }; }
  getFault(): Fault { return { ...this.fault }; }
  reset(): void {
    this.fault = { mode: 'none' };
    this.cache.clear();
    Object.assign(this.stats, { calls: 0, failures: 0, replays: 0, effects: 0 });
  }

  async call(req: DependencyRequest): Promise<Json> {
    this.stats.calls++;
    const f = this.fault;
    if (f.mode === 'slow' && f.latencyMs) await new Promise((r) => setTimeout(r, f.latencyMs));
    if (f.mode === 'down' || (f.mode === 'fail_next' && (f.remaining ?? 0) > 0)) {
      if (f.mode === 'fail_next') f.remaining = (f.remaining ?? 0) - 1;
      this.stats.failures++;
      const retryable = f.retryable !== false;
      throw new DependencyError(this.name, retryable ? 'UNAVAILABLE' : 'REJECTED', retryable ? `${this.name} is unavailable (503)` : `${this.name} rejected the request (400)`, retryable);
    }
    const cached = this.cache.get(req.idempotencyKey);
    if (cached !== undefined) { this.stats.replays++; return cached; }
    const result = this.handler(req.input);
    this.cache.set(req.idempotencyKey, result);
    this.stats.effects++;
    return result;
  }
}

const hashNumber = (s: string): number => parseInt(sha256(s).slice(0, 8), 16);

export function createSimulatedDependencies(): { registry: DependencyRegistry; simulated: Map<string, SimulatedDependency> } {
  const creditBureau = new SimulatedDependency('credit_bureau', 'Returns a credit score and open-loan count for an applicant', (input) => {
    const id = String(input.applicantId ?? '');
    // Prefixes give deterministic demo/test personas; anything else is a stable hash of the id.
    if (id.startsWith('GOOD')) return { applicantId: id, score: 780, openLoans: 1 };
    if (id.startsWith('FAIR')) return { applicantId: id, score: 650, openLoans: 2 };
    if (id.startsWith('POOR')) return { applicantId: id, score: 520, openLoans: 6 };
    return { applicantId: id, score: 300 + (hashNumber(id) % 550), openLoans: hashNumber(id + 'loans') % 4 };
  });

  const policyService = new SimulatedDependency('policy_service', 'Looks up policy status, coverage limit and period', (input) => {
    const n = String(input.policyNumber ?? '');
    const base = { policyNumber: n, startDate: '2026-01-01', endDate: '2026-12-31' };
    if (n.startsWith('POL-LAPSED')) return { ...base, active: false, coverageLimit: 0, coveredTypes: [] };
    if (n.startsWith('POL-LOW')) return { ...base, active: true, coverageLimit: 20000, coveredTypes: ['auto', 'health', 'property'] };
    if (n.startsWith('POL-AUTO')) return { ...base, active: true, coverageLimit: 500000, coveredTypes: ['auto'] };
    return { ...base, active: true, coverageLimit: 500000, coveredTypes: ['auto', 'health', 'property'] };
  });

  const sanctions = new SimulatedDependency('sanctions_screening', 'Screens a vendor name/country against sanctions and jurisdiction-risk lists', (input) => {
    const name = String(input.name ?? '').toUpperCase();
    const country = String(input.country ?? '').toUpperCase();
    const highRisk = ['KP', 'IR', 'SY'];
    const mediumRisk = ['RU', 'VE', 'MM'];
    return {
      sanctioned: name.includes('BLOCKED'),
      riskLevel: highRisk.includes(country) ? 'high' : mediumRisk.includes(country) ? 'medium' : 'low',
    };
  });

  const registry = new DependencyRegistry().register(creditBureau).register(policyService).register(sanctions);
  return { registry, simulated: new Map([creditBureau, policyService, sanctions].map((d) => [d.name, d])) };
}
