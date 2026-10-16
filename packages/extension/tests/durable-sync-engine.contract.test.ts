import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, test } from 'vitest';
import { readServiceWorkerGraph } from './service-worker-graph.js';

/**
 * Static anchors kept after A-13 / SR-16, each annotated with why it cannot be a
 * behavioural assertion. Everything else this file used to grep moved to:
 *
 *  - tests/service-worker-entry-behavior.test.ts — boot/startup/alarm/permission/
 *    online/message registration, listener install, recovery-chain lane;
 *  - tests/sync-engine-wake-behavior.test.ts — `known-sync-engine` alarm name,
 *    MV3 30s floor, engine lane, confirmed-online coalescing;
 *  - tests/durable-sync-engine.test.ts — Ack intents, Idempotency-Key, cold-start
 *    connectivity claim (`claimRestartConnectivity`,
 *    `connectivityConfirmationRevision`), recoveryFrozen lifecycle;
 *  - tests/durable-sync-engine-payload-budget.test.ts — `payload_too_large`;
 *  - tests/transport-budget.test.ts — `sessionTransportBudget`;
 *  - tests/engine-public-stability.test.ts — `PublicSyncEngineState` facts.
 */
describe('P3-33 durable engine static contract', () => {
  test('keeps the durable engine on public COLP entrypoints and out of console logging', async () => {
    const engine = await readFile(resolve('src/durable-sync-engine.ts'), 'utf8');
    // static-only: this is an absence claim. A deep COLP import, a raw `/colp/v0.`
    // URL or a `console.*` call leaves no trace in engine state, so no behavioural
    // assertion can fail at the moment the forbidden symbol appears.
    assert.doesNotMatch(engine, /@know-n\/colp\/(?:src|dist|internal)|\/colp\/v0\.|console\./);
  });

  test('wires one startup/online/alarm lifecycle and exposes stable UI-readable state', async () => {
    const worker = await readServiceWorkerGraph();
    const options = await readFile(resolve('src/options.ts'), 'utf8');
    // static-only: the production composition point. tests/durable-sync-engine.test.ts
    // drives a real engine and tests/sync-engine-wake-behavior.test.ts drives the real
    // `src/sw/engine.ts`, but neither can observe that the MV3 worker composes those
    // two together — the construction happens inside `runSyncEngine`'s own graph.
    for (const marker of ['createDurableSyncEngine', 'recoverVerifiedOrFreeze']) {
      assert.ok(worker.includes(marker), marker);
    }
    // static-only: `src/options.ts` is a DOM module with no host unit harness, and this
    // is the only path that turns a browser connectivity event into the
    // `known.connectivity.online` wake the worker validates. The worker side of that
    // message is behavioural (tests/service-worker-entry-behavior.test.ts).
    assert.match(options, /addEventListener\('online'[\s\S]{0,240}event\.isTrusted[\s\S]{0,240}known\.connectivity\.online/u);
    // static-only: `currentSyncStatusAuthority()` lives behind the full credential/
    // session graph. The public status shape is behaviourally pinned by
    // tests/engine-public-stability.test.ts, but "status loads config itself instead of
    // reusing a cached loadedConfig" is an ordering claim inside the function body.
    assert.match(worker, /async function currentSyncStatusAuthority\(\) \{\s*const config = await loadConfig\(\)/u);
    assert.doesNotMatch(worker, /currentSyncStatusAuthority\(\)[\s\S]{0,120}loadedConfig/u);
    // static-only: `handleSyncEngineRequest()` needs the full session/scope graph to
    // call, so the frozen-before-wake choice between `.recover()` and `.flush()` in the
    // worker status path has no injectable seam. The recover/flush semantics themselves
    // are behavioural in tests/durable-sync-engine.test.ts.
    assert.match(worker, /if \(result && !result\.recoveryFrozen && result\.phase !== 'error'\)[\s\S]{0,760}frozenBeforeWake\)[\s\S]{0,80}\.recover\(\)/u);
    assert.match(worker, /if \(result && !result\.recoveryFrozen && result\.phase !== 'error'\)[\s\S]{0,900}\.flush\(\)/u);
    // static-only: `src/sw/auth.ts` request routing. The refresh/logout branches need a
    // live credential, manifest and replica-retirement graph; `tests/auth-shell.test.ts`
    // covers the controller-level behaviour but not the worker's message routing.
    assert.match(worker, /message\.kind === 'known\.auth\.refresh'[\s\S]{0,600}pushSessionAuthority\(true\)/u);
    // Logout first tears down subscription state for the signed-in subject
    // (BS-05), then signs out and drains the auth lane. The window stops well
    // short of the next message branch.
    assert.match(worker, /message\.kind === 'known\.auth\.logout'[\s\S]{0,200}prepareSubscriptionLogout\([\s\S]{0,520}workCoordinator\.drain\('auth'\)/u);
    for (const marker of ['known.auth.logout', 'cleanupAccount', 'finally']) {
      assert.match(worker, new RegExp(marker));
    }
  });

  test('first-run confirmation and automatic library binding wake the durable engine', async () => {
    const worker = await readServiceWorkerGraph();
    // static-only: `first-run.ts` must not import the engine module — the wake is owned
    // by the router. Absence of an import has no runtime trace; the router behaviour it
    // protects is behavioural in tests/service-worker-entry-behavior.test.ts.
    const firstRun = await readFile(resolve('src/sw/first-run.ts'), 'utf8');
    assert.doesNotMatch(firstRun, /scheduleSyncEngineWake|from '\.\/engine\.js'/u);
    const auth = await readFile(resolve('src/sw/auth.ts'), 'utf8');
    // static-only: absence claim — the auth router must not resolve root authority from
    // the raw selected-root list; a leak would only be visible as a wrong scope, which
    // tests/scope-transition.test.ts covers at the store level, not here.
    assert.doesNotMatch(auth, /selectedRoots\.length/u);
    // static-only: `scheduleSyncEngineWakeIfRootConfigured()` is module-private and only
    // reachable through the full `known.collection.select` credential path.
    assert.match(auth, /async function scheduleSyncEngineWakeIfRootConfigured\(\) \{[\s\S]{0,280}hasBoundCollection\(\)/u);
    assert.match(auth, /async function scheduleSyncEngineWakeIfRootConfigured\(\) \{[\s\S]{0,280}getScope\(scope\)/u);
    // The window covers the personal-sync and metadata checks that run before the credential branch.
    assert.match(auth,
      /ensureLibraryBinding\(\{ login: true \}\)[\s\S]{0,1800}scheduleSyncEngineWakeIfRootConfigured\(\)/u);
  });

  test('requires a production packaged MV3 gate with two isolated profiles and privacy scans', async () => {
    // Gate contract: the e2e spec and the evidence scripts are the artifacts under
    // test, and executing them is an e2e action (forbidden in the host unit lane).
    const e2e = await readFile(resolve('e2e/mv3-durable-sync-engine.spec.ts'), 'utf8');
    const pkg = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as { scripts: Record<string, string> };
    for (const marker of ['dist/production', 'startRealStack', 'launchPersistentContext', 'profileA', 'profileB',
      'terminateExtensionWorker', 'chrome.bookmarks', 'IndexedDB', 'syncEngineState']) assert.match(e2e, new RegExp(marker));
    assert.doesNotMatch(e2e, /page\.route\(|route\.fulfill|mockChrome|test\.skip/);
    const command = `${pkg.scripts['evidence:phase3-durable-sync-engine'] ?? ''} ${
      pkg.scripts['evidence:phase3-durable-sync-engine:inner'] ?? ''}`;
    assert.match(command, /mv3-durable-sync-engine\.spec\.ts/); assert.match(command, /verify-release-artifact/);
    assert.match(command, /verify-bookmark-privacy-artifacts/);
  });

  test('prepareEvidenceEngine does not lift recoveryFrozen; only seed unfreezes', async () => {
    // static-only: `prepareEvidenceEngine`, `unfreezeEvidenceEngineForSeed`,
    // `seedOutboundPushEvidence` and the evidence switch cases are module-private in
    // `src/sw/evidence.ts`; the only export is `handleSyncStateEvidence`, gated behind
    // `__KNOWN_EXTENSION_EVIDENCE__`. This is also an absence claim by nature — lifting
    // recoveryFrozen in the wrong helper would only *prevent* a failure, which a passing
    // behavioural run cannot reveal.
    const evidence = await readFile(resolve('src/sw/evidence.ts'), 'utf8');
    const prepare = namedFunction(evidence, 'prepareEvidenceEngine');
    assert.doesNotMatch(prepare, /recoveryFrozen:\s*false/u);
    const unfreeze = namedFunction(evidence, 'unfreezeEvidenceEngineForSeed');
    assert.match(unfreeze, /recoveryFrozen:\s*false/u);
    const seed = namedFunction(evidence, 'seedOutboundPushEvidence');
    assert.match(seed, /unfreezeEvidenceEngineForSeed/u);
    const refs = evidence.match(/unfreezeEvidenceEngineForSeed/gu) ?? [];
    assert.equal(refs.length, 2);
    for (const name of ['wakeOutboundPushEvidence', 'exportOutboundPushEvidence', 'syncEngineState',
      'drainBookmarkEventCaptureEvidence', 'pullNowEvidence']) {
      assert.doesNotMatch(switchCase(evidence, name), /recoveryFrozen:\s*false/u);
    }
    for (const name of ['configureEventEvidence', 'configureOutboundBookmarkRoot',
      'configureOutboundCanonicalFixture', 'configureDurableEngineEvidence']) {
      assert.doesNotMatch(namedFunction(evidence, name), /recoveryFrozen:\s*false/u);
    }
  });
});

function namedFunction(source: string, name: string): string {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\b`));
  assert.ok(start >= 0, `${name} missing`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`${name} unclosed`);
}

function switchCase(source: string, name: string): string {
  const start = source.indexOf(`case '${name}'`);
  assert.ok(start >= 0, `${name} case missing`);
  const next = source.indexOf('\n      case ', start + 1);
  return next === -1 ? source.slice(start) : source.slice(start, next);
}
