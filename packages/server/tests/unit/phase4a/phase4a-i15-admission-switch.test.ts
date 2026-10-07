/**
 * P4A-I15 durable admission switch: stop / drain / resume with lease fencing.
 *
 * Proves (in-memory store with the same CAS semantics as PostgreSQL):
 *  - initial state allows issuance;
 *  - stopAdmissionAndDrain persists admissionEnabled=false + drain=true with a
 *    lease (owner, generation, expiry) and closes the issuance gate;
 *  - stopping again by the same operator is idempotent (already_stopped);
 *  - a second operator is fenced out while the lease is active
 *    (lease_conflict) and can take over only after the lease expires;
 *  - resumeAdmission restores admissionEnabled=true and reopens the gate, and
 *    is fenced the same way;
 *  - invalid reasons fail closed;
 *  - maintenanceActive() is true only while the switch is stopped;
 *  - issueUploadIntentWithAdmissionGate refuses BEFORE any use-case work when
 *    the switch is stopped (the underlying use case is never invoked).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  admissionAllowsIssuance,
  admissionMaintenanceActive,
  issueUploadIntentWithAdmissionGate,
  readAdmissionState,
  resumeAdmission,
  stopAdmissionAndDrain,
  type AttachmentsAdmissionSwitchState,
} from '../../../src/modules/attachments/index.js';
import {
  InMemoryAdmissionSwitchStore,
  makeAdmissionState,
} from '../../support/phase4a-i15-test-helpers.js';
import { makeI14Config } from '../../support/phase4a-i14-test-helpers.js';

const NOW = new Date('2026-08-08T00:00:00.000Z');
const TTL_SECONDS = 60;

function deps(store: InMemoryAdmissionSwitchStore) {
  return { store, now: () => NOW };
}

function leaseExpired(state: AttachmentsAdmissionSwitchState): AttachmentsAdmissionSwitchState {
  // 30 seconds BEFORE the injected clock -> the lease has expired.
  return { ...state, leaseExpiresAtIso: '2026-08-07T23:59:30.000Z' };
}

describe('P4A-I15 admission switch semantics', () => {
  test('initial state allows issuance and is not maintenance', () => {
    const state = makeAdmissionState();
    assert.equal(admissionAllowsIssuance(state), true);
    assert.equal(admissionMaintenanceActive(state), false);
  });

  test('stopAdmissionAndDrain closes the gate with a durable lease', async () => {
    const store = new InMemoryAdmissionSwitchStore();
    const result = await stopAdmissionAndDrain(deps(store), {
      reason: 'rotation', operatorId: 'operator-a', leaseTtlSeconds: TTL_SECONDS,
    });
    assert.equal(result.outcome, 'stopped');
    if (result.outcome !== 'stopped') return;
    assert.equal(result.state.admissionEnabled, false);
    assert.equal(result.state.drainVerification, true);
    assert.equal(result.state.reason, 'rotation');
    assert.equal(result.state.leaseOwner, 'operator-a');
    assert.equal(result.state.leaseGeneration, '1');
    assert.ok(result.state.leaseExpiresAtIso);
    assert.equal(admissionAllowsIssuance(result.state), false);
    assert.equal(admissionMaintenanceActive(result.state), true);
    // Durable: a fresh read (new connection) observes the same state.
    const reread = await readAdmissionState(deps(store));
    assert.equal(reread.admissionEnabled, false);
    assert.equal(reread.drainVerification, true);
  });

  test('stopping again by the same operator is idempotent', async () => {
    const store = new InMemoryAdmissionSwitchStore();
    const first = await stopAdmissionAndDrain(deps(store), { reason: 'maintenance', operatorId: 'operator-a', leaseTtlSeconds: TTL_SECONDS });
    assert.equal(first.outcome, 'stopped');
    const second = await stopAdmissionAndDrain(deps(store), { reason: 'maintenance', operatorId: 'operator-a', leaseTtlSeconds: TTL_SECONDS });
    assert.equal(second.outcome, 'already_stopped');
    if (second.outcome !== 'already_stopped') return;
    assert.equal(second.state.leaseOwner, 'operator-a');
  });

  test('a second operator is fenced out while the lease is active', async () => {
    const store = new InMemoryAdmissionSwitchStore();
    await stopAdmissionAndDrain(deps(store), { reason: 'incident', operatorId: 'operator-a', leaseTtlSeconds: TTL_SECONDS });
    const blocked = await stopAdmissionAndDrain(deps(store), { reason: 'incident', operatorId: 'operator-b', leaseTtlSeconds: TTL_SECONDS });
    assert.equal(blocked.outcome, 'lease_conflict');
    if (blocked.outcome !== 'lease_conflict') return;
    assert.equal(blocked.reason, 'held_by_another_operator');
  });

  test('after the lease expires a new operator can take over', async () => {
    const store = new InMemoryAdmissionSwitchStore();
    await stopAdmissionAndDrain(deps(store), { reason: 'incident', operatorId: 'operator-a', leaseTtlSeconds: TTL_SECONDS });
    // Lease expiry (the new operator observes an expired lease) -> takeover.
    store.setRow(leaseExpired((await readAdmissionState(deps(store)))));
    const takeover = await stopAdmissionAndDrain(deps(store), { reason: 'incident', operatorId: 'operator-b', leaseTtlSeconds: TTL_SECONDS });
    assert.equal(takeover.outcome, 'stopped');
    if (takeover.outcome !== 'stopped') return;
    assert.equal(takeover.state.leaseOwner, 'operator-b');
    assert.equal(takeover.state.leaseGeneration, '2', 'takeover bumps the lease generation');
  });

  test('resumeAdmission restores issuance and reopens the gate', async () => {
    const store = new InMemoryAdmissionSwitchStore();
    await stopAdmissionAndDrain(deps(store), { reason: 'rotation', operatorId: 'operator-a', leaseTtlSeconds: TTL_SECONDS });
    const resumed = await resumeAdmission(deps(store), { operatorId: 'operator-a' });
    assert.equal(resumed.outcome, 'resumed');
    if (resumed.outcome !== 'resumed') return;
    assert.equal(resumed.state.admissionEnabled, true);
    assert.equal(resumed.state.drainVerification, false);
    assert.equal(resumed.state.leaseOwner, null);
    assert.equal(resumed.state.reason, null);
    assert.equal(admissionAllowsIssuance(resumed.state), true);
    assert.equal(admissionMaintenanceActive(resumed.state), false);
    // Resuming again is idempotent.
    const again = await resumeAdmission(deps(store), { operatorId: 'operator-a' });
    assert.equal(again.outcome, 'already_resumed');
  });

  test('resume is fenced against a non-owner operator', async () => {
    const store = new InMemoryAdmissionSwitchStore();
    await stopAdmissionAndDrain(deps(store), { reason: 'maintenance', operatorId: 'operator-a', leaseTtlSeconds: TTL_SECONDS });
    const blocked = await resumeAdmission(deps(store), { operatorId: 'operator-b' });
    assert.equal(blocked.outcome, 'lease_conflict');
    if (blocked.outcome !== 'lease_conflict') return;
    assert.equal(blocked.reason, 'held_by_another_operator');
  });

  test('invalid reasons fail closed', async () => {
    const store = new InMemoryAdmissionSwitchStore();
    const result = await stopAdmissionAndDrain(deps(store), {
      reason: 'arbitrary' as never, operatorId: 'operator-a', leaseTtlSeconds: TTL_SECONDS,
    });
    assert.equal(result.outcome, 'invalid_reason');
    assert.equal(admissionAllowsIssuance(await readAdmissionState(deps(store))), true, 'nothing may change on an invalid reason');
  });

  test('issueUploadIntentWithAdmissionGate refuses BEFORE any use-case work when stopped', async () => {
    const store = new InMemoryAdmissionSwitchStore();
    await stopAdmissionAndDrain(deps(store), { reason: 'maintenance', operatorId: 'operator-a', leaseTtlSeconds: TTL_SECONDS });
    const config = makeI14Config();
    const untouchedDeps = {
      ledger: {} as never,
      accessPolicyFor: (() => { throw new Error('must not be invoked'); }) as never,
      blobStore: {} as never,
      // If the use case were invoked, this would throw and fail the test.
      uow: { execute: async () => { throw new Error('use_case_invoked_while_stopped'); } },
      crypto: {} as never,
      config,
    };
    const result = await issueUploadIntentWithAdmissionGate({
      ...untouchedDeps,
      admissionState: async () => readAdmissionState(deps(store)),
    }, {
      actor: { principalId: 'p', subjectId: 's', kind: 'account' },
      collectionId: 'collection',
      idempotencyKey: 'idem',
      declaredSize: 7,
    });
    assert.deepEqual(result, { outcome: 'admission_stopped' });
  });
});