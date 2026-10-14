# BE-1 self-review and corrections

Review starting point: `07ce22d`, worktree `feat/automation-be1`. The basis is still the reviewed pack
`0.2.1-design` and the actual repository implementation. This record corrects the overly strong conclusion
"no known unfinished implementation items" in the AW-11 delivery record; the original record is kept as the
execution evidence of that time and must not be read as proof that no defects exist.

## Findings and handling

| ID | Level | Original problem and impact | Fix location / regression evidence |
| --- | --- | --- | --- |
| R1 | P1 | Competing rules only evaluated the predicate, without applying their own folder scope, import policy and hop limit, producing false conflicts or wrong priority results. | `application/rule-eligibility.ts` unifies the eligibility check; `preview-service.ts` shares it between the main and competing rules. Three scenarios in the parameterized API test failed before the fix; a trigger-type scenario is also kept. |
| R2 | P1 | When a competitor's folder was unavailable the preview showed no conflict, and after the folder recovered the old preview could still enable; the digest did not pin the competitors' live dependency state. | Competing rules, resolution state and evaluators are prepared once; the digest pins folder identity, ancestry and permission revisions. After recovery the old preview returns 409 and a fresh preview reports conflict. |
| R3 | P1 | When the specified scope role had no binding, currentState sampled with an empty folderId, widening the scope to the whole explicit collection. | Scope resolution is checked before sampling; returns `automation_binding_unavailable` without widening. Before the fix the API returned 200. |
| R4 | P2 | Any role failure blocked intake, including optional folders no stage used. | Stage dependencies include scope/intake and transitive mustBeWithinRole constraints; unused optional dependencies only warn, blockingStages=[]. Validation, preview, enable and health share the semantics. |
| R5 | P2 | The evaluator normalized the host, but normalizedDefinition and semanticDigest used the raw value; equivalent rules had different digests. | The compiler exports an isolated normalizedPredicate; normalization, digest, create/replace/preview/enable use one logic. Covers case, trailing dot, IDNA, caller mutation, display labels and real semantic changes. |
| R6 | P2 / contract drift | A self-imposed overall 4096-byte limit on the finite DSL rejected expressions valid under the reviewed Schema; the old test merely pinned the self-imposed behaviour. | Removed the overall limit, kept depth 16, 128 nodes and field Schema limits; HTTP requests remain bounded by 4 MiB, capabilities synced. CEL's separate 4096-character Schema is unchanged; CEL remains unavailable on this host. |
| R7 | P2 | "Immutable revisions" only forbade UPDATE; old revisions could be DELETEd directly, breaking history retention. | Added `202610300300_automation_revision_delete_guard.ts`, keeping committed migrations; verified that deleting old revisions fails while deleting unreferenced binding sets and account cascade succeed. |
| R8 | P2 | currentState silently truncated ancestor chains deeper than 128 levels and returned success with truncated=false, possibly misjudging subtree scope. | Over-limit, cyclic and incomplete ancestor chains explicitly return 409; a 129-level folder chain is built through real canonical writes. Before the fix the scenario returned 200. |

All reproduced R1–R8 problems are fixed. The preview digest also adds the fact fields hopCount, changedFields and before,
so the fields checked and the fields pinned by the digest no longer differ; it excludes the current collection ordinal,
synthetic operationId and time fields unrelated to fact content, so a folder rename alone does not cause unrelated invalidation.

## Code quality

* Removed the two separate eligibility logics for main and competing rules, so a future policy change cannot fix only one of them.
* `parseContract` uses the generated `AutomationContracts[Name]` return type instead of letting callers pick an
  arbitrary generic type unrelated to the Schema.
* The raw evaluator became package-internal; the public evaluation entry is `evaluate` on a successful compilePredicate result.
  This prevents callers from bypassing Schema, operator and depth/node checks. The optional subpath had not been published,
  and nothing in the repository consumed the raw evaluator directly; the public entry docs and the local consumer package were updated.
* The normalized copy and the evaluator closure are isolated; mutating the input or normalizedPredicate does not change evaluation.
* Persistence constraints were corrected by an additional migration, without rewriting committed migrations or historical JSON revisions.
* File sizes stay within existing budgets; module, infrastructure and transport dependency-boundary checks pass.
* Maintainability costs remain: some files execute several steps per line, and the generated OpenAPI/Schema and reviewed-pack mirrors are large.
  This round only extracted genuinely duplicated eligibility logic; no repository-wide formatting or framework replacement.

## Test quality

New tests first reproduced the problems and were then used to verify the fixes. Initially the core byte-cap test failed and the
first API run had 8 failures; then deletion of old revisions succeeding and silent truncation of deep ancestor chains were reproduced
independently. These failures were not hidden as "all passing".

New API assertions cover externally observable outcomes, status codes, error codes, normalized output, digests and lifecycle,
not just internal helpers. The folder-depth scenario uses real canonical writes; the SQL soft-delete/restore in the folder-recovery
scenario only isolates the test fixture and does not claim to implement canonical Restore or BE-2 Undo.

The revision-deletion test creates its own configuration; shared prerequisite data for the persistence and binding tests moved to
beforeAll, reducing dependence on a previous test when filtering by test name. The health test file still chains lifecycle scenarios
through a shared fixture; it is not randomized-order isolated. The pool-connection read in the backup test only proves the SQL state is
retained; the comment "simulated process restart" was corrected; no full deployment stack was actually started or restarted.

Two fixture errors occurred while writing the new tests: the filtered revision test missed prerequisite configuration, and a copied
node included a generated column. Both fixtures were fixed before reproducing the real defect; these fixture failures do not count as
product-defect evidence.

## Final verification actually run

The root is the worktree; commands with a package directory were run from that cwd. Checks not run do not count as passed.

| Command | cwd | Result |
| --- | --- | --- |
| `npm run check:automation && npm run typecheck && npm run check:source-size && npm test -- tests/automation` | packages/node | Passed; 5 files, 19 tests, 271 source files within budget. |
| `node packages/server/scripts/refresh-automation-package.mjs` | root | Passed; build/npm pack, local dependency install, both lockfiles and runtime manifest updated. |
| `npm run pack:consumer-smoke` | packages/node | Passed; 20 ESM/CJS subpaths, JSON Schema, 9 doc examples and isolated consumer compile/run. |
| `npm run test:integration:file -- tests/integration/automation` | packages/server | Passed; 4 files, 34 tests on real PostgreSQL, including fresh install, old baseline to the BE-1 migration head plus the corrective migration, constraints, export and pg_dump/pg_restore. |
| `npm run test:unit -- tests/unit/automation tests/unit/product/product-error-codes.test.ts tests/unit/product/product-route-manifest.test.ts` | packages/server | Passed; 4 files, 17 tests. |
| `npm run test:system:inner -- tests/unit/ci/import-dependency-graph.test.ts` | packages/server | Passed; 23 tests. |
| `npm run typecheck && npm run build` | packages/server | Passed; production TypeScript and all migrations build. |
| `npm exec eslint -- src/modules/automation src/infrastructure/automation src/transport/product/automation-rule-routes.ts migrations/202610300300_automation_revision_delete_guard.ts tests/integration/automation` | packages/server | Passed. |
| `npm run openapi:ci` | packages/server | Passed; mirror, lint, catalog, examples, generation drift, 1.95.0 baseline compatibility. |
| `npm run check:imports` | packages/server | Passed. |
| `npm run check:migrations -- 07ce22d` | packages/server | Passed; the corrective migration sorts after the original BE-1 migration head. |
| `npm run runtime:manifest:check` | packages/server | Passed. |
| `npm ci --omit=dev --omit=peer --ignore-scripts --no-audit --no-fund --prefix runtime` | packages/server | Passed; 174 production packages; importing the local package from runtime and checking normalizedPredicate=arxiv.org passed. |
| `git diff --check` | root | Passed. |

After the final fix the applicable checks were run, not a repository-wide npm check, repository-wide coverage, mutation tests or online verification.
The test that executes the browser-target bundle in Node only proves it bundles and matches golden results; it does not prove real
Chrome/MV3 CSP compatibility. Ajv runtime compilation involves dynamic code generation and must be resolved and verified before AW-49 consumes it.

## Scope-drift review

* Confirmed and corrected contract drift: the extra 4096-byte overall limit on the finite DSL.
* The existing additive APIs (GET pause, archive DELETE, deleting unreferenced binding sets) are supplements required to close the BE-1
  configuration loop and are explained in the ADR/README; they are not UI or business execution.
* Runtime tables, activation fences and the health recheck on the existing Outbox belong to the AW-09/AW-10/AW-11 persistence and extension
  contracts. No facts producer, business admission, task claim, execution/commit or effect-receipt producer was installed.
* The worker.ts change only hooks up the health recheck; it is not the BE-3 polling worker. MCP/future-batch files in the reviewed directory are
  verbatim reference documents, not implemented capability.
* Relative to e72b891, packages/web and packages/extension are unchanged; no UI E2E, model calls, real archiving, Undo, Webhook/dot/Work or MCP
  Events implementation. Nothing extended into BE-2/3/4.

## Remaining risk and conclusion

No unfixed reproduced P1/P2 functional defect was found; that does not mean there are no defects. The following evidence is still missing:

1. The account-level FOR UPDATE serializes one user's configuration queries/previews; sampling ancestor chains and resolving competing rules take
   several queries. Quantity bounds exist, but no multi-user or deep-tree load test was done; no performance target is claimed.
2. The health recheck wraps the existing durable projection sink, so its exceptions affect that projection's retry completion; no fault injection
   verified commit-before-reply, database exceptions, partial start-up failure or fault isolation between rules.
3. Real browser/MV3 CSP, real deployment recovery and process restart were not executed. The first is the AW-49 release gate; the other two need
   deployment acceptance; isolated-schema recovery and SQL persistence evidence cannot replace them.
4. This is not an independent third-party audit, and neither new-code coverage nor mutation score was measured.

The BE-1 headless loop and the contracts affected here pass real regression, providing the code and data foundation to continue with BE-2.
The earlier "fully accepted, no known problems" should be read as the conclusion with the explicit boundaries above; fault injection, load and
deployment-recovery verification should be added before real execution ships. The missing executor is the agreed state of this batch; an enabled
configuration must not be read as automation actually running.

## Correction commits and worktree

Committed separately under the original authorization: AW-06 `bb571f0`, AW-05 `e08da1e`, AW-04 `0e28700`,
AW-09 `dd0106a`, AW-08 `13fcd0c`, AW-11 `327ae7d`, AW-10 `fae1edc`.
This record and the complete file list are committed separately as AW-01 review evidence; nothing was pushed.
The complete BE-1 file list is in [be1-files.txt](be1-files.txt); this round's changes can be compared with `07ce22d..HEAD`.
Test containers are reclaimed by the with-postgres wrapper; no dev server was started or left running for this task.

## Six corrections after the independent re-review (based on 60fe77f)

The independent re-review used `~/ref/colp-automation-design` as its basis and confirmed it matches the design snapshot in the repository.
The existing related tests passed, but seven temporary reproduction cases exposed six P2 problems (the ancestor index was verified both by query
and by a real canonical move / Outbox). They were fixed together and committed; the evidence below supplements the text above, and
the earlier "no reproduced problems found" is not treated as a guarantee of current correctness.

| Problem | Fix and regression |
| --- | --- |
| Long canonical node IDs exceeded the 128-character facts/response limit once prefixed | current-state generates a stable synthetic ID from a digest of the server/collection/node identity. Verified with two 128-character IDs differing only in the last character, response and persisted-result Schema, repeated preview and activation. |
| The initial scopeChanged binding did not index the real ancestors, so it could not recover through ancestor events | A blocked result can carry a live snapshot from an authorized read, and the index keeps updating its physical ancestors; the snapshot is only for monitoring and the state stays blocked. A real move first to another disallowed folder and then back into the allowed subtree verifies the block clears without a manual health query. |
| A higher-priority rule with a different destination winning was still counted as a hit for the current rule | The current rule's preview reports conflict, the winning rule and destination, does not claim root satisfaction and is not counted in plannedRunCount. Verified lower-priority competitors, same-destination compatibility and rejection of conflicting activation. The shared arbiter still picks the winner by priority. |
| node.created unconditionally excluded every automation origin | BE-1's intake stage rejects automation re-entry from the same intake stage and allows creation events from other stages; trigger, restore/import policy and hop limit are still checked. This is a supplied-facts preview and does not claim BE-2 causation production or admission. |
| Rename/move notifications were cleared automatically by an ordinary revalidation | Unacknowledged change notifications persist until acknowledged or replaced by a new notification of the same role and category; duplicate Outbox deliveries and health/dependencies queries do not clear them. Blocking warnings still need a live revalidation to recover; acknowledging does not repair a failed dependency. |
| A deleted unused optional dependency still returned valid | The dependency interface uses this binding resolution directly instead of deriving resource validity from blockingStages. Verified deletion, acknowledgement and recovery; the optional dependency stays a warning with blockingStages=[], and rule validation stays valid. |

The scenario in the parameterized competitor test that could not isolate the trigger was removed (it also deleted intake, so it would not
participate in placement even if trigger filtering failed). The replacement case checks the positive and negative node.created preview results
directly and covers different automation stages, same-stage re-entry and the hop boundary. The shared API preview helper now validates the complete
PreviewResult, so a response Schema violation is not missed by looking only at the outcome.

Verification actually run after these fixes (cwd `packages/server`):

* `npm run test:integration:file -- tests/integration/automation/api.integration.test.ts tests/integration/automation/health.integration.test.ts tests/integration/automation/bindings.integration.test.ts`: real PostgreSQL, 3 files, 36 tests all passed.
* `npm run typecheck`: passed.
* `npm exec eslint -- src/modules/automation src/infrastructure/automation tests/integration/automation`: passed.
* `npm run check:imports` and `npm run build`: passed.
* `git diff --check` at the root: passed.

Public Schema, the shared package, migrations, Web and Extension were not changed, so unrelated tests and release checks were not re-run.
The existing evidence limits for browser, load, fault injection and full deployment recovery still apply. Test containers were reclaimed by the wrapper.

## Foundation semantics re-review corrections (based on 39e15f4)

The second re-review found six implementation/contract problems and an ordering dependence in the health tests. In particular, after the previous
round mapped a higher-priority override to a wire conflict, it kept the rule "every conflict forbids activation", so enable order decided whether
the same rule set could coexist; the original regression test wrongly pinned this 409 as expected. This section and the evaluation-semantics notes in
ADR-BE1 supersede the previous section's statement that a higher-priority override rejects activation.

Completed together:

* Extracted pure rule evaluation and wire mapping. Internally a definite higher-priority override is distinguished from an unresolved equal-priority
  conflict; preview and activation consume the same configuration/fact snapshot and evaluation semantics. A higher-priority override does not block
  activation; equal priority with different destinations is still rejected.
* Shared arbitration requires an explicit PlacementIntent; JavaScript calls that omit it also go to review. The arbitration result only describes
  placement and no longer claims root satisfaction automatically; a successful placement generates markers from the intake.satisfies declaration,
  an empty declaration stays empty, and keeping the original location produces neither markers nor a planned run.
* A unified BindingAssessment gives validate, preview, enable and health the same stage-dependency judgement. A missing unused required role is a
  warning; only consumed roles and their transitive constraints block intake. When role consumption changes, the database severity column and the
  incident JSON are updated together.
* The shared role graph resolves in dependency order and rejects self-cycles, multi-role cycles and missing/wrong-type ancestors; all six declaration
  orders of three roles give the same result. Historically invalid graphs stay readable and repairable, and health resolution returns blocked.
* Preview uses versioned per-member digests that are then aggregated, keeping the shared JSON guards. A port fixture verifies 200 facts each with
  128 ancestors, 499 deep competing rules, and that changing the last member/ancestor/competitor changes the digest. These cases verify composition
  capacity and fixed inputs; they do not replace a real deep-tree load test.
* The health tests use an independent PostgreSQL schema, account, canonical tree, rules and metrics per case, keeping the full lifecycle within one
  test; the same-named replacement fixture no longer depends on another test renaming first.

Verification run:

| Command | cwd | Result |
| --- | --- | --- |
| `npm test -- tests/automation` | packages/node | 6 files, 22 tests passed. |
| `npm run typecheck && npm run check:source-size` | packages/node | Passed, 272 source files checked. |
| `node packages/server/scripts/refresh-automation-package.mjs` | root | Shared package build/pack, local install and both lockfiles refreshed, including final docs. |
| `npm run pack:consumer-smoke` | packages/node | 20 ESM/CJS entries and 9 packed doc examples passed. |
| `npm run test:unit -- tests/unit/automation` | packages/server | 3 files, 5 tests passed. |
| `npm run test:integration:file -- tests/integration/automation` | packages/server | Main fix regression: 4 files, 49 tests passed. |
| `npm run test:integration:file -- tests/integration/automation/api.integration.test.ts -t 'maximum competitor\|cyclic role'` | packages/server | The 2 boundary tests added afterwards passed; 33 were not run due to the name filter. |
| `npm run test:integration:file -- tests/integration/automation/health.integration.test.ts --sequence.shuffle.tests --sequence.seed=7` | packages/server | All 9 tests passed; same random seed as the re-review's 4 failed / 5 passed, including the final severity-sync assertion. |
| `npm run typecheck` and ESLint over automation source/tests | packages/server | Final code passed. |
| `npm run check:imports`, `npm run build`, `npm run openapi:ci` | packages/server | Passed. |
| `npm run runtime:manifest:check` | packages/server | Final production manifest/lock check passed. |

The public JSON Schema keeps its shape; the experimental function signatures and return types of the shared package are synced to the package docs
and the local consumer package. The original design snapshot was not rewritten; semantic notes are collected in ADR-BE1. BE-2 execution, a real
browser, deployment recovery and load verification remain separate gates.
