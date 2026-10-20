# Current sync-audit coverage

The current gate is `server-sync-audit-coverage` in `colp-ci.yml`. It collects
V8 coverage from 17 current unit files and four real PostgreSQL files in one
Vitest run. The exact eleven owners and test files are in
`scripts/sync-audit-coverage-scope.mjs`. It is a bounded sync audit, not coverage
of the complete server. The six existing PostgreSQL shards still run unchanged.

Run collection and the gate with:

```sh
npm run test:coverage:sync-audit
npm run check:coverage:sync-audit
```

Collection uses `scripts/with-postgres.mjs --isolated-owner`; it requires a real
PostgreSQL container and fails if one cannot start. Each selected PG file uses
its existing isolated schema, current migrations, production SQL and real
test bodies. Unit coverage or skipped PG suites cannot satisfy the checker.
There is one combined V8 report, so no shard merge or addition of percentages
is involved.

Every owner must exist and appear in both `coverage-final.json` and
`coverage-summary.json`. Statements, branches, functions and lines each have
an independent per-file floor. Every selected test file must report one or
more passing tests, with no skipped, pending or failed tests. Missing files,
reports, metrics, owners or floors fail the gate.

The three new pure owners always require 80% on all four metrics. The eight
existing transaction owners use the explicit ratchet in
`scripts/sync-audit-coverage-baseline.json`. Zero, missing or unmeasured floors
are rejected; a failed test run cannot establish a baseline.

## First passing measurement

[Actions run 39447653980](https://github.com/WhitenWhiten/colp/actions/runs/39447653980)
ran the combined collector at commit
`b07a2b4dc345c82e9ca9666410fd822f89407b03` on 2026-10-20. All **21 selected
files and 255 tests passed** in 197.63 seconds, including all four real
PostgreSQL files. The temporary measurement workflow used the production/test
tree from `b9e8cf49421d6550980c0cbbcbcf05df946f7b1a`; its only additional file
was that workflow. The measurement workflow has since been removed. This
includes the empty-title Snapshot positive case with a bootstrap grant and its
negative control without that grant.

The collector step succeeded. Its checker step still failed on the deliberately
unset initial transaction floors. The following first floors are exactly the
reported per-file percentages from that passing test run, with no estimate or
downward adjustment. The ordinary PR coverage job must now collect and check
these committed floors; this measurement does not claim that a later PR head
has already passed its gate.

| Transaction owner (under `src/`) | Statements | Branches | Functions | Lines |
| --- | ---: | ---: | ---: | ---: |
| `modules/sync/sync-node-update.ts` | 87.64 | 85.47 | 100 | 94.85 |
| `modules/sync/sync-node-restore.ts` | 92.59 | 93.33 | 100 | 100 |
| `infrastructure/sync/sync-conflict-postgres.ts` | 85.56 | 82.11 | 93.54 | 91.09 |
| `infrastructure/sync/sync-conflict-resolution-postgres.ts` | 82.83 | 79.90 | 96.15 | 95.38 |
| `infrastructure/sync/product-sync-center-postgres.ts` | 89.54 | 87.41 | 92.30 | 94.11 |
| `infrastructure/sync/managed-ancestry-policy.ts` | 91.11 | 88.23 | 100 | 97.14 |
| `infrastructure/sync/sync-node-restore-postgres.ts` | 88.04 | 74.39 | 100 | 93.15 |
| `infrastructure/sync/postgres/sync-push-create-update-postgres.ts` | 84.03 | 66.98 | 93.33 | 88.57 |

The three pure owners retain their existing 80% floor for every metric. This is
a measured non-regression floor for the listed transaction paths, not a claim
that every transaction path has reached 80% branch coverage.

## Maintain the transaction ratchet

1. Run the collector in CI and inspect the uploaded `server-sync-audit-coverage`
   artifact. Keep `test-results.json`, both V8 reports and
   `audit-measurement.json` together. A failed test run is not a baseline.
2. Once all 21 selected files actually pass, inspect each transaction owner's
   four measured percentages. Add focused behavioral tests if a metric is zero.
3. Commit non-zero per-file floors no higher than the observed measurement,
   recording the actual 40-character measured commit and Actions run URL.
   A subsequent passing run is required to close the initial gate. Do not
   substitute historical phase floors or local unit-only measurements.
4. Raise floors when coverage improves. Lowering an established floor requires
   a specific reviewed explanation; the collector does not auto-update floors.

CI always runs the checker and uploads available reports, including on a test
or threshold failure. `ci-gate` depends on the new job. The JSON measurement
identifies the source commit/run and coverage-summary digest so the ratchet can
be reviewed against the actual artifacts.

## Compatibility names

The old `test:focused-coverage`, `test:focused-coverage:inner` and
`ci:focused-coverage` npm names alias this current collector/gate. The old
`vitest.coverage.config.ts`, `vitest.focused-coverage.config.ts` and
`vitest.phase4-5-coverage.config.ts` paths are explicit compatibility exports of
the same current config. Their old phase scopes and missing imports are retired;
they do not claim current phase1-3/phase4-5 or whole-server coverage. Historical
reports and floors remain historical evidence and are not the running gate.
