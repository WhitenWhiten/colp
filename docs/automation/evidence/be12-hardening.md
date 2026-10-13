# BE-1 / BE-2 hardening and package handoff

Date: 2026-10-13. Implementation semantics and remaining product boundaries are in
[BE12-HARDENING.md](../BE12-HARDENING.md). This report records observed execution,
not merely the presence of tests.

## Source, package and CI failure

The hardening source was tested at `fc9566f682c0822630283bbd1ad3aaaa22299180`.
The initial normal CI run [38382226128](https://github.com/WhitenWhiten/colp/actions/runs/38382226128)
installed the previous vendored package. Its server typecheck failed because the
installed Automation entry lacked `preparePredicateInput`, `PreparedPredicateInput`
and the `EvaluationOptions.inputSnapshot` member. Extension E2E loading failed for
the same missing runtime export; its subsequent "No tests found" message was not
a test-discovery defect. These failures must not be hidden by skipping tests or
aliasing the server's dependency to sibling TypeScript source.

The read-only verification job in [run 38382226096](https://github.com/WhitenWhiten/colp/actions/runs/38382226096)
built the actual shared package, regenerated the server and runtime locks, and
validated the server with that package. Only after verification succeeded did a
separate job fast-forward the branch with the generated files. The resulting
package-pinning commit is `eb2dbaca7bcbf50d8885b3ad3a5b01f93ed1197d` and changes only
the vendor tarball and two lockfiles. It does not change the tested runtime source.

The temporary package-refresh workflow is removed at handoff. Regular CI continues
to test the committed package with frozen installs; CI must not silently repair
an uncommitted package drift or keep an automatic branch-writing delivery aid.

## Executed verification

Environment: GitHub Actions Ubuntu 24.04, Node 22.23.3, npm 10.9.9. The PostgreSQL
wrapper started Testcontainers PostgreSQL 16.4; integration tests ran under Xvfb.
These are remote CI results, not a claim that a separate local checkout ran them.

| Command / check | Observed result |
| --- | --- |
| `npm --prefix packages/node run check:automation` | Passed |
| `npm --prefix packages/node run typecheck` | Passed |
| `npm --prefix packages/node test -- tests/automation` | 8 files / 36 tests passed |
| `node packages/server/scripts/refresh-automation-package.mjs` | Actual ESM/CJS/declaration build, pack, vendor and locks succeeded |
| `npm --prefix packages/server run typecheck` | Passed with the rebuilt package |
| `npm --prefix packages/server run check:imports` | Passed |
| `npm --prefix packages/server run runtime:manifest:check` | Passed |
| `npm --prefix packages/server run test:unit -- tests/unit/automation` | 10 files / 24 tests passed |
| `xvfb-run -a npm --prefix packages/server run test:integration:file -- tests/integration/automation` | 22 files / 103 tests passed |

The 103 integration cases include canonical browser intake roots and selected-folder
rejection; waiting-quota concurrency, stale evidence reclamation and empty-source
recovery; UTC daily limits, immutable missing-input handling, holds/cancellation and
transaction rollback; forward migration backfill; two real durable consumers with
concurrent Sync/projection and replay; and a child worker killed with SIGKILL after
effect commit but before acknowledgment. Restart recorded no second canonical move.
The existing API/preview, authority, lease-replacement, backup/restore, late-receipt
and conservative Undo regressions also passed. Counts are suite totals, not sums
of overlapping retries or earlier evidence reports.

The verification artifact was `automation-package-fc9566f682c0822630283bbd1ad3aaaa22299180`
(ID `11804252847`). Its ZIP SHA-256 was
`6fef4d53454a83ceb9708ebf36de19d031580ee8e9f3bcbe4e90bfdd5c7f68a3`.
The artifact contained only the vendor tarball and the two package manifests/locks,
not repository credentials, environment files, database data or a dependency archive.
The durable record is the pinned Git commit; the temporary artifact can expire.

## Regression against future stale package delivery

`tests/unit/automation/packaged-core.test.ts` launches actual Node ESM and CommonJS
consumers from the server package directory. It checks the shipped export, shared
snapshot registry, immutable snapshot behavior, forged/cross-source handle rejection,
closed schema validation and bounded recursive parsing. A subprocess timeout can
terminate a synchronous parsing regression instead of hanging the Vitest process.
It deliberately does not replace the installed dependency with source aliases.

This additional handoff regression and the final normal CI run are separate from
the 24 unit / 103 integration counts above. Their results belong to the exact
handoff commit's GitHub checks. The focused package run did not execute server-wide
lint, OpenAPI compatibility or the full repository suites; it is not evidence that
all required PR checks passed.

## Preserved boundaries

No native browser runtime, Web UI, M2 model/policy/target system or production Events
adapter is claimed. The mixed-route regression is not a production load benchmark.
Offline device effects cannot be retroactively limited by a server admission quota;
immutable missing facts are retained or reviewed, never fabricated from live state.
The explicit-intent, canonical identity, current authority, revision, pause/hold and
conservative resource/collection-content Undo fences remain in force.
