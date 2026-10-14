# BE-03 review of the executed part

Review baseline `84e8239` (`feat/automation`), covering AW-22, 23, 24, 25, 26, 30 and 31 in `93f6d68..84e8239`.
The thermo-nuclear-code-quality-review standard was used to check structure, boundaries, state transitions, tests and semantics.
No remote PR was merged; BE-01/02 were not re-reviewed or refactored. The shared rule-service only corrects the
executionPolicyId replacement semantics introduced by BE-03, and runtime only adjusts the workerEnabled branch.

## Execution status

| Task | Existing commit | Conclusion |
| --- | --- | --- |
| AW-22 | eabf2c8 | Policy, budget and reuse identity implemented; fixed the cross-day budget and added policy pagination tests |
| AW-23 | 4bfd189 | claim/heartbeat/generation/uncertainty implemented; fixed run convergence after failure |
| AW-24 | f5c2d37 | Typed results and same-plan recovery implemented; fixed per-tag source validation, empty results and submissions before ready |
| AW-25 | ac79c62 | Reused approval, conservative Undo and read-only recovery implemented; related regressions pass |
| AW-26 | 5f9fbd2 | Real credential pairing and current revocation implemented; related regressions pass |
| AW-30 | 3bb4fd1 | Conditional tool catalog consistent with direct-call authorization implemented; related regressions pass |
| AW-31 | 84e8239 | Same-origin HTTP/MCP orchestration implemented; fixed input pinning, scheduling and state problems |
| AW-32 / AW-55 / AW-64 | none | Not executed; this review is not the delivery of the polling adapter, usage read model or full backend E2E |

The design pack's tasks.json is a proposed plan, not runtime evidence; this round adds a scoped status.md linking the actual commits and evidence.
Because the last three items were not executed, BE-03 cannot be claimed complete as a whole.

## Fixes and structural adjustments

| Priority | Original problem | Fix and verification |
| --- | --- | --- |
| P1 | Intake admission's `placed` plan was treated as success evidence; a destination invalidated after admission still marked root classification succeeded | Requires passing the current source revision, live binding and actual parent checks together; the fault-injection counterexample first produced succeeded, after the fix blocked with no effect |
| P1 | After a permanent failure the run stayed running and dependent tasks stayed pending; when every optional task was blocked by policy, intake completion could make the run show completed | The scheduler converges the run by terminal states and explicitly blocks failed dependencies; failure, budget and stale entry points trigger convergence; independent tasks keep progressing |
| P1 | When no note existed at pinning time, a note added later was not in the old revision map, so the old job could still be claimed | Initial pinning and the current check share the same complete note-set query; additions, deletions and revision changes make the input stale; multiple notes are explicitly blocked |
| P1 | A job's historical reservation permanently bypassed the daily quota; reserved yesterday and retried today did not compete for today's cap | The reservation key became `(job_id, day)`; query, insert and count use the same transaction's UTC date; old-day records are kept; the cross-day counterexample reproduced first, then passed |
| P1 | PUT replacing a worker rule without executionPolicyId kept the previous grant when expanding the old view | Building the new view first drops the old policy, then applies the new complete input; verified neither the response nor the persisted read keeps the old policy |
| P2 | The first batch of 100 held/awaiting-approval runs could repeatedly consume the scan budget, so later pending work never progressed | The scan first excludes held/cancelled/current-collection-unavailable/non-advanceable busy runs and only recovers consumed plans; uses target_partition for the existing index; the stress boundary of 101 non-advanceable runs still lists the real work behind them |
| P2 | Each tag's sources were validated together, so one sourced tag could mask another with only model evidence; a valid empty add could not be submitted | Each added tag validates pinned sources independently; an empty add saves an accepted typed result with no fabricated canonical mutation and can feed successor tasks |
| P2 | For pending/blocked jobs without input_json, an early submission could trigger null.map / 500; task reads did not consistently use the full job authority | Checks the current Owner/target/privacy/run through lockWorkJob before reading pins; missing ready pins return an explicit 409, covered by an HTTP counterexample |

The scheduler dropped recursive re-entry in favour of a loop bounded by the declared task count, each step consuming one pending task or returning.
Allowlisted input preparation moved into task-inputs, which validates the TaskInput schema and size limits in one place; the note query is no longer
written separately in the pinning and validation paths. The worker command became a discriminated union parsed once per command, removing duplicate
parsing and the wrong type relation that cast the heartbeat body to Lease. No general workflow framework was introduced.
Hand-written new/refactored modules are all well under 1,000 lines; the generated OpenAPI/Node/vendor files were not changed in this round.

## Test quality and actual execution

All PostgreSQL tests ran under xvfb + Testcontainers PostgreSQL 16.4. They use the real Owner API, child-key/token exchange, canonical mutation and the
Plan/Approval ledger; storage state is injected explicitly only at fault/backlog boundaries. No successful mock dispatcher stands in for the business loop.

Counterexample phase:

- 5 new filtered cases: 3 failed, 2 passed, actually reproducing run non-convergence, false intake success and missed note-set changes; policy microsecond pagination was already correct and its coverage is kept.
- After the first fix round, 11 worker-pipeline cases passed; the new cross-day counterexample in the policy suite still failed, confirming yesterday's reservation bypassed today's cap.
- The follow-up fixed the cross-day budget and verified one job can keep reservations for two days while repeated calls on the same day keep a single reservation.

Full related regression command:

```sh
xvfb-run -a npm --prefix packages/server run test:integration:file -- \
  tests/integration/automation/execution-policy.integration.test.ts \
  tests/integration/automation/job-leases.integration.test.ts \
  tests/integration/automation/typed-results.integration.test.ts \
  tests/integration/automation/approval-undo.integration.test.ts \
  tests/integration/automation/targets-pairing.integration.test.ts \
  tests/integration/automation/tool-catalog.integration.test.ts \
  tests/integration/automation/worker-pipeline.integration.test.ts
```

7 files, 41 cases passed. The later rule-policy clearing and empty-tags flows were run directly:

```sh
xvfb-run -a npm --prefix packages/server run test:integration:file -- \
  tests/integration/automation/worker-pipeline.integration.test.ts -t 'replacing a worker|empty sourced'
```

2 passed, 12 skipped by the name filter. The pure execution-policy/reuse-identity logic tests moved from the integration beforeEach's real database
initialization into unit tests; there is no need to start a database and run migrations for a pure function.
The two unit files `execution-policy.test.ts` and `typed-output-evidence.test.ts` passed 4 cases.
These rounds overlap and are not added up to inflate distinct test counts; during the full regression the pure policy cases were still in the old integration file.

Finally the same collection current-Owner/liveness boundary moved forward into the candidate scan, and the backlog counterexample was strengthened to
50 held + 51 collection-unavailable runs; the same xvfb integration command selecting the worker-pipeline file with `-t 'unavailable-collection backlog'`
passed 1 case with 13 filtered.

Static verification: server typecheck, ESLint on changed files, check:imports, check:migrations -- 84e8239, server build, git diff --check.
The contract was not changed, so unrelated OpenAPI/frontend/BE-01/02 suites were not repeated.

## Migration and boundaries

New migration `202610301500_automation_daily_reservations.ts`, after the actual head. The upgrade only changes the reservation unique constraint and
does not delete history. If one job already has records for several days, down refuses to restore the old single-column key rather than silently
dropping audit history; deployments should use the forward migration.

This round did not implement AW-32/55/64, Events, CEL, batch, broadcast, UI or real provider calls. The existing verification of the fifteen MCP tools is
still the application facade + PostgreSQL and cannot replace AW-64's full network and worker-restart acceptance. Conclusions about dynamic authorization,
approval/Undo and crash recovery are limited to the real executed tests above. Every app/temporary PostgreSQL started in this round is reclaimed by the
fixture/wrapper; no background service is kept.

## Independent re-review and fixes after AW-32/55/64

Baseline `1db76fe`, worktree `feat/colp-automation`. This round first independently verified the existing gates: BE-01 API / BE-02 M1 backend 36 cases,
AW-64 / usage read model 11 cases and reference-worker transport 7 cases passed. Then six real PostgreSQL counterexamples all failed, confirming the
defects below; passing the existing happy-path gates was not accepted in place of state-convergence verification.

| Original problem | Fixed behaviour |
| --- | --- |
| The preview of a matching event with an explicitly chosen folder showed 0 runs while a summary task was actually produced; pendingTasks was always empty | Preview and admission share the runnable-run judgement; enrichment is still listed when the folder is kept, with a worker-unavailable diagnostic |
| Daily quota exhaustion and permanent maxCalls shared terminal blocked, so work could not be claimed after the day rolled over | daily/calls are distinguished explicitly and the UTC resume time is persisted; polling restores the original input, rechecks the source and the day's quota, and successors stay pending while waiting |
| A claimed task submitting stale input returned 409 but stayed leased and was later wrongly recorded as unknownOutcome | After verifying the real lease/digest the typed output/attempt is kept, the contract's existing stale status and diagnostic are returned and the run converges; no Plan/effect is created |
| A collection revision change after approval caused a 500 and waiting forever | Becomes a durable stale; an expired/cancelled original Plan becomes review; an unknown commit failure keeps the same Plan and returns a retryable error without re-planning |
| After the Owner rejected the last proposal the run stayed running | Tasks/run converge inside the rejection transaction, independent of the original worker resubmitting |
| A global pause rejected heartbeat/result for running tasks, so generated output could not be kept | The currently claimed task may renew and save output; effects stay behind the pause commit guard, and after resuming only the same proposal advances |

`202610301700_automation_budget_holds.ts` was appended after the existing migrations. It distinguishes old budget blocks by the recorded attempt count and
the pinned maxCalls; recovery does not change immutable pins and does not revive cancelled/held runs. The budget read model uses structured reasons and no
longer depends on English explanation strings.

The temporary counterexamples became three formal integration suites: `submission-lifecycle`, `daily-budget-recovery` and `worker-preview`. The AW-64 manual
edit case now completes the call through the actual reference worker and asserts the stale status, no effect and journal cleanup; asserting only the error
code no longer counts as state-convergence evidence. Added: lease expiry/recovery after a paused save, replay of the original command, expired approval,
daily recovery not resetting maxCalls, manual edits while waiting and successor retention. HTTP 200/stale means an unadopted result was saved, not that an effect succeeded.

Actual verification environment: Node `v24.14.0`, PostgreSQL `16.4-alpine`; all integration tests started through xvfb. (The runtime image is Node 22; this
evidence was not repeated on Node 22.)

```sh
xvfb-run -a npm --prefix packages/server run test:integration:file -- \
  tests/integration/automation/submission-lifecycle.integration.test.ts \
  tests/integration/automation/daily-budget-recovery.integration.test.ts \
  tests/integration/automation/worker-preview.integration.test.ts \
  tests/integration/automation/end-to-end.integration.test.ts \
  tests/integration/automation/worker-pipeline.integration.test.ts \
  tests/integration/automation/usage-read-model.integration.test.ts \
  tests/integration/automation/execution-policy.integration.test.ts \
  tests/integration/automation/typed-results.integration.test.ts \
  tests/integration/automation/job-leases.integration.test.ts \
  tests/integration/automation/approval-undo.integration.test.ts
```

This round passed 54 cases with 1 fixture failure: the new expiry case directly changed an immutable Plan expiry, which the database correctly rejected.
It was corrected to age a proposal that had not yet generated a Plan at the real prepare/reconcile boundary; the same command selecting only
`submission-lifecycle.integration.test.ts -t 'expired staged proposal'` passed 1 case with 4 filtered. The immutable Plan constraint was kept; no trigger was disabled for the test.

Additional upgrade and BE-01/02 targeted regression:

```sh
xvfb-run -a npm --prefix packages/server run test:integration:file -- \
  tests/integration/automation/budget-hold-migration.integration.test.ts \
  tests/integration/automation/api.integration.test.ts \
  tests/integration/automation/m1-backend.integration.test.ts \
  -t 'upgrade releases|placement satisfies|priority .* reports|node.created preview|preview creates no|authorized configuration'
```

9 passed, 28 skipped by the name filter. The upgrade cases respectively restore an old daily-quota block and keep an exhausted maxCalls, verifying that input
digests and historical attempts are not lost. In total 64 distinct integration cases finally passed this round, not counting pre-fix baselines or repeated
runs. Four related unit files (12 cases) and reference-worker transport (7 cases) passed. Server build (including TypeScript and migration compilation), ESLint
on changed files, check:imports, check:migrations against `1db76fe` and git diff --check all passed. Published fields and enums were reused; the wire schema,
vendor package and unrelated frontend were not changed. All temporary test services were reclaimed.

## BE-01/02/03 joint review (baseline 70bf27f)

This round checked the implementation of the three batches against backend-batches.json, covering the shared predicate / configuration and preview,
canonical facts / admission / receipt / Undo, and polling / lease / typed result / Plan lifecycle. The main paths of all three batches are implemented;
existing passing records do not replace cross-stage counterexamples. The problems below were fixed directly.

| Priority | Problem and original behaviour | Fix and verification |
| --- | --- | --- |
| P1 | After a required folder moved out of allowedAncestor, a summary without folderRole could still be submitted and write an annotation | Scheduling and read/claim/submit/commit share the existing intake binding assessment; leased output is kept as review with no Plan/effect. The real canonical move + HTTP submission counterexample produced an annotation before the fix and no longer does |
| P1 | A placement conflict's preview showed 0 runs / no pending tasks, yet admission started a summary worker and bypassed the runnable admission quota | Only runnable admission initializes worker jobs; conflicts, overrides and blocks keep a review run. A counterexample with two real enabled rules confirms no worker job and no reservation |
| P2 | An enrichment run that kept the user's chosen folder bypassed the daily intake admission limit | The run joins the unified admission accounting; overflow stays waiting/pending and resumes with the original pins after the UTC rollover, always keeping the original folder |
| P2 | A supplied preview with imports=include trusted userDefault and declared it would move and satisfy classify.root, while the actual source adapter does not accept intake intent from that origin | The shared evaluator keeps the folder for import/automation/system origins; the include explanation no longer claims the import was excluded by policy. Three pure-logic counterexamples and an authenticated preview regression cover it |
| P2 | A missing execution policy still showed active in lifecycle and the Owner rule read | health reuses the worker configuration inspection and reports executorUnavailable per task; executable intake stays degraded, and a rule with only unavailable workers is blocked. Start-up and outbox health composition pass the current worker capability and credential verifier |
| P2 | 100 waiting runs could fill polling's candidate scan and block runnable runs behind them | The candidate query excludes waiting runs whose intake admission has not completed. The existing backlog test grew to 202 held / unavailable / waiting runs, verifying later work can still be fetched |
| P2 | The CLI's SIGINT/SIGTERM did not propagate to the adapter immediately and only cancelled HTTP; the provider could keep running | The cycle accepts and passes the same signal; heartbeat and adapter share the combined signal; after cancellation no new call starts and late output is not submitted, keeping the unknownOutcome recovery path |
| P2 | When a fixed journal.tmp already existed with mode 0644, writeFile's mode did not tighten permissions, exposing the claim secret with the journal after rename | Uses a unique temporary path with exclusive wx/0600 creation, syncs the file before atomic replacement, and removes the temporary file in finally; the regression keeps an old 0644 temporary file to reproduce the original problem |

On code quality, the fixes reuse the existing evaluation, quota, binding and configuration checks rather than copying rules into HTTP/MCP.
health's nested status ternaries became explicit branches; queue filtering happens at the SQL candidate stage, avoiding repeated scans of known
non-runnable records. No new framework, wire enum, schema or migration was added; historical outputs, effects that already happened and historical quotas were not rewritten.

On test quality, three PostgreSQL counterexamples were reproduced first, then a real two-rule conflict counterexample was added; all four failed before the fixes.
The three unit counterexamples for source intent and the three transport counterexamples for journal/cancellation also failed first, then passed.
Integration tests use real canonical mutation, the authenticated API, PostgreSQL and Plan, asserting final state, pins, no effects and cross-day recovery; only the
day-boundary and backlog fixtures adjust private scheduling tables directly. The cancellation-signal test is a unit test with an injected transport and does not
pose as a new process SIGTERM E2E. The journal verification is limited to process recovery and permissions and does not claim power-loss recovery.

Actual execution (Node 24.14.0, PostgreSQL 16.4-alpine, all integration tests under xvfb):

```sh
xvfb-run -a npm --prefix packages/server run test:integration:file -- \
  tests/integration/automation/worker-preview.integration.test.ts \
  tests/integration/automation/submission-lifecycle.integration.test.ts \
  tests/integration/automation/intake-policy.integration.test.ts

xvfb-run -a npm --prefix packages/server run test:integration:file -- \
  tests/integration/automation/worker-preview.integration.test.ts \
  tests/integration/automation/worker-pipeline.integration.test.ts \
  tests/integration/automation/api.integration.test.ts \
  -t 'conflicting placement previews|backlog cannot starve|real pairing|create binding|preview creates no|exact preview invalidates|competitors must honor'

npm --prefix packages/server run test:unit -- \
  tests/unit/automation/intake-admission-policy.test.ts \
  tests/unit/automation/preview-tasks.test.ts \
  tests/unit/automation/rule-evaluation.test.ts \
  tests/unit/automation/execution-policy.test.ts
node --test examples/worker-script/claim-and-summarize.test.mjs
```

The first group passed 15 cases (worker-preview had 3 at the time); the second passed 9 with 47 skipped by the name filter.
In total 24 distinct integration cases passed, not counting pre-fix counterexamples or repeated runs. The related 15 unit and 9 transport cases passed.
Server typecheck, server build, ESLint on changed TypeScript files, check:imports and git diff --check passed.
No repository-wide tests, browser E2E, external provider or hosted Events were run; the conclusions for the three batches are limited to the local backend implementation.
