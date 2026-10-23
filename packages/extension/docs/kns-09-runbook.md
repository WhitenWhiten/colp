# KNS-09 first-run sync release and rollback

Owner: Release on-call. Do not change Merge or Delete semantics from this runbook. Gray dashboard uses collection/replica **hashes** only — never URL, title, or a full Node id. The release pin is [kns-09-release.md](kns-09-release.md).

## Locate identities

Full `scopeKey`, `mountId`, `replicaId`, and `opId` stay on the device (IndexedDB `known-phase3-indexeddb-entry` v23). Remote logs and metrics carry only `collectionHash` / `replicaHash` from `locatorHash()` in `src/kns-09-release.ts`.

On the device (options page / SW evidence, redacted export):

1. `scopeKey` — `sync_scopes` key; JSON array of environment, server, account, profile, collection, replica, generation.
2. `mountId` — `mount_bindings.mountId` (for example `mount:…`). Status `active` / `pending` / `detached`.
3. `replicaId` — `sync_scopes.replicaId`. Hash it before leaving the device.
4. `opId` — `outbound_queue.opId`. Export only the hash for tickets.

Redacted evidence: `npm run evidence:first-run-sync` or `evidence:trash-restore` (both run `verify-bookmark-privacy-artifacts`).

## Restore one Node

Use Product Sync Center trash restore (single, bulk, or subtree) or COLP `restore_node` (KNS-06). Do not `UPDATE nodes SET deleted_at = NULL` in SQL. Purged identities are `resource_purged` (410). Empty trash is a Product command that still obeys the 30-day retention floor, replica Ack, watermark, and purge fence — never `DELETE FROM nodes`.

## Stale cursor

If Pull returns `sync_cursor_expired` / engine `recoveryFrozen`, do not write the old cursor. Let recovery rebase, or pause Sync (`coordinator`/`ui` false) and drain Push. Pull apply also pauses when `coordinator` is false. A v9–v22 binary cannot read a v23 database.

## Safe queue drain

1. Set `chrome.storage.local['known.kns09.mutations.v1']` to `{ coordinator: false, ui: false }`.
2. Reload the extension. Reads and outbound drain stay up. First-run confirm, remote-delete, and inbound Pull apply return `sync_paused`.
3. Do not delete queue rows by hand. Do not enqueue a second op with the same `opId`.
4. Claimed rows reclaim on a new fence after worker hang; that is not a duplicate Push.

## Rollback drill

Fixture: `tests/fixtures/kns-09-rollback-drill.json`.

```bash
npm run kns-09:contracts
```

Expected diagnosis: `readableSchema=true`, `rollbackBinary=keep-v23`, `drainSafe=true`, `silentDelete=false`, `duplicatePushRisk=false`, `conclusion=pause_mutations_and_drain`. Offline + claimed queue + pending work: do not install v9/v10/v11/v12/v13/v14/v15/v16/v17/v18/v19/v20/v21/v22, do not silent-delete, and do not double-enqueue.

## Schema v17 rollback rule

Version 17 adds `diagnostics` `by_scope_parked`, so pruning quarantine markers costs the markers
rather than the whole ingress ledger. The upgrade from v16 only createIndex; existing queue, mapping,
recovery, intent, receipt, and cursor rows keep their bytes and identities. Keep the v17 reader during
a rollback, close mutation controls, and
drain durable queue work with the original request body. Never downgrade IndexedDB. Retired/account-cleaned
scopes retain intent rows in their archive.

## CI that blocks release

All jobs are in `.github/workflows/colp-ci.yml` and on `ci-gate`.

| Gate | Command / job |
|---|---|
| Extension typecheck / lint / source-size / unit | `extension` |
| KNS-09 contracts and manifest | `extension-kns-09-release` |
| COLP check / typecheck | `static` (`check:protocol` … `typecheck`) |
| Server typecheck / unit | `server` |
| Target E2E | `evidence:first-run-sync`, `evidence:trash-restore` (`extension-kns-09-e2e`) |
| Acceptance receipt | `evidence:kns-09-acceptance` consumes `gate-results.json`; skipped/failed/cancelled cannot be accepted |

Promote a SHA only when the acceptance receipt and both evidence scripts are green on that commit. Skipped or cancelled E2E is not success.

## Rollout and stop

Internal dual Profile → small percent → full. Each stage needs one sync cycle and one offline recovery window. Any non-zero `kns09.stop.*` stops expansion. Keep mutation switches closed until the owning KNS task is green; do not roll back to a binary older than v23.
