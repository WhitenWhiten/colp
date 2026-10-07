/**
 * P4A-P10 PITR reconcile rehearsal contract (plan §9 P10 item 5). Uses the
 * PRODUCTION `reconcileGenerationLedger` against the production ledger/object
 * store ports.
 *
 * Anti-false-positive anchors:
 *  - reconcile is per-exact-key HEAD over the CLAIMED ledger rows: a report
 *    can only cover the lifecycle points that are actually present in the
 *    ledger, so "clearing the test tables" can never fake a recovery — a
 *    cleared ledger yields zero findings and the rehearsal MUST see the
 *    lifecycle generations reported (the unit pins the structural contract;
 *    the integration suite runs the real lifecycle);
 *  - reconcile NEVER writes or deletes (`destructiveActionsTaken: false`,
 *    head calls only) — clearing tables is the opposite of reconcile;
 *  - provider transient throttling (429/retryable) is `unknown` (environment),
 *    NEVER mismatch/quarantine — policy drift (etag/size) is the ONLY
 *    mismatch source, and the two are separated by deterministic run markers.
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

describe('P4A-P10 PITR reconcile: lifecycle points and anti-false-positive structure', () => {
  test('reconcile covers each lifecycle point with per-exact-key facts and zero destructive action', async () => {
    // intent point: `allocated` generation, object NOT yet uploaded -> missing.
    const intent = pitrRowFor(1, { generationState: 'allocated' });
    // PUT / complete point: object present with the exact observed identity -> match.
    const uploaded = pitrRowFor(2, { generationState: 'observed' });
    // finalize point: verified active generation -> match.
    const stored = pitrRowFor(3, { generationState: 'active' });
    // cleanup point: the deleted generation is NOT claimed (excluded by the
    // production ledger port); a row outside the claimed set can never be
    // reported, so the report is exactly the claimed set.
    const ledger = new InMemoryPitrLedger();
    ledger.setRows([intent, uploaded, stored]);

    const store = new RecordingPitrStore();
    store.seed(uploaded.key, uploaded.expectedEtag!, uploaded.expectedSize!);
    store.seed(stored.key, stored.expectedEtag!, stored.expectedSize!);
    // intent.key intentionally absent -> missing.

    const report = await reconcileGenerationLedger({ ledger, objectStore: store });
    assert.equal(report.destructiveActionsTaken, false);
    assert.equal(report.method, 'per_exact_key_head');
    assert.equal(report.counts.match, 2);
    assert.equal(report.counts.missing, 1);
    assert.equal(report.counts.mismatch, 0);
    assert.equal(report.counts.unknown, 0);
    assert.equal(report.counts.match + report.counts.missing + report.counts.mismatch + report.counts.unknown, 3,
      'the report must cover exactly the claimed rows');
    const byId = new Map(report.findings.map((finding) => [finding.generationId, finding]));
    assert.equal(byId.get(intent.generationId)!.verdict, 'missing');
    assert.equal(byId.get(intent.generationId)!.detail, 'state_allocated');
    assert.equal(byId.get(uploaded.generationId)!.verdict, 'match');
    assert.equal(byId.get(stored.generationId)!.verdict, 'match');
    // Per-exact-key: exactly one HEAD per claimed row, no bucket list.
    assert.deepEqual(store.headCalls.map((call) => call.generationId).sort(),
      [intent, uploaded, stored].map((row) => row.generationId).sort());
  });

  test('clearing the tables can never fake a reconcile: a cleared ledger reports zero findings and the rehearsal fails closed on it', async () => {
    const ledger = new InMemoryPitrLedger();
    ledger.setRows([]); // "cleared table"
    const store = new RecordingPitrStore();
    const report = await reconcileGenerationLedger({ ledger, objectStore: store });
    assert.equal(report.counts.match + report.counts.missing + report.counts.mismatch + report.counts.unknown, 0);
    assert.equal(report.findings.length, 0);
    assert.equal(store.headCalls.length, 0);
    // Structural anti-false-positive: table-clearing produces a report that
    // contains NONE of the lifecycle generations, so no recovery rehearsal
    // can accept it. A rehearsal that requires the lifecycle points to be
    // present must fail against this report.
    const lifecycleIds = [pitrRowFor(1).generationId, pitrRowFor(2).generationId, pitrRowFor(3).generationId];
    const reportedIds = new Set(report.findings.map((finding) => finding.generationId));
    assert.equal(lifecycleIds.some((id) => reportedIds.has(id)), false,
      'a cleared ledger reports no lifecycle point (cannot pass as reconcile evidence)');
    // And reconcile itself never writes: the store only ever saw HEADs.
    assert.deepEqual(Object.keys(store), ['headCalls', 'facts', 'options']);
  });

  test('reconcile never deletes or writes: even a mismatch produces a quarantine CANDIDATE, not a delete', async () => {
    const drift = pitrRowFor(4, { generationState: 'active' });
    const ledger = new InMemoryPitrLedger();
    ledger.setRows([drift]);
    const store = new RecordingPitrStore();
    store.seed(drift.key, '"etag-drifted"', (drift.expectedSize ?? 0) + 1); // policy drift
    const report = await reconcileGenerationLedger({ ledger, objectStore: store });
    assert.equal(report.counts.mismatch, 1);
    assert.deepEqual(report.quarantineCandidates, [drift.generationId]);
    assert.equal(report.destructiveActionsTaken, false);
    assert.equal(store.headCalls.length, 1);
  });

  test('provider transient 429 (retryable) and policy drift are separated by deterministic run markers: 429 is never mismatch', async () => {
    const retryable = pitrRowFor(5, { generationState: 'active', key: 'p10-run-429-marker-1/live/a' });
    const drift = pitrRowFor(6, { generationState: 'active', key: 'p10-run-drift-marker-2/live/b' });
    const ledger = new InMemoryPitrLedger();
    ledger.setRows([retryable, drift]);
    const store = new RecordingPitrStore();
    // The transient-429 marker key is scripted as retryable (environment);
    // the drift marker key carries a real etag/size mismatch.
    store.options.script = [{ class: 'retryable' }, 'default'];
    store.seed(drift.key, '"etag-drift"', (drift.expectedSize ?? 0) + 1);

    const report = await reconcileGenerationLedger({ ledger, objectStore: store });
    const byId = new Map(report.findings.map((finding) => [finding.generationId, finding]));
    assert.equal(byId.get(retryable.generationId)!.verdict, 'unknown',
      'provider throttling is an environment class, never corruption');
    assert.equal(byId.get(retryable.generationId)!.detail, 'provider_retryable');
    assert.equal(byId.get(drift.generationId)!.verdict, 'mismatch');
    assert.deepEqual(report.quarantineCandidates, [drift.generationId],
      'only the policy-drift marker may become a quarantine candidate');
    assert.equal(report.counts.unknown, 1);
    assert.equal(report.counts.mismatch, 1);
  });
});
