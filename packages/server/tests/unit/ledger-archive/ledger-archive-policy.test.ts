import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'vitest';

import { LEDGER_ARCHIVE_STATES } from '../../../src/infrastructure/database/ledger-archive-segment-repository.js';
import {
  ARCHIVE_HOT_SOURCE_STATES,
  ARCHIVE_OBJECT_STATES,
  ARCHIVE_READ_STATES,
  evaluateLedgerArchivePolicy,
  evaluateLedgerArchivePolicyFromLinear,
  lifecycleFromLinearState,
  lifecycleMatchesLinear,
  type LedgerArchivePolicy,
} from '../../../src/infrastructure/database/ledger-archive-policy.js';

const LINEAR_EXPECTATIONS = Object.freeze({
  open: { canReadObject: false, canHydratePayload: false, canCutoverReader: false, canAdvanceFloor: false },
  sealed: { canReadObject: false, canHydratePayload: false, canCutoverReader: false, canAdvanceFloor: false },
  exported: { canReadObject: false, canHydratePayload: false, canCutoverReader: false, canAdvanceFloor: false },
  verified: { canReadObject: true, canHydratePayload: false, canCutoverReader: true, canAdvanceFloor: true },
  reader_cutover: { canReadObject: true, canHydratePayload: true, canCutoverReader: false, canAdvanceFloor: true },
  detached: { canReadObject: true, canHydratePayload: true, canCutoverReader: false, canAdvanceFloor: true },
  deletable: { canReadObject: true, canHydratePayload: true, canCutoverReader: false, canAdvanceFloor: true },
  deleted: { canReadObject: false, canHydratePayload: false, canCutoverReader: false, canAdvanceFloor: true },
} as const);

describe('SYNC-Q-007 LedgerArchivePolicy', () => {
  test('maps every linear state and holds legal hold independent of object/read/hot source', () => {
    for (const state of LEDGER_ARCHIVE_STATES) {
      const expected = LINEAR_EXPECTATIONS[state];
      const clear = evaluateLedgerArchivePolicyFromLinear(state, false);
      assert.deepEqual(pick(clear), expected, state);
      assert.equal(clear.canPurgeHot, clear.canCutoverHot);
      assert.equal(clear.canDetachHot, clear.canCutoverHot);
      assert.equal(clear.canConfirmExport, clear.canAdvanceFloor);
      const held = evaluateLedgerArchivePolicyFromLinear(state, true);
      assert.equal(held.canReadObject, clear.canReadObject);
      assert.equal(held.canHydratePayload, clear.canHydratePayload);
      assert.equal(held.canAdvanceFloor, clear.canAdvanceFloor);
      assert.equal(held.canCutoverReader, false);
      assert.equal(held.canPurgeHot, false);
      assert.equal(held.canDeleteObject, false);
      assert.ok(lifecycleMatchesLinear(state, lifecycleFromLinearState(state)));
    }
    assert.throws(() => lifecycleFromLinearState('unknown'), /no lifecycle mapping/);
  });

  test('enumerates the orthogonal cartesian product without a local adapter whitelist', () => {
    const seen = new Set<string>();
    for (const objectState of ARCHIVE_OBJECT_STATES) {
      for (const readState of ARCHIVE_READ_STATES) {
        for (const hotSourceState of ARCHIVE_HOT_SOURCE_STATES) {
          for (const legalHold of [false, true]) {
            const policy = evaluateLedgerArchivePolicy({
              objectState, readState, hotSourceState, legalHold,
            });
            seen.add(`${objectState}:${readState}:${hotSourceState}:${legalHold}`);
            assert.equal(policy.canReadObject, objectState === 'verified'
              && (readState === 'verified' || readState === 'cutover'));
            assert.equal(policy.canHydratePayload, objectState === 'verified' && readState === 'cutover');
            assert.equal(policy.canCutoverReader, objectState === 'verified'
              && readState === 'verified' && hotSourceState === 'attached' && !legalHold);
            assert.equal(policy.canCutoverHot, objectState === 'verified'
              && readState === 'cutover' && hotSourceState === 'attached' && !legalHold);
          }
        }
      }
    }
    assert.equal(seen.size, ARCHIVE_OBJECT_STATES.length * ARCHIVE_READ_STATES.length
      * ARCHIVE_HOT_SOURCE_STATES.length * 2);
  });

  test('adapters and SQL policy share the same decision names and drop local state arrays', async () => {
    const cold = await readFile(new URL(
      '../../../src/infrastructure/ledger-archive/cold-reader.ts', import.meta.url), 'utf8');
    const payload = await readFile(new URL(
      '../../../src/infrastructure/ledger-archive/payload-cold-sources.ts', import.meta.url), 'utf8');
    const audit = await readFile(new URL(
      '../../../src/infrastructure/database/audit-event-payload.ts', import.meta.url), 'utf8');
    const migration = await readFile(new URL(
      '../../../migrations/202610011100_ledger_archive_orthogonal_lifecycle.ts', import.meta.url), 'utf8');
    assert.match(cold, /evaluateLedgerArchivePolicyFromLinear/);
    assert.match(payload, /canHydratePayload/);
    assert.doesNotMatch(payload, /function readerCutoverState/);
    assert.match(audit, /evaluateLedgerArchivePolicyFromLinear/);
    assert.doesNotMatch(audit, /\['reader_cutover', 'detached', 'deletable'\]/);
    assert.match(migration, /ledger_archive_policy_decisions/);
    assert.match(migration, /object-deletion receipt/);
  });
});

function pick(policy: LedgerArchivePolicy) {
  return {
    canReadObject: policy.canReadObject,
    canHydratePayload: policy.canHydratePayload,
    canCutoverReader: policy.canCutoverReader,
    canAdvanceFloor: policy.canAdvanceFloor,
  };
}
