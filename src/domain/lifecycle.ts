import { IllegalTransitionError } from './errors';
import type { RequestStatus } from './types';

/**
 * The request lifecycle as an explicit state machine.
 *
 *   RECEIVED ──► IN_PROGRESS ──► APPROVED | REJECTED
 *                    │  ▲
 *                    │  └──────── PENDING_RETRY   (dependency outage / persistence failure)
 *                    ├──────────► MANUAL_REVIEW ──► APPROVED | REJECTED
 *                    └──────────► FAILED           (configuration / engine error)
 *
 * Every status change in the system goes through `assertTransition`, so an
 * illegal move (e.g. APPROVED -> REJECTED) is impossible regardless of caller.
 */
const TRANSITIONS: Record<RequestStatus, RequestStatus[]> = {
  RECEIVED: ['IN_PROGRESS', 'FAILED'],
  IN_PROGRESS: ['PENDING_RETRY', 'MANUAL_REVIEW', 'APPROVED', 'REJECTED', 'FAILED'],
  PENDING_RETRY: ['IN_PROGRESS', 'FAILED'],
  MANUAL_REVIEW: ['APPROVED', 'REJECTED'],
  APPROVED: [],
  REJECTED: [],
  FAILED: [],
};

export const TERMINAL_STATUSES: RequestStatus[] = ['APPROVED', 'REJECTED', 'FAILED'];

export function canTransition(from: RequestStatus, to: RequestStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: RequestStatus, to: RequestStatus): void {
  if (!canTransition(from, to)) {
    throw new IllegalTransitionError(`Illegal state transition ${from} -> ${to}`);
  }
}

export function isTerminal(status: RequestStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
