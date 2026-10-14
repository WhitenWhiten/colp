# Local Backend-First Implementation Order

**Decision:** begin with BE-1, the configuration/preview slice of M1, not with a hosted dot or a Web screen. This is a proposed execution order, not a record that any task has been implemented. The same order is machine-readable in [backend-batches.json](backend-batches.json).

## 1. First batch: BE-1

Target: an authenticated local API can create a deterministic placement rule, validate and preview it, and manage its lifecycle/health without changing a bookmark, running a model or depending on a frontend.

| Merge unit | Work packets, in order | Concrete output |
|---|---|---|
| 1. Freeze the backend slice | AW-01, AW-03 | Actual checkout facts, auth/error/migration/OpenAPI conventions, finite rule profile and fixture vocabulary |
| 2. Pure shared core | AW-04 → AW-05 → AW-06 → AW-07 | Optional automation package subpath, normalization/digests, bounded predicates, placement arbitration and task-graph validation |
| 3. Persistence and bindings | AW-09 → AW-08 | M1 migrations, backup/export coverage, immutable rules/bindings and dependency index using canonical folder identities |
| 4. Product services without a screen | AW-10 → AW-11 | CRUD, supplied/current-state preview, exact-preview activation, pause and dependency-health APIs with tests |

AW-09 can begin after AW-04, and AW-08 after AW-05 plus AW-09; their completion need not wait for all evaluator work if separate files are owned. Keep shared schema and manifest changes serialized. These merge units are smaller reviewable PRs, not one ten-packet commit.

Do not put AW-02 on BE-1's critical path. A disposable Events fixture can be explored after AW-01, but live-host availability, public HTTPS and callback setup cannot hold up deterministic backend work. This does not remove the later hosted compatibility gate.

## 2. BE-1 acceptance boundary

Use examples/m1-placement.json, m1-bindings.json, m1-rule-create.json and m1-preview-current-state.json. The rule has tasks=[], no executionPolicyId, no target and no model credential.

Through authenticated API integration tests, demonstrate draft creation; deterministic matching and conflict reporting; preview with no effects; enable rejection without an exact unexpired preview; invalidation after a semantic rule/binding edit; lifecycle/pause persistence; and a clear blocked/unavailable state when the runtime composition is not installed. Current-state preview uses the existing canonical read path, not an unimplemented historical-facts store.

Verify URL-prefix boundary cases, missing fields, unsupported profiles and the eight-task graph bound. Prove canonical folder identity survives a rename and cannot bind to a same-name replacement. Validate authority, If-Match, command idempotency and the repository's real auth/CSRF conventions. Test fresh install and upgrade from the actual migration head, plus restored pause state and secret-free export.

No bookmark move, ready worker job, Events subscription, model call or claimed browser behavior belongs to this batch. A desired enabled setting does not mean the execution engine is already active. Keep the runtime feature unavailable until BE-2 passes.

Backend source areas are packages/node/src/automation, packages/server, server contract/build artifacts, tests and required deployment scripts. Do not modify packages/web or Known-Extension. A future UI's request/response types are backend contracts; rendering, generated frontend clients, menus, labels, badges and interactive approval screens are frontend work.

## 3. Second batch: BE-2 — useful durable M1 backend

After BE-1, implement AW-13 → AW-14 → AW-15 → AW-16 → AW-17, then AW-51 → AW-33, with AW-18 independently ready after its configuration dependencies; close AW-66 last.

This adds committed facts, durable ordered ingestion, idempotent admission, runs/effect history, canonical device-receipt verification, server-intake placement, explanation, conservative single-effect Undo and backend bundle distribution. Native browser code is still deferred. Exercise canonical Sync/device fixtures at the transport boundary without calling them real browser evidence.

The acceptance narrative is: an eligible default-root bookmark is created through the canonical API; the matching rule places it in the bound Academic directory; one canonical effect and explanation are recorded; retry/restart does not move it twice; a newer manual move blocks a stale effect/Undo; pause/resume does not accidentally process the skipped interval. No agents, M2 policy tables or Events are needed.

AW-66 is the independent backend gate. AW-63 remains the full M1 product/browser gate and is deliberately not a prerequisite for backend progress.

## 4. Third batch: BE-3 — local polling worker

Implement AW-22, AW-23, AW-24, AW-25, AW-26, AW-30, AW-31, AW-32, AW-55 and AW-64, following tasks.json dependencies. The target/profile branch and the job/plan branch can proceed in parallel after their shared contracts are frozen.

Prove worker-only bootstrap → queue list → claim → allowlisted inputs → heartbeat → typed proposal → existing approval or Trusted plan → committed effect → recovery by the same plan identity. Use injected deterministic typed output for the first integration proof; a model key is not needed to verify orchestration. A real model test is additional evidence, not a substitute for the crash/idempotency suite.

Reuse existing approved credential/session mechanisms; do not add test-only production auth bypasses. Owner configuration and approval APIs can be exercised without building an Agents page. AW-64 depends on neither AW-29 nor any UI/host task. Job/budget telemetry is useful before delivery telemetry exists; unsupported delivery is reported as unavailable.

## 5. Fourth batch: BE-4 — hosted Events

Complete AW-02, AW-27, AW-28, AW-29, AW-44 and AW-46. Preserve the selected OpenAI webhook profile, independently verify the two network directions, callback challenge/signing, TTL/refresh/revocation, out-of-order/duplicate delivery and queue reconciliation. Separate protocol-fixture evidence from an actual Work/dot lifecycle.

This scheduling choice does not change Events from the preferred hosted wake mode. It proves the durable job engine first so that a provider callback or account issue cannot be confused with a rule/job/plan bug. Availability or identity limitations are explicit blockers for that host profile only.

## 6. Fifth batch and deferred work

BE-5 covers AW-41, AW-57 and AW-58: immutable run-once preview/start, exact count-batch aggregation and persisted run-level output/unread state. Templates, broadcast, CEL and extra executors retain their original later milestones; do not use them to enlarge BE-1.

All Web and extension implementation packets are deferred on this local backend path. That includes browser-only runtime integration even where it is not itself UI. Backend device APIs/fixtures are not deferred, because they define the eventual consumer boundary.

## 7. Copyable initial implementation brief

> Implement BE-1 only: AW-01, AW-03, AW-04, AW-05, AW-06, AW-07, AW-09, AW-08, AW-10 and AW-11, respecting the dependency graph and separate merge units above. Use the uploaded revised direction plus this reviewed contract. Treat shared-core as part of backend delivery. Do not change packages/web or Known-Extension and do not implement UI, hosted dot setup, Events delivery, model execution, batches or templates. Do not publish npm or rebase user work merely to begin; validate the local package/export surface. Start by verifying the current checkout's auth, error, OpenAPI and migration conventions. Use tasks=[] with no policy/target for M1, and supplied/current-state preview without historical ingestion. No actual bookmark effects until the durable M1 runtime is separately implemented and accepted. Deliver actual unit/API/database evidence, positive/negative fixtures and a bounded handoff for the later frontend. Never report a proposed test or mock host interaction as executed production behavior.
