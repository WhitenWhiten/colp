# PR #26 reliability validation

The PR retains the five reliability fixes: rollback before Problem mapping,
linear shared structured-data validation, stable Collection creation idempotency,
expected-state bootstrap Session writes, and Collection-scoped Replica commands.

## Follow-up corrections

- Build the competing Replica request immutably instead of assigning readonly
  Operation fields in the bootstrap regression.
- Observe the deliberately detached UnitOfWork test callback with
  `Promise.allSettled`, assert its rejection, and retain the no-writer assertion.
  Production rollback signals still reject the transaction callback.
- Migrate the older Publisher fixture to a stable creation scope and exclude
  allocated Collection/Root IDs from its request digest.
- Make the other three bootstrap fixtures enforce the expected active,
  instance-scoped, unbound Session condition in their serialized transactions.
- Include the extracted bootstrap guards in the executable Tier A coverage
  manifest and its documentation; add defensive shape and state equality cases.
- Preserve Publisher mutation ownership for the extracted media-type and shared
  structured-data helpers. No coverage, mutation or source-size floor was lowered.

## Verification

The complete `npm run check` passed at
`5a9746331ba86ade8b4f557e0f333e77ef805005`. The later report commit does not change
the protected package source. The repair commit is
`8235035410e9b95eca0de6a9a13710ec538bcc5d`.

| Check | Actual local result |
| --- | --- |
| Protocol assets, generated contracts, Requirement coverage, traceability | Passed |
| Typecheck | Passed; readonly Operation assignments repaired |
| Source size | 218 files; 23 existing shrinking-only exceptions |
| Process contracts | 2 files / 12 tests passed |
| Publisher coverage | 20 files / 551 tests; lines/statements 93.12%, branches 88.74%, functions 100% |
| Security coverage | 40 files / 754 tests; lines/statements 96.18%, branches 92.28%, functions 100% |
| Sync Core coverage | 87 files / 1,758 tests, no skips; lines/statements 97.05%, branches 94.17%, functions 100% |
| Complete owned Vitest evidence suite and aggregate coverage | Passed; lines/statements 96.19%, branches 92.78%, functions 99.66% |
| Build and public runtime identity | Passed for ESM/CJS and declarations |
| Pack checks | publint, attw, 18 ESM/CJS entry points, JSON Schema and packaged documentation consumers passed |
| Legacy MCP absence | 219 source files, 58 declarations and 158 tarball files scanned; passed |

Generated artifacts were produced by repository-owned commands:

```sh
xvfb-run -a npm run accept:mcp-2026-07-28-sdk
xvfb-run -a npm run refresh:evidence
xvfb-run -a npm run check
```

The MCP candidate and accepted record attest final source revision `5e4858557dae3408d887438cb6952272a22350f4`.
The generic certificate attests `42dd23ba05b7504d86b102b3fb81d96627ee9bca`
and verifies 191 requirements. `check:release-evidence:coverage` accepted all
seven profiles: core, publication, feed, publisher, sync, mcp-read and mcp-write.
Certificates and traceability were committed in separate generated-artifact
commits. No certificate was hand-edited. Mutation ownership was checked by
inspection and the package contracts; a full mutation-score run is not claimed.

E2E commands execute under `xvfb-run -a`. Temporary test hosts and consumer
directories are owned and closed by the repository runners.

## Host migration boundary

A repository-wide search finds no production caller of
`executePublisherCollectionCreate` or production implementation of
`SessionBootstrapUnitOfWork` / `SessionBootstrapSessionStore`; the visible
implementations are package test fixtures. The package tests validate coordinator
behavior and the in-memory contract, not an external database adapter.

An adopting host must bind both the idempotency tuple and request digest to a
stable authenticated instance/mount scope. Its bootstrap adapter must implement
atomic expected-state replacement and serialize by Session across processes and
Replica IDs, including concurrent termination. Real database race validation and
legacy idempotency-claim reconciliation remain host adoption requirements. No
database-concurrency or deployment-conformance result is claimed here.

PR #22 is closed because its security changes were already absorbed by main.
This PR preserves the later private-target policy and host planner support.

## GitHub CI limitation

The existing [PR #26 Actions job](https://github.com/WhitenWhiten/Know-N/actions/runs/37099266103/job/111135410487)
has no executed steps. Its check annotation states that account payments failed
or the spending limit must be increased. This is an account-level startup block,
not a failing test result. Local package gates passed; remote CI success is not
claimed. Keep the PR draft while required remote checks and host adoption
validation remain outstanding.
