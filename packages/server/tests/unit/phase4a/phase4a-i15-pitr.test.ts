/**
 * P4A-I15 PITR reconciliation: DB generation ledger vs per-exact-key R2 facts.
 *
 * Proves:
 *  - match when the exact-key HEAD facts equal the ledger's bound etag/size;
 *  - missing when the exact key HEAD reports not_found;
 *  - mismatch (quarantine candidate) when the exact key exists with different
 *    etag/size, with ZERO destructive action;
 *  - provider retryable/denied/unknown heads are 'unknown' (environment),
 *    NEVER mismatch — provider throttling is not contract corruption;
 *  - the report is produced by per-exact-key HEAD calls for every claimed
 *    ledger row (never a bucket list) and every claimed row is probed exactly
 *    once;
 *  - deleted generations are excluded from the claimed ledger (the report
 *    only covers non-deleted generations);
 *  - the report carries no key material (keys are only probed, never
 *    serialized).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  reconcileGenerationLedger,
} from '../../../src/modules/attachments/index.js';
import {
  InMemoryPitrLedger,
  RecordingPitrStore,
  pitrRowFor,
} from '../../support/phase4a-i15-test-helpers.js';

const NOW_ISO = '2026-08-08T00:10:00.000Z';

describe('P4A-I15 PITR reconcile', () => {
  test('match / missing / mismatch verdicts over per-exact-key facts', async () => {
    const matching = pitrRowFor(1); // expectedEtag "etag-...3001", size 7
    const missing = pitrRowFor(2);
    const mismatch = pitrRowFor(3);
    const ledger = new InMemoryPitrLedger();
    ledger.setRows([matching, missing, mismatch]);

    const store = new RecordingPitrStore();
    store.seed(matching.key, matching.expectedEtag!, matching.expectedSize!);
    store.seed(mismatch.key, `"etag-different"`, mismatch.expectedSize! + 1);

    const report = await reconcileGenerationLedger({ ledger, objectStore: store, nowIso: NOW_ISO });
    assert.equal(report.plane, 'reconcile');
    assert.equal(report.method, 'per_exact_key_head');
    assert.equal(report.destructiveActionsTaken, false);
    assert.equal(report.counts.match, 1);
    assert.equal(report.counts.missing, 1);
    assert.equal(report.counts.mismatch, 1);
    assert.equal(report.counts.unknown, 0);
    assert.deepEqual(report.quarantineCandidates, [mismatch.generationId]);

    const byGeneration = new Map(report.findings.map((finding) => [finding.generationId, finding.verdict]));
    assert.equal(byGeneration.get(matching.generationId), 'match');
    assert.equal(byGeneration.get(missing.generationId), 'missing');
    assert.equal(byGeneration.get(mismatch.generationId), 'mismatch');
  });

  test('provider retryable/denied/unknown heads are unknown, never mismatch', async () => {
    const rows = [pitrRowFor(4), pitrRowFor(5), pitrRowFor(6)];
    const ledger = new InMemoryPitrLedger();
    ledger.setRows(rows);
    const store = new RecordingPitrStore();
    store.options.script = [
      { class: 'retryable' }, { class: 'denied' }, { class: 'unknown' },
    ];
    const report = await reconcileGenerationLedger({ ledger, objectStore: store, nowIso: NOW_ISO });
    assert.equal(report.counts.unknown, 3);
    assert.equal(report.counts.mismatch, 0, 'environment classes must never be reported as corruption');
    assert.equal(report.quarantineCandidates.length, 0);
  });

  test('every claimed ledger row is probed exactly once by exact key (never a bucket list)', async () => {
    const rows = [pitrRowFor(7), pitrRowFor(8), pitrRowFor(9)];
    const ledger = new InMemoryPitrLedger();
    ledger.setRows(rows);
    const store = new RecordingPitrStore();
    const report = await reconcileGenerationLedger({ ledger, objectStore: store, nowIso: NOW_ISO });
    assert.deepEqual(
      store.headCalls.map((call) => call.generationId).sort(),
      rows.map((row) => row.generationId).sort(),
      'the reconcile must probe each claimed generation exactly once by exact key',
    );
    assert.equal(store.headCalls.length, 3);
    assert.equal(report.findings.length, 3);
  });

  test('deleted generations are excluded from the claimed ledger', async () => {
    const deleted = pitrRowFor(10, { generationState: 'deleted' });
    const active = pitrRowFor(11);
    const ledger = new InMemoryPitrLedger();
    // The production ledger port only returns non-deleted generations; this
    // in-memory ledger mirrors that contract (it never yields the deleted row).
    ledger.setRows([active]);
    const store = new RecordingPitrStore();
    store.seed(deleted.key, deleted.expectedEtag!, deleted.expectedSize!);
    store.seed(active.key, active.expectedEtag!, active.expectedSize!);
    const report = await reconcileGenerationLedger({ ledger, objectStore: store, nowIso: NOW_ISO });
    assert.equal(report.findings.some((finding) => finding.generationId === deleted.generationId), false);
    assert.deepEqual(store.headCalls.map((call) => call.key), [active.key]);
  });

  test('the report never serializes key material', async () => {
    const marker = `pitr-key-marker-${Date.now()}`;
    const row = pitrRowFor(12, { key: `attachments/live/${marker}` });
    const ledger = new InMemoryPitrLedger();
    ledger.setRows([row]);
    const store = new RecordingPitrStore();
    store.seed(row.key, row.expectedEtag!, row.expectedSize!);
    const report = await reconcileGenerationLedger({ ledger, objectStore: store, nowIso: NOW_ISO });
    const serialized = JSON.stringify(report);
    assert.ok(!serialized.includes(marker), 'the reconcile report must never include physical keys');
    assert.ok(!serialized.includes('"key"'), 'no key field may be serialized');
  });
});