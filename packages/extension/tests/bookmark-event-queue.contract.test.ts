import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, test } from 'vitest';
import { readServiceWorkerGraph } from './service-worker-graph.js';
import { readSyncStateSource } from './read-sync-state-source.js';

const packageRoot = resolve(import.meta.dirname, '..');

/**
 * Static anchors kept after A-13 / SR-16, each annotated with why it cannot be a
 * behavioural assertion. The listener/queue behaviour this file used to grep moved to:
 *
 *  - tests/service-worker-entry-behavior.test.ts — boot/startup/alarm/permission
 *    registration, the recovery chain lane and its wake;
 *  - tests/bookmark-listener-lifecycle.test.ts — all five Chrome events, dedup,
 *    bounded public counters, capture-failure codes;
 *  - tests/bookmark-event-queue.test.ts — privacy-before-persistence ordering,
 *    protocol/byte-budget rejection before a durable record;
 *  - tests/bookmark-event-quarantine.test.ts — poison events are skipped and
 *    quarantined instead of breaking the flush round;
 *  - tests/bookmark-event-recovery-signal.test.ts + tests/bookmark-frozen-capture-recovery.test.ts
 *    — the recovery chain, its durable diagnostic and the capture-recovery alarm;
 *  - tests/kns-04-push.test.ts — `queue.reordered(...)` reorder capture.
 */
describe('P3-30 durable bookmark event contract', () => {
  test('keeps the normalizer free of restore, logging, telemetry and clock-derived sequences', async () => {
    const normalizer = await readFile(resolve(packageRoot, 'src/bookmark-event-queue.ts'), 'utf8');
    // static-only: absence claims. A `restore_node` capture path, a console/telemetry/
    // fetch side channel or a sequence derived from `Date.now()` all leave the durable
    // queue state indistinguishable from the correct implementation, so only the source
    // text can fail.
    assert.doesNotMatch(normalizer, /restore_node/);
    assert.doesNotMatch(normalizer, /console\.|telemetry|analytics|fetch\(/);
    assert.doesNotMatch(normalizer, /Date\.now\(\).*sequence|sequence.*Date\.now\(\)/s);
  });

  test('runs recovery against the evidence scope when an evidence session owns capture', async () => {
    const bookmarks = await readFile(resolve(packageRoot, 'src/sw/bookmarks.ts'), 'utf8');
    // static-only: the evidence-only precedence `sw.eventEvidenceScope ?? currentSyncScope()`
    // is unreachable in the host lane because a behavioural test would have to run the
    // worker with `__KNOWN_EXTENSION_EVIDENCE__` and a pinned evidence scope — the
    // ordinary scope path is behavioural in tests/service-worker-entry-behavior.test.ts
    // and tests/bookmark-event-recovery-signal.test.ts.
    assert.match(bookmarks,
      /recoverBookmarkEvents\(\)[\s\S]+eventEvidenceScope[\s\S]+currentSyncScope\(\)/u);
  });

  test('keeps production diagnostics public, low-sensitivity and separate from the evidence surface', async () => {
    const worker = await readServiceWorkerGraph();
    const build = await readFile(resolve(packageRoot, 'scripts/build.mjs'), 'utf8');
    const runner = await readFile(resolve(packageRoot, 'e2e/mv3-multi-device-recovery.spec.ts'), 'utf8');
    // static-only: the public counter fields themselves are behavioural
    // (tests/bookmark-listener-lifecycle.test.ts asserts the exact status object), but the
    // worker must AND the optional bookmark permission into `listenerInstalled` when it
    // composes the status authority — that composition sits behind the full config/
    // session graph inside `currentSyncStatusAuthority()`.
    assert.match(worker, /listenerInstalled:\s*bookmarkPermissionGranted\s*&&\s*bookmarkIngressStatus\.listenerInstalled/u);
    // Gate wiring: the production build must compile the evidence flag off, and the
    // multi-device e2e spec is the artifact under test (executing it is an e2e action).
    assert.match(build, /__KNOWN_EXTENSION_EVIDENCE__[^\n]*production[^\n]*false/);
    assert.doesNotMatch(runner, /known\.sync-state\.evidence/);
    assert.match(runner, /known\.sync\.engine\.status/);
  });

  test('generates operation validators from the public COLP schema without a runtime compiler', async () => {
    const source = await readFile(resolve(packageRoot, 'src/bookmark-event-queue.ts'), 'utf8');
    const generator = await readFile(resolve(packageRoot, 'scripts/generate-bookmark-operation-validators.mjs'), 'utf8');
    const state = await readSyncStateSource();
    // Codegen/wiring: the generator script and its COLP schema import are the artifacts
    // under test. The generated validator behaviour is behavioural in
    // tests/bookmark-event-queue.test.ts ("rejects protocol-invalid and over-budget
    // payloads before a queue record is durable").
    assert.match(generator, /@know-n\/colp\/schema/);
    assert.match(generator, /definition\(['"]operation['"]\)/);
    // static-only: absence claim — no runtime validator compiler may be reintroduced.
    assert.doesNotMatch(source, /createValidatorRegistry|new Function|eval\(/);
    // static-only: the durable error-code vocabulary is a schema freeze; the codes are
    // asserted behaviourally in tests/bookmark-event-queue.test.ts, but the store keeps
    // them as string literals with no exported constant to import.
    assert.match(state, /operation_schema_invalid/);
    assert.match(state, /operation_byte_budget_exceeded/);
  });

  test('E2E uses chrome.bookmarks API, worker termination and persistent profile restart', async () => {
    // Gate contract: the packaged MV3 spec is the artifact under test and running it is
    // an e2e action, so its shape (real Chrome calls, worker termination, persistent
    // profile, no synthetic listener dispatch) is only checkable as text here.
    const e2e = await readFile(resolve(packageRoot, 'e2e/mv3-bookmark-event-queue.spec.ts'), 'utf8');
    for (const method of ['bookmarks.create', 'bookmarks.update', 'bookmarks.move', 'bookmarks.removeTree']) {
      assert.match(e2e, new RegExp(method.replace('.', '\\.')));
    }
    assert.match(e2e, /terminateExtensionWorker/);
    assert.match(e2e, /launchPersistentContext/);
    assert.match(e2e, /PRIVATE-QUEUE-SENTINEL|UNSELECTED-QUEUE-SENTINEL/);
    assert.doesNotMatch(e2e, /onCreated\.dispatch|onChanged\.dispatch|listener\(/);
  });
});
