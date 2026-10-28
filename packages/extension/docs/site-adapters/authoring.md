# Developing an adapter against the shared host

The shipped registry contains **Bilibili only**. The post/DOM implementations under `tests/fixtures/site-adapters` are contract fixtures, not supported sites. This guide prepares future adapter work without adding a site or granting new origins.

## Ownership of responsibilities

An adapter identifies its source and reads bounded source facts. The shared host owns permissions, document/account leases, read pacing, durable admission, copy policy, native receipts, classification, Sync and shared associations. Site code must not import the service worker, bookmark writer, provider client or cloud command executor.

Normal saving is local first. A new adapter must not introduce a server lookup before native success. Shared roles are looked up in the local association cache; missing cache data permits an authorized provisional local save. After ordinary Sync uploads it, association/convergence is asynchronous and remains bound to the original destination owner. Do not deduplicate by title, URL or native ID, or change a pending transfer's owner when login changes.

## Files and registration

Place the identity codec, bounded reader, factory and page entry in a site-specific directory under `src/site-adapters`. The entry composes the factory with the common runtime:

```ts
import { startAdapterRuntime } from '../page-runtime.js';
import { definition } from './definition.js';
import { createAdapter } from './adapter.js';
startAdapterRuntime(definition, createAdapter);
```

Register the audited definition once in `registry.ts`. Supply `scripts.adapter` (the packaged `.js` path) and `build.adapter` (the `.ts` entry relative to `src/`). A MAIN probe, if needed, similarly supplies both `scripts.probe` and `build.probe`. The build derives all classic bundles from this registry and writes `site-adapter-bundles.json`; release verification checks every listed bundle. Missing entries, paths outside `src/` and colliding output names fail the build. No edit to the build script or worker dispatch is needed for another registered adapter.

Define source/content IDs, exact HTTPS origins and paths, account validation, item URL validation, read scope and resume strategy explicitly. For private or account-local content, keep the source account in content identity. Equal opaque IDs from different sites or accounts must not collide. Folder/source identities and semantic identities remain distinct.

## Supported capabilities and evidence

| Declaration | Required behavior |
| --- | --- |
| `observeFavorites` | Only bounded observations/hints; an event is not authorization to write a bookmark. Use immutable interaction IDs captured before asynchronous work. |
| `readMemberships` | Return every requested edge as present, absent or unknown. Partial/inaccessible reads are unknown. |
| `negativeReadback: true` | Supply fresh, scoped evidence of absence. A missing item in a best-effort page does not qualify. |
| `enumerateCollections` / `enumerateItems` | Respect host item/byte budgets, explicit omissions and replay-safe cursors. Account-only or single-list sources can omit catalog enumeration. |
| `readScope: document` | Read the initiating document; navigation or closure cannot silently select another tab. Account-wide fallback requires an explicit declaration and fixture evidence. |
| `importResume` | Retain a stable cursor only if the reader can replay it; otherwise restart and deduplicate confirmed identities. |
| `collectionSnapshot: pointInTime` | A contiguous complete snapshot with a stable identity; otherwise use `positiveOnly`. |

The current host supports **flat collections and membership sets**. Tree collections, repeated ordered entries, arbitrary background HTTP recipes and injected capture controls remain unavailable. Registry validation rejects unsupported declarations. Implement and qualify a new host capability before a future adapter can advertise it; never flatten or discard information silently.

Use `AdapterServices.readPolicy` for actual HTTP request deadlines, spacing, attempts and byte budgets. Cancellation must release observers/listeners and stop further reads. Challenge, sign-out and rate-limit states remain visible; never disguise them as empty collections. MAIN code sends only bounded IDs and response codes, never request bodies, cookies or tokens. Host confirmation obtains fresh state before planning.

## Reusable qualification

Create sanitized fixtures and call `qualifySiteAdapter` from `tests/fixtures/site-adapters/qualification.ts`. The existing `site-adapter-qualification.test.ts` demonstrates both the actual Bilibili factory with fixture HTTP and a test-only opaque-ID post reader. The shared suite exercises capability/implementation agreement, source/content identity, closed transport schemas, collection/item pages, continuation replay and negative-evidence boundaries. It is a baseline, not live-site certification.

Add site-specific cases for multiple collections containing one item, same-name/different-ID collections, unsupported/deleted content, delayed readback, malformed/partial responses, challenge/login expiry and the exact observation mechanism. Reuse the existing page-runtime, isolation, local-save, migration and shared-Sync suites; do not fork the save engine for each site.

From `packages/extension`:

```sh
npm run test:site-adapters
npm run typecheck
npm run build
node scripts/verify-release-artifact.mjs dist/production
npm run build:development
KNOWN_E2E_HEADED=0 node scripts/with-xvfb.mjs npx playwright test --project=core e2e/mv3-site-adapter-lifecycle.spec.ts e2e/mv3-site-adapter-local-first.spec.ts
KNOWN_E2E_HEADED=0 node ../server/scripts/with-postgres.mjs --isolated-owner -- node scripts/with-xvfb.mjs npx playwright test --project=core e2e/mv3-site-adapter-shared-sync.spec.ts
```

Run only the tests relevant to the change. Browser automation uses xvfb. Fixtures must close browser contexts, temporary profiles and their server/database resources. Keep real-site qualification separately identified, use an authorized test account, and record the actual browser/version/entry-point coverage. No controlled fixture authorizes a claim about an untested real website.

## Compatibility and upgrades

Generic managed-copy identity supports new registered sites without a site-specific server write implementation. The separate legacy cloud archive protocol still requires a server-side audited identity codec. New optional server behavior is negotiated explicitly (`managedLocalConvergence: 1`); older servers retain local saves and report pending/reviewable association work.

Do not change identity versions to repair a display label. Identity changes require a reviewed migration. Preserve original native commands and receipts across schema upgrades and worker cuts. Scope repair uses retained ownership evidence, not the current login. A new adapter's backup data must remain inert until identity/account/root proofs are re-established.
