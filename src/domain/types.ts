// ---------------------------------------------------------------------------
// Core domain types. Everything a workflow *config* can express lives here, so
// the JSON files in /config/workflows are typed against these definitions.
// ---------------------------------------------------------------------------

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Lifecycle states of a request (see lifecycle.ts for the allowed transitions). */
export type RequestStatus =
  | 'RECEIVED'
  | 'IN_PROGRESS'
  | 'PENDING_RETRY'
  | 'MANUAL_REVIEW'
  | 'APPROVED'
  | 'REJECTED'
  | 'FAILED';

// ---- Expressions ----------------------------------------------------------

/** A value: a literal, a reference into the evaluation context, or a function call. */
export type Operand = Json | { ref: string } | { fn: string; args: Operand[] };

export type Operator =
  | 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'in' | 'nin' | 'exists' | 'missing'
  | 'matches' | 'contains' | 'between';

export interface CompareCondition {
  /** Shorthand for `left: { ref: field }`. */
  field?: string;
  left?: Operand;
  op: Operator;
  /** Shorthand for `right`. */
  value?: Operand;
  right?: Operand;
}
export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | CompareCondition;

// ---- Stages ---------------------------------------------------------------

export type RuleFailAction = 'reject' | 'manual_review' | 'flag' | { goto: string };

export interface RuleDef {
  id: string;
  description: string;
  when: Condition;
  /** What happens when `when` evaluates to false. */
  onFail: RuleFailAction;
  /** Reason recorded on failure. Defaults to the description. */
  reason?: string;
}

export interface RulesStage {
  type: 'rules';
  description?: string;
  rules: RuleDef[];
  /** Stage to run when no rule forced a different path. */
  next: string;
}

export interface BranchStage {
  type: 'branch';
  description?: string;
  branches: { id: string; description?: string; when: Condition; goto: string }[];
  default: string;
}

export interface DependencyFailurePolicy {
  /**
   * park           -> request goes to PENDING_RETRY and is retried later
   * manual_review  -> fail closed: hand to a human
   * reject         -> fail closed: reject
   * fallback       -> continue using `fallback` as the dependency result (and flag it)
   */
  action: 'park' | 'manual_review' | 'reject' | 'fallback';
  fallback?: Json;
  /** For `park`: how many times a request may be parked before escalating. Default 3. */
  maxParkedRetries?: number;
  /** For `park`: what to do once parked retries are exhausted. Default manual_review. */
  afterExhausted?: 'manual_review' | 'reject';
  /** For `park`: base delay before the scheduler retries (doubles each park). Default 30000. */
  retryDelayMs?: number;
  reason?: string;
}

export interface DependencyStage {
  type: 'dependency';
  description?: string;
  dependency: string;
  input: Record<string, Operand>;
  /** Result is stored at context `deps.<resultKey>`. */
  resultKey: string;
  timeoutMs?: number;
  /** In-call retries (immediate, with exponential backoff). */
  retry?: { maxAttempts: number; backoffMs: number; factor?: number };
  onFailure: DependencyFailurePolicy;
  next: string;
}

export interface DecisionStage {
  type: 'decision';
  description?: string;
  outcome: 'approve' | 'reject' | 'manual_review';
  reason: string;
}

export type Stage = RulesStage | BranchStage | DependencyStage | DecisionStage;

export interface WorkflowDefinition {
  id: string;
  /** Assigned by the platform at publish time; any value supplied is ignored. */
  version?: number;
  name: string;
  description?: string;
  /** JSON Schema (draft-07 style) the incoming payload must satisfy. */
  inputSchema: Record<string, unknown>;
  idempotency?: {
    /** Payload paths that form the business key when no Idempotency-Key header is supplied. */
    keyFields?: string[];
  };
  initialStage: string;
  stages: Record<string, Stage>;
  limits?: { maxSteps?: number };
}

// ---- Runtime records ------------------------------------------------------

export interface Reason {
  stage: string;
  ruleId?: string;
  message: string;
  action: string;
}

export interface RequestContext {
  /** Results of dependency stages, addressable as `deps.<key>` in expressions. */
  deps: Record<string, Json>;
  /** Non-blocking findings (rule `flag` actions, dependency fallbacks). */
  flags: Reason[];
  /** Reasons accumulated on the way to the outcome. */
  reasons: Reason[];
  /** Stage ids visited, in order. */
  path: string[];
  steps: number;
}

export interface Outcome {
  decision: 'APPROVED' | 'REJECTED' | 'MANUAL_REVIEW';
  reasons: Reason[];
  decidedBy: string;
  decidedAt: string;
}

export interface RequestRecord {
  id: string;
  workflowId: string;
  workflowVersion: number;
  idempotencyKey: string;
  payloadHash: string;
  payload: Json;
  status: RequestStatus;
  currentStage: string | null;
  context: RequestContext;
  outcome: Outcome | null;
  retryCount: number;
  nextRetryAt: string | null;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEventInput {
  requestId?: string | null;
  type: string;
  stage?: string | null;
  actor?: string;
  data?: Json;
}

export interface AuditEvent {
  seq: number;
  requestId: string | null;
  ts: string;
  type: string;
  stage: string | null;
  actor: string;
  data: Json;
  prevHash: string;
  hash: string;
}

export interface StateChange {
  id: number;
  requestId: string;
  fromStatus: RequestStatus | null;
  toStatus: RequestStatus;
  stage: string | null;
  reason: string;
  actor: string;
  at: string;
}
