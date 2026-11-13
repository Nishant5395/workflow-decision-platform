import request from 'supertest';
import { createApp } from '../src/api/app';
import { buildSystem } from '../src/bootstrap';
import type { Clock } from '../src/domain/util';

/** A clock tests can move forward by hand. */
export class FakeClock implements Clock {
  constructor(private t = Date.parse('2026-11-13T10:00:00.000Z')) {}
  now(): Date { return new Date(this.t); }
  advance(ms: number): void { this.t += ms; }
}

/** Fresh in-memory system: real engine, real SQLite, simulated dependencies, no real sleeping. */
export function makeSystem() {
  const clock = new FakeClock();
  const sleeps: number[] = [];
  const sys = buildSystem({ clock, sleep: async (ms) => { sleeps.push(ms); } });
  const app = createApp({ engine: sys.engine, simulated: sys.simulated, samples: sys.samples });
  return { ...sys, clock, sleeps, app, http: request(app) };
}

export const loanPayload = (over: { id?: string; age?: number; income?: number; debt?: number; amount?: number; tenure?: number } = {}) => ({
  applicant: {
    id: over.id ?? 'GOOD-1001', name: 'Asha Verma', age: over.age ?? 35, monthlyIncome: over.income ?? 80000,
    monthlyDebt: over.debt ?? 5000, employmentStatus: 'salaried',
  },
  loan: { amount: over.amount ?? 500000, tenureMonths: over.tenure ?? 60, purpose: 'home' },
});

export const claimPayload = (over: { claimId?: string; policy?: string; amount?: number; type?: string; docs?: string[]; incident?: string; reported?: string } = {}) => ({
  claim: {
    claimId: over.claimId ?? 'CLM-1', policyNumber: over.policy ?? 'POL-1', type: over.type ?? 'auto', amount: over.amount ?? 3500,
    incidentDate: over.incident ?? '2026-10-02', reportedDate: over.reported ?? '2026-10-05',
  },
  claimant: { id: 'C-1', name: 'Priya' },
  documents: over.docs ?? ['invoice'],
});
