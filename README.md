# Configurable Workflow Decision Platform

A generic engine that accepts structured requests, validates them, runs them through **configurable workflows** (rules, branches, external dependency calls, decisions), tracks lifecycle state with full history, and records a tamper-evident audit trail. Three business workflows ship as pure JSON config: **loan application**, **insurance claim processing**, **vendor approval**. A fourth (document verification) is added at runtime in the tests, with no code changes.

Stack: Node 22.13+ (uses the built-in `node:sqlite`, so nothing to compile), TypeScript, Express, SQLite, Ajv (JSON Schema), Vitest + Supertest. Minimal web UI included.

## Run it (VS Code)

1. `File > Open Folder...` and pick this folder (the one containing `package.json`).
2. Open the terminal (`Ctrl+` backtick) and run `npm install` then `npm start`. Or press `F5` ("Run server (debug)").
3. Open http://localhost:3000 in the browser.

## Run it (any terminal)

```bash
npm install     # needs Node 22.13+; no C++ build tools required
npm start            # http://localhost:3000  (UI at /, API at /api)
npm test             # 101 tests
npm run typecheck
npm run examples     # regenerates docs/DECISION_EXAMPLES.md from real runs
```

Env vars: `PORT` (3000), `DB_PATH` (data/workflow.db), `RETRY_WORKER_INTERVAL_MS` (5000, 0 disables), `SYNC_CONFIG_ON_START=true` (publish a new version when a config file differs from the active one).

## Try it in 60 seconds (UI)

1. Open http://localhost:3000, choose a workflow and a **sample scenario**, click **Submit**. The Result panel shows the explanation, state history and audit log.
2. **Submit twice** demonstrates idempotency (same request id returned).
3. In *Simulated external dependencies*, click **Take down** on `credit_bureau`, submit the "Strong applicant" loan, see `PENDING_RETRY`. Click **Restore**, then **Retry now**.
4. Open **Workflow configuration**, change e.g. `min_age` from 21 to 25, **Validate**, **Publish new version**, resubmit. Use **Activate** on v1 to roll back.

## REST API

| Method & path | Purpose |
|---|---|
| `POST /api/requests` `{workflowId, payload}` + optional `Idempotency-Key` header | Submit. 201 new, 200 replay of a duplicate, 409 key reused with different payload, 422 invalid input |
| `GET /api/requests`, `GET /api/requests/:id` | List / fetch request with state history |
| `GET /api/requests/:id/explanation[?format=text]` | Decision explanation: input, rules, values, data references, output |
| `GET /api/requests/:id/audit` | Full audit events for a request |
| `POST /api/requests/:id/retry` | Resume a `PENDING_RETRY` request |
| `POST /api/requests/:id/review` `{decision: approve\|reject, reviewer, note}` | Resolve `MANUAL_REVIEW` |
| `GET /api/workflows`, `GET /api/workflows/:id` | Active definition + version list |
| `POST /api/workflows/validate`, `POST /api/workflows` | Dry-run validate / publish a new immutable version |
| `POST /api/workflows/:id/activate` `{version}` | Roll forward/back |
| `GET /api/audit`, `GET /api/audit/verify` | Global audit, hash-chain verification |
| `GET/POST /api/admin/dependencies...` | Fault injection for the simulated dependencies |

Example:
```bash
curl -s localhost:3000/api/requests -H 'content-type: application/json' -H 'Idempotency-Key: demo-1' \
  -d '{"workflowId":"loan_application","payload":{"applicant":{"id":"GOOD-1","name":"Asha","age":35,"monthlyIncome":80000,"monthlyDebt":5000,"employmentStatus":"salaried"},"loan":{"amount":500000,"tenureMonths":60,"purpose":"home"}}}'
```

## Configuration model

A workflow is a JSON document (`config/workflows/*.json`) with a JSON-Schema `inputSchema`, an `initialStage`, and named `stages` of four types:

| Stage type | What it does |
|---|---|
| `rules` | Evaluates all rules (no short-circuit, for a complete trace). Each rule has `when` and `onFail`: `reject` / `manual_review` / `flag` / `{goto: stage}`. Reject outranks manual review. |
| `branch` | First matching `when` picks the next stage, else `default`. |
| `dependency` | Calls an external service with inputs from the context; `timeoutMs`, in-call `retry` with backoff, and `onFailure`: `park` (retry later, bounded) / `manual_review` / `reject` / `fallback`. |
| `decision` | Terminal: `approve` / `reject` / `manual_review` with a reason. |

Conditions: `all` / `any` / `not` and comparisons (`eq ne gt gte lt lte in nin exists missing matches contains between`) over `input.*` and `deps.*` paths or computed operands (`add sub mul div min max abs len lower upper daysBetween`). Config is data, never code (no `eval`).

Publishing validates schema, operators, stage references, dependencies, cycles and unreachable stages. Each publish is a new immutable version; **in-flight requests stay pinned to the version they started with**.

## Project layout

```
src/domain      types, errors, lifecycle state machine
src/rules       expression language + evaluation traces
src/config      definition validator, JSON loader
src/engine      executor (stage runner), engine (intake/retry/review/recovery), explain
src/store       SQLite schema + repository (transactions, audit chain)
src/dependencies  simulated external services with fault injection
src/api         Express routes + error mapping
config/         workflows/*.json, samples.json
tests/          101 tests     docs/  ARCHITECTURE.md, DECISION_EXAMPLES.md
```

## Test coverage map

| Required scenario | Where |
|---|---|
| Happy path | `workflows.test.ts` (all 17 samples) |
| Invalid input | `intake-and-idempotency.test.ts` |
| Duplicate requests / idempotency | `intake-and-idempotency.test.ts` (incl. 10 concurrent submits, DB unique constraint) |
| Dependency failure | `resilience.test.ts` (retry, timeout, non-retryable, fail-closed, fallback) |
| Retry flow | `resilience.test.ts` (park, resume, exponential delay, bounded, scheduler, concurrent retry) |
| Partial save failure | `resilience.test.ts` (rollback, resume with no duplicate effects, crash recovery) |
| Rule change | `rule-change.test.ts` (versioning, pinning, rollback, validation, new workflow at runtime) |
| Audit / explainability | `resilience.test.ts`, `rule-change.test.ts` (append-only, tamper detection) |

See `docs/ARCHITECTURE.md` for design, trade-offs and scaling, and `docs/DECISION_EXAMPLES.md` for explanation examples.
