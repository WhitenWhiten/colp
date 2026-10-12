import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, test } from 'vitest';
import { readSyncStateSource } from './read-sync-state-source.js';

/**
 * Static structure/boundary contract (allowlisted in tests/static-anchor-allowlist.ts):
 * the facade line budget and acyclicity, the absence of browser-event suppression, the
 * COLP 0.2 page/effect vocabulary and the packaged MV3 pull evidence gate. Apply
 * behaviour is covered by tests/pull-applier.test.ts, tests/pull-apply-integrity.test.ts,
 * tests/pull-page-stager.test.ts and tests/pull-mapping-lifecycle.test.ts.
 */
describe('P3-32 Pull apply static contract', () => {
  test('keeps an acyclic small facade over page staging and apply runtime owners', async () => {
    const facade = await readFile(resolve('src/pull-applier.ts'), 'utf8');
    const stager = await readFile(resolve('src/pull-page-stager.ts'), 'utf8');
    const runtime = await readFile(resolve('src/pull-apply-runtime.ts'), 'utf8');
    assert.ok(facade.split(/\r?\n/u).length - 1 <= 80);
    assert.match(facade, /createPullPageStager/); assert.match(facade, /createPullApplyRuntime/);
    assert.match(facade, /Object\.freeze/); assert.match(stager, /runtime\.preflight/);
    assert.match(stager, /runtime\.resume/); assert.doesNotMatch(stager, /pull-apply-runtime/);
    assert.match(runtime, /assertPullApplierGate/);
  });

  test('pins COLP 0.2, Manifest-discovered Pull/effect pages and fail-closed staging', async () => {
    const sources = await Promise.all(['src/pull-applier.ts', 'src/pull-apply-runtime.ts',
      'src/pull-page-stager.ts', 'src/pull-codec.ts', 'src/pull-projection.ts',
      'src/manifest-client.ts', 'src/session-client.ts']
      .map((file) => readFile(resolve(file), 'utf8')));
    const source = `${sources.join('\n')}\n${await readSyncStateSource()}`;
    for (const marker of ['acceptedProtocolVersion', "'0.2'", 'syncPull', 'syncEffectPages',
      'syncPullV02', 'authoritativeEffectPage', 'canonicalAuthoritativeEffectDigest',
      'canonicalAuthoritativeEffectPageDigest', 'stagePullPage',
      "pullPages: 'pull_pages'", "pullEvents: 'pull_events'", "effectPages: 'effect_pages'",
      'intent_prepared', 'browser_call_started', 'native_event_observed', 'authority_committed', 'page_complete',
      'downloadAuthoritativeEffectPages', 'nextPageNumber', 'retryNotBefore',
      'sessionTransportBudget']) {
      assert.match(source, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    assert.doesNotMatch(source, /\/colp\/v0\.[12]\/sync|suppressEvents|console\.(?:log|info|debug)/);
  });

  test('covers precise intent evidence, all native mutations, sidecar separators and crash recovery', async () => {
    const source = (await Promise.all(['src/pull-applier.ts', 'src/pull-apply-runtime.ts',
      'src/pull-bookmark-api.ts', 'src/pull-page-stager.ts', 'src/pull-codec.ts', 'src/pull-projection.ts']
      .map((file) => readFile(resolve(file), 'utf8')))).join('\n');
    const queue = await readFile(resolve('src/bookmark-event-queue.ts'), 'utf8');
    // Pull mutations go through the subscription guard (BS-04), which
    // refuses writes into read-only subscription folders before calling Chrome.
    const guards = await readFile(resolve('src/bookmark-subscriptions/guards.ts'), 'utf8');
    for (const method of ['create', 'update', 'move', 'remove', 'removeTree']) {
      assert.match(source, new RegExp(`${method}: wrap\\([^)]*\\) => personalBookmarks\\.${method}\\(`));
      assert.match(guards, new RegExp(`return chrome\\.bookmarks\\.${method}\\(`));
    }
    for (const marker of ['preserve_remote', 'recovery_required',
      'preStateDigest', 'expectedPostState', 'nativeEventEvidence', 'recoverCreatedNative']) assert.match(source, new RegExp(marker));
    assert.match(queue, /observeApplyIntentEvent/);
    assert.match(queue, /stageBookmarkEvent/);
    assert.doesNotMatch(`${source}\n${queue}`, /suppressEvents|setTimeout\([^)]*ignore/i);
  });

  test('requires production packaged MV3 evidence with real bookmark events and zero echo queue', async () => {
    const e2e = await readFile(resolve('e2e/mv3-pull-applier.spec.ts'), 'utf8');
    const pkg = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as { scripts: Record<string, string> };
    for (const marker of ['dist/production', 'launchPersistentContext', 'chrome.bookmarks.create',
      'chrome.bookmarks.update', 'chrome.bookmarks.move', 'chrome.bookmarks.remove', 'terminateExtensionWorker',
      'similarUserEvent', 'queue', 'pullPages', 'intents']) assert.match(e2e, new RegExp(marker));
    assert.match(pkg.scripts['evidence:phase3-pull-applier'] ?? '', /with-postgres\.mjs -- npm run evidence:phase3-pull-applier:inner/);
    assert.match(pkg.scripts['evidence:phase3-pull-applier:inner'] ?? '', /mv3-pull-applier\.spec\.ts/);
    assert.doesNotMatch(e2e, /page\.route\(|route\.fulfill|mockChrome|suppressEvents/);
  });
});
