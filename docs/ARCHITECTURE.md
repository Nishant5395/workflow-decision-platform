# Architecture

## 1. Problem boundaries

**In scope:** intake and validation, rule evaluation, multi-stage workflows, external dependency calls, lifecycle state, audit and explanation, retries, idempotency, runtime-changeable configuration.
**Out of scope (assumptions):** authentication/authorisation, multi-tenant isolation, a real message broker, real external services (simulated), a visual workflow designer, reviewer assignment/queues.

Key assumptions: a single logical decision per request; rules are declarative and side-effect free; dependencies are idempotent given a key (as most payment/KYC APIs are); business correctness beats availability for compliance checks (fail closed).

## 2. Components and separation of concerns

```
 REST/UI ─► WorkflowEngine ─► WorkflowExecutor ─► Rules (pure) / Dependencies (I/O)
 (api)      intake, idempotency,   stage loop,          │
            retry, review,         commit per stage     ▼
            recovery, explain                    Repository (SQLite transactions)
                                                  requests · state_history · audit_log · workflow versions
```

| Module | Responsibility | Knows nothing about |
|---|---|---|
| `domain` | Types, error taxonomy, **state machine** (single source of legal transitions) | storage, HTTP |
| `rules` | Safe expression language returning a **trace** (values + data refs) | workflows, DB |
| `config` | Validate/load definitions | execution |
| `engine/executor` | Compute a stage, then commit it atomically | HTTP |
| `engine/engine` | Application service: lifecycle around execution | HTTP framing |
| `store` | All persistence; the only writer of request state | business rules |
| `dependencies` | Adapter interface + simulated services with fault injection | engine internals |
| `api` | Transport and error mapping only | everything else |

Adding a business use case = add JSON. Adding a new operator/function = one entry in `rules/expression.ts`. Adding a real dependency = implement `Dependency` and register it. Swapping SQLite = reimplement `Repository`.

## 3. Data flow

1. **Intake.** Resolve active workflow version, validate payload with Ajv. Failure: 422, nothing stored except an `intake_rejected` audit event.
2. **Idempotency.** Key = `Idempotency-Key` header, else a hash of the configured business key fields (or the whole canonical payload). A single transaction inserts the request or returns the existing one. Same key + same payload returns the original (200, `Idempotent-Replayed: true`). Same key + different payload returns 409. A `UNIQUE(workflow_id, idempotency_key)` constraint is the final arbiter under concurrency.
3. **Execute.** `RECEIVED → IN_PROGRESS`; the executor loops over stages. Each iteration *computes* the stage (pure for rules/branch, I/O for dependency) and then **commits one transaction** containing audit events, new context/current stage, state-history row, and the optimistic-lock version bump.
4. **Outcome.** `APPROVED`, `REJECTED`, `MANUAL_REVIEW`, `PENDING_RETRY`, or `FAILED` (engine/config error).
5. **After.** Humans resolve `MANUAL_REVIEW` via `/review`; a worker (or operator) resumes `PENDING_RETRY` via `/retry`.

### Lifecycle
```
RECEIVED → IN_PROGRESS → APPROVED | REJECTED
                │  ▲
                │  └── PENDING_RETRY (dependency outage / persistence failure)
                ├─────► MANUAL_REVIEW → APPROVED | REJECTED
                └─────► FAILED
```
Terminal states are immutable; every move passes `assertTransition`.

## 4. Failure handling

| Failure | Behaviour |
|---|---|
| Invalid input | 422 with per-field errors; audited; no request created |
| Duplicate request | Original returned; no re-execution; replay audited |
| Key reused with other payload | 409; conflict audited |
| Dependency transient error | In-call retry with exponential backoff (configurable), then per-stage policy |
| Dependency outage | `park`: `PENDING_RETRY` with exponentially growing `nextRetryAt`, bounded by `maxParkedRetries`, then escalates to manual review/reject. Other policies: fail-closed `manual_review`/`reject`, or `fallback` value (flagged) |
| Dependency timeout | Treated as a retryable failure |
| **Partial save failure** | Audit, state and history are one transaction; a failure **rolls back the whole step** (no half-written audit/state). The request is parked (`PENDING_RETRY`) with a `persistence_failure` event. If even that cannot be saved it stays `IN_PROGRESS` and `recoverStuck` (run at startup and periodically) resumes it |
| Replayed dependency call after a lost commit | Each call carries a stable key `requestId:stageId`; the dependency de-duplicates, so the retry has one business effect |
| Crash mid-run | Resume from `current_stage` with dependency results already persisted in context; finished stages are not redone |
| Concurrent writers | Optimistic locking on `row_version`; stale writers get a 409/`CONCURRENT_MODIFICATION` |
| Bad config at runtime | Validated at publish; engine errors at run time mark the request `FAILED` with an audit entry |

## 5. Auditability and explainability

* `audit_log` is **append-only** (SQLite triggers refuse UPDATE/DELETE) and **hash-chained** (each row hashes the previous hash plus its content). `/api/audit/verify` recomputes the chain; tampering or deletion is detected even if triggers are bypassed (tested).
* Every rule evaluation stores a trace: the expression, the actual values, the result and the exact data paths read, e.g. `deps.credit.score (520) gte 550 → false`.
* `explain` is built **only from persisted facts** (audit + state), so an explanation of a past decision is reproducible and independent of the current config.
* `state_history` records every transition with actor and reason.

## 6. Configurability and change tolerance

* Workflows are data: stage graph, rules, thresholds, routing, dependency inputs, retry/failure policy, and idempotency key fields.
* **Immutable versions** with an active pointer: publish = new version, rollback = move the pointer. In-flight requests stay pinned to their version, so a rule change never alters a decision half-way through.
* Publish-time validation: JSON Schema compile, operators/functions, stage references, dependency names, cycles (error), unreachable stages (warning).
* Config files bootstrap the database; afterwards the DB is the source of truth so UI/API edits are not overwritten on restart. `SYNC_CONFIG_ON_START=true` gives "config as code" mode.

## 7. Trade-offs and justification

| Decision | Why | Cost |
|---|---|---|
| Own small JSON rule language instead of embedding JS/`eval` or a rules engine | Safe (no code injection), validatable, and traceable with data references | Less expressive than a general language; new functions require a code change |
| Declarative stage graph, not BPMN/Temporal | Small surface, easy to reason about and test | No parallel stages, timers or sub-workflows |
| SQLite via built-in `node:sqlite` (synchronous) | Zero setup, real ACID transactions make atomic step commits and unique-constraint idempotency demonstrable | Single writer; see scaling |
| Commit per stage (not per request) | Crash/retry resumes mid-workflow without repeating work | More writes |
| Execution inside the request (synchronous) | Simple, immediate result for the caller | Long dependency outages block a request thread up to retry budget; mitigated by bounded in-call retries then parking |
| At-least-once execution + idempotent dependencies | Exactly-once is not achievable across a network boundary; this is the standard practical answer | Requires dependencies to honour idempotency keys |
| Fail closed for compliance dependencies (configurable per stage) | A wrong auto-approval is costlier than a delayed review | More manual work during outages |
| Reject outranks manual review; all rules always evaluated | Deterministic, complete explanations | Slightly more evaluation work |
| Optimistic locking, not row locks | Simple and works across processes | Losers must retry |

## 8. Scaling considerations

* **Storage:** move to PostgreSQL. The schema ports directly: `UNIQUE` constraint, transactions, `row_version`. Partition `audit_log` and `requests` by time; keep hash chains **per partition or per request stream** so appends do not serialise on one global tail (today's global chain is a deliberate simplicity choice and the main write bottleneck).
* **Execution:** split intake from execution. Intake persists `RECEIVED` and enqueues (Kafka/SQS/Postgres `SKIP LOCKED`); stateless workers claim requests with a lease. The existing resume-from-`current_stage`, idempotent steps and optimistic lock already make workers safe to run concurrently and to crash.
* **Retries:** replace the in-process timer with a delayed queue; per-dependency circuit breakers and rate limits so one outage does not exhaust workers.
* **Dependencies:** real HTTP adapters with connection pooling, per-dependency bulkheads, and caching of read-only lookups.
* **Config:** cache compiled validators and definitions by `(id, version)`. They are immutable, so caching is trivially safe.
* **Reads:** explanations are derived from persisted events, so they can be served from read replicas or precomputed.
* **Observability:** add metrics (stage latency, parked count, dependency error rate) and tracing keyed by request id; the audit log already carries the correlation data.
* **Security (not implemented):** authn/z, per-tenant data isolation, PII encryption/redaction in audit data, signed audit-chain anchors written to external storage.

## 9. Known limitations

No auth; synchronous execution; single-node SQLite; global audit chain; manual-review has no assignment/SLA model; the simulated dependencies are in-process.
