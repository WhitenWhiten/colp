# KNS-09 release pin, metrics, and rollback

Owner: KNS-09 (Release). This file pins the first-run sync release surface. It does not change Merge or Delete product semantics.

## Release pin

The current database is IndexedDB **v21**. Do not ship a v9, v10, v11, v12, v13, v14, v15, v16, v17, v18, v19, or v20 binary after any profile has opened v21 (`oldVersion > DATABASE_VERSION` fails closed). `evidence:kns-09-release` produces a manifest, not an acceptance verdict.

Earlier 20-gate receipts were recorded against commits made before the extension moved to this repository and are not proof of the current tree. A new `kns-09:receipt` on a clean SHA is required before calling the current tree accepted.

| Field | Value |
|---|---|
| COLP package | `@know-n/colp` `0.0.0-development` |
| Server package | `@know-n/colp-server` `0.1.0` (`packages/server`) |
| Extension package | `known-extension` `0.1.0` |
| IndexedDB | `known-phase3-indexeddb-entry` version **21** |
| Feature flags | `known.kns09.mutations.v1` default `{ coordinator: true, ui: true }` |
| Fixture | `packages/node/fixtures/kns-00-contract/golden-scenarios.json` (digest in the receipt) |
| Target E2E | `evidence:first-run-sync`, `evidence:trash-restore` |

Manifest command: `npm run kns-09:manifest`. Acceptance: `npm run kns-09:receipt` consumes machine `gate-results.json` and cannot mark skipped/failed/cancelled gates as accepted.

## Mutation switches

`chrome.storage.local['known.kns09.mutations.v1']`:

- `coordinator: false` — first-run confirm, add-range confirm, advanced-plan confirmation, bootstrap/import resume enqueue, and **inbound Pull apply** return `sync_paused` (`kns09Paused('pull')`). Preview, status, and later stay readable; existing durable plans and queue rows remain readable for drain.
- `ui: false` — detach / rejoin / remote-delete commands return `sync_paused`.
- Queue drain continues. Do not install a v9, v10, v11, v12, v13, v14, v15, v16, v17, v18, v19, or v20 extension over a v21 database.

## Schema v21 rollback rule

Version 21 adds durable `boundary_confirmation_commands` and their scope/state index.
Versions 18–20 native intent and pull indexes remain unchanged, including
`pull_pages` `by_scope_pull_page_state` and `pull_events` `by_scope_pull_operation`.
The upgrade creates indexes populated by IndexedDB; it does not rewrite pull pages, events, queue rows, or ack intents.
If a release must be rolled back, keep the v21 reader (`keep-v21`) and close mutation controls
(`coordinator` and `ui`); let the existing queue drain with its original `opId`/sequence/body. Do not
downgrade IndexedDB, delete indexes, or clear the database.

## Schema v19 rollback rule

Version 19 adds `bookmark_events` `by_scope_event_operation_ordinal` to query upload evidence by operation.
The upgrade creates an index populated by IndexedDB; it does not rewrite event, queue, receipt, or mapping records.
Version 18 added the scoped `classification_confirmation_intents` store without rewriting existing rows.
It has been unused since 2026-10-06 and is emptied on update; the store itself remains so v19 is unchanged.
Version 17 added `diagnostics` `by_scope_parked`, so pruning quarantine markers costs the markers
rather than the whole ingress ledger. A v16→v17 upgrade createIndex only; it does not scan queue,
receipts, intents, or history. If a release must be rolled back, keep the v19 reader (`keep-v19`) and
close mutation controls
(`coordinator` and `ui`); let the existing queue drain with its original `opId`/sequence/body. Do not
downgrade IndexedDB, delete indexes, or clear the database. Retired/account-cleaned scopes keep
intent rows in their immutable archive for diagnosis.

## Metrics

Low-cardinality names only. Locators are 16-hex SHA-256 prefixes of collection and replica ids (`kns09:v1:`). Never emit URL, title, native id, full Node id, or raw `scopeKey`.

| Name | Meaning |
|---|---|
| `kns09.first_run_total.{started,completed,attention,paused,failed}` | First-run confirm outcomes |
| `kns09.queue_backlog_age_ms` | Age of live outbound work (histogram; unknown if no durable enqueue time) |
| `kns09.push_receipt_latency_ms` | Claim-to-receipt wait (histogram; unknown when `retry.notBefore` is 0) |
| `kns09.pull_recovery_total` | Wake that started frozen |
| `kns09.duplicate_candidate_total` | Merge duplicate candidates |
| `kns09.conflict_total` | Merge field conflicts |
| `kns09.permission_revoked_total` | Ready → permission required |
| `kns09.scope_reconcile_failure_total` | Re-auth reconcile threw |
| `sync_trash_restore_total.{applied,purged,...}` | Backend trash restore (KNS-06) |

Stop counters (any non-zero halts expansion): `kns09.stop.duplicate_node`, `out_of_scope_upload`, `unconfirmed_delete`, `cursor_divergence`, `recovery_loop`, `mapping_identity_collision`.
`out_of_scope_upload` also pauses the ingress lane so affected native/Pull mutations stop. Counters persist in `known.kns09.metrics.v1` as bounded histograms plus a 32-slot diagnosis ring. Missing evidence is `unknown`, not a zero success.

First-run `started`/`completed`/`attention` are deduped per confirmation id so confirm/status/resume of one run count once.

## Rollout

1. Internal dual Profile (`evidence:first-run-sync` + `evidence:trash-restore`) — one full sync cycle and one offline recovery window.
2. Small percent of real users — same observation window.
3. Full — same window.

## Stop conditions

Halt expansion on any of: duplicate Node, out-of-scope upload, unconfirmed delete, cursor divergence, recovery loop, mapping identity collision.
