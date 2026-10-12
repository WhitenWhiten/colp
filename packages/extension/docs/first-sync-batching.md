# First-sync upload batching

The extension discovers `limits.maxSyncBatchOperations` from the server Manifest
and declares up to 50 operations when creating a Session. Missing limits and old
stored Sessions default to one operation. The negotiated Session limit is stored
with the Session and bounds every batch.

Fresh merge-bootstrap `create_node` operations can share a non-atomic Push when
their placement already uses a canonical parent, with no dependency or placement
anchor. Special mount creates, dependent operations, edits, advanced import,
and retries retain the existing singleton path. Queue claims stay contiguous and
stop at deferred, blocked, delayed, previously attempted, or unavailable work.
Requests are bounded by both the Session count and a 64 KiB UTF-8 body budget.
Absent placement anchors may be the protocol's explicit `null` values. The test
fixture uses the real bootstrap Operation producer and validates its wire schema.

Production starts with five operations, then sizes subsequent batches from
observed latency toward a five-second budget (also capped at half the request
timeout). A drain yields after twenty seconds so Pull and Session maintenance can
run. Retries retain their original singleton attempts and do not enter a new batch.

Every member persists its original singleton attempt before the batch is sent.
COLP Server binds the outer HTTP key to the whole array and uses each member's
`opId` for its individual receipt binding. A batch Problem may follow a committed
prefix, so it must never be interpreted as rejection of every member. On errors,
lost responses, or malformed results, the extension parks unsettled members with
their singleton attempts and recovers them in sequence order. `Retry-After` still
applies. Every response identity is checked before any local receipt is published.
Subscription and current-authority checks guard the actual batch dispatch.

Upload progress counts server mappings published by individual receipts, not
requests or queue claims. Provisional `pending-*`, `local-*` and `mount:*`
identities do not count as uploaded. While a batch response is unknown, its
members remain live work and progress advances only as singleton retries recover
their receipts. `tests/outbound-push-progress.test.ts` exercises the real progress
handler against the durable store through successful batches and failed receipts.

`tests/outbound-push-batch.test.ts` verifies 100 independent creates require two
Push requests with a negotiated limit of 50, compared with 100 requests at limit
one. This is a request-count result, not a claim of a 50-fold wall-time speedup;
server transactions, local persistence, snapshot download and browser projection
still contribute to total first-sync time. The same tests cover byte limits,
dependency boundaries, dispatch refusal, rate limits, restart recovery after
partial commits, malformed responses, and local receipt transaction rollback.

Deploy the matching COLP Server update and its migration before enabling batching.
`SYNC_MAX_BATCH_OPERATIONS=1` disables it without discarding operation receipts.

The production browser harness runs against COLP Server (`packages/server`): build
with `npm run build -- --config config/e2e-fixture.json`, then run `node
../server/scripts/with-postgres.mjs --isolated-owner -- node scripts/with-xvfb.mjs
node_modules/.bin/playwright test e2e/mv3-first-run-sync.spec.ts -g 'first-run
preview is local'`. This enables negotiated batches and checks that 100 real Chrome
bookmarks reach canonical server nodes through multi-operation requests. Rebuild with
`npm run build` afterwards to restore production configuration.
