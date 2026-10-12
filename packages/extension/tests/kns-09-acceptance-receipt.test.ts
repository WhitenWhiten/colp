/**
 * Owner: KNS-09 (Release). Formal IDs: FR-RECEIPT-REJECT.
 * Run: npx vitest run tests/kns-09-acceptance-receipt.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, test } from 'vitest';
import { DATABASE_VERSION } from '../src/sync-state/schema.js';
import {
  evaluateAcceptance, indexedDbPin, inputDirtyPaths, REQUIRED_GATE_IDS, rollbackPin,
} from '../scripts/kns-09-acceptance-lib.mjs';

const sha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const passing = REQUIRED_GATE_IDS.map((id: string) => ({
  id, command: `npm run ${id}`, exitCode: 0, status: 'passed', testedCommit: sha,
}));

describe('KNS-09 acceptance receipt rejects incomplete gates', () => {
  test('accepts only a complete same-SHA pass set with a clean input tree', () => {
    const result = evaluateAcceptance({
      expectedCommit: sha, testedCommit: sha, gates: passing, dirtyInputPaths: [],
    });
    assert.equal(result.verdict, 'accepted');
    assert.deepEqual(result.reasons, []);
  });

  test('FR-RECEIPT-REJECT: typecheck failure cannot be accepted', () => {
    const gates = passing.map((gate) => (gate.id === 'extension.typecheck'
      ? { ...gate, exitCode: 1, status: 'failed' } : gate));
    const result = evaluateAcceptance({
      expectedCommit: sha, testedCommit: sha, gates, dirtyInputPaths: [],
    });
    assert.equal(result.verdict, 'rejected');
    assert.ok(result.reasons.includes('failed:extension.typecheck'));
    assert.ok(result.reasons.includes('exit:extension.typecheck'));
  });

  test('FR-RECEIPT-REJECT: E2E failure or skip cannot be accepted', () => {
    const failed = evaluateAcceptance({
      expectedCommit: sha, testedCommit: sha,
      gates: passing.map((gate) => (gate.id === 'extension.e2e-first-run-sync'
        ? { ...gate, exitCode: 1, status: 'failed' } : gate)),
      dirtyInputPaths: [],
    });
    assert.equal(failed.verdict, 'rejected');
    assert.ok(failed.reasons.includes('failed:extension.e2e-first-run-sync'));
    const skipped = evaluateAcceptance({
      expectedCommit: sha, testedCommit: sha,
      gates: passing.map((gate) => (gate.id === 'extension.e2e-trash-restore'
        ? { ...gate, exitCode: 0, status: 'skipped' } : gate)),
      dirtyInputPaths: [],
    });
    assert.equal(skipped.verdict, 'rejected');
    assert.ok(skipped.reasons.includes('skipped:extension.e2e-trash-restore'));
    const cancelled = evaluateAcceptance({
      expectedCommit: sha, testedCommit: sha,
      gates: passing.map((gate) => (gate.id === 'extension.e2e-first-run-sync'
        ? { ...gate, exitCode: 0, status: 'cancelled' } : gate)),
      dirtyInputPaths: [],
    });
    assert.equal(cancelled.verdict, 'rejected');
    assert.ok(cancelled.reasons.includes('cancelled:extension.e2e-first-run-sync'));
  });

  test('FR-RECEIPT-REJECT: missing gates or SHA mismatch cannot be accepted', () => {
    const missing = evaluateAcceptance({
      expectedCommit: sha, testedCommit: sha, gates: passing.slice(0, 3), dirtyInputPaths: [],
    });
    assert.equal(missing.verdict, 'rejected');
    assert.ok(missing.reasons.some((reason) => reason.startsWith('missing:')));
    const mismatch = evaluateAcceptance({
      expectedCommit: sha, testedCommit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      gates: passing, dirtyInputPaths: [],
    });
    assert.equal(mismatch.verdict, 'rejected');
    assert.ok(mismatch.reasons.includes('tested_commit_mismatch'));
  });

  test('dirty production or test inputs cannot be accepted; artifacts can', () => {
    const dirty = evaluateAcceptance({
      expectedCommit: sha, testedCommit: sha, gates: passing,
      dirtyInputPaths: ['packages/extension/src/outbound-push-worker.ts'],
    });
    assert.equal(dirty.verdict, 'rejected');
    assert.ok(dirty.reasons.includes('dirty_input_tree'));
    assert.deepEqual(inputDirtyPaths([
      ' M packages/extension/src/outbound-push-worker.ts',
      '?? test-results/known-extension-first-run-sync/sha/gate-results.json',
      ' M packages/extension/coverage/sync/coverage-summary.json',
    ].join('\n')), ['packages/extension/src/outbound-push-worker.ts']);
  });

  test('scripts pin manifest vs acceptance and refuse a hardcoded accepted list', () => {
    const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8')) as {
      readonly scripts?: Readonly<Record<string, string>>;
    };
    assert.match(pkg.scripts?.['evidence:kns-09-release'] ?? '', /kns-09:manifest/);
    assert.doesNotMatch(pkg.scripts?.['evidence:kns-09-release'] ?? '', /kns-09:receipt/);
    assert.match(pkg.scripts?.['evidence:kns-09-acceptance'] ?? '', /kns-09:receipt/);
    const acceptance = readFileSync(resolve(import.meta.dirname, '../scripts/kns-09-acceptance-receipt.mjs'), 'utf8');
    assert.match(acceptance, /evaluateAcceptance/);
    assert.match(acceptance, /verdict !== 'accepted'/);
    assert.doesNotMatch(acceptance, /verdict:\s*'accepted'/);
  });

  test('FRR-09b: receipt JSON indexedDb.version matches runtime schema', () => {
    const schema = readFileSync(resolve(import.meta.dirname, '../src/sync-state/schema.ts'), 'utf8');
    const pin = indexedDbPin(schema);
    assert.equal(pin.version, DATABASE_VERSION);
    assert.equal(pin.version, 20);
    const envelope = {
      indexedDb: pin,
      rollback: rollbackPin(pin.version),
      featureFlags: { rollbackToV9Binary: false },
    };
    const parsed = JSON.parse(JSON.stringify(envelope)) as typeof envelope;
    assert.equal(parsed.indexedDb.name, 'known-phase3-indexeddb-entry');
    assert.equal(parsed.indexedDb.version, 20);
    assert.match(parsed.rollback, /v19 over v20/);
    const receipt = readFileSync(resolve(import.meta.dirname, '../scripts/kns-09-acceptance-receipt.mjs'), 'utf8');
    const manifest = readFileSync(resolve(import.meta.dirname, '../scripts/kns-09-release-manifest.mjs'), 'utf8');
    assert.match(receipt, /indexedDb,/);
    assert.match(manifest, /indexedDb,/);
    assert.doesNotMatch(receipt, /version: 11/);
    assert.doesNotMatch(manifest, /version: 13/);
  });
});
