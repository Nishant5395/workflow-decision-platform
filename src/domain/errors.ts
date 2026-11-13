export class NotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor(message: string) { super(message); }
}

export class ValidationError extends Error {
  readonly code = 'VALIDATION_FAILED';
  constructor(message: string, readonly details: unknown[]) { super(message); }
}

/** Idempotency key re-used with a different payload. */
export class ConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT';
  constructor(message: string) { super(message); }
}

export class IllegalTransitionError extends Error {
  readonly code = 'ILLEGAL_TRANSITION';
  constructor(message: string) { super(message); }
}

/** Optimistic-lock failure: someone else changed the request since we read it. */
export class ConcurrencyError extends Error {
  readonly code = 'CONCURRENT_MODIFICATION';
  constructor(message: string) { super(message); }
}

/** A workflow definition is invalid or references something that does not exist. */
export class ConfigError extends Error {
  readonly code = 'INVALID_CONFIG';
  constructor(message: string, readonly details: string[] = []) { super(message); }
}

/** Raised by dependency adapters. `retryable` decides whether the in-call retry loop continues. */
export class DependencyError extends Error {
  constructor(
    readonly dependency: string,
    readonly errorCode: string,
    message: string,
    readonly retryable: boolean = true,
  ) {
    super(message);
  }
}
