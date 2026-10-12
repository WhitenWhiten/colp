import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  classifyNativeCallFacts,
  intentOwnerKey,
  readStoredNativeResult,
  readStoredReplayState,
} from '../src/native-call-result.js';

describe('C-02 Chrome call not_started vs result_unknown', () => {
  test('classifies the durable create/delete fact table', () => {
    assert.equal(classifyNativeCallFacts({
      intentExists: true, callStarted: false, nativeEventCorrelationOnly: false,
      deleteTargetProvenAbsent: false, permissionOrManagedOrOtherError: false, waitingDependency: false,
    }), 'not_started');
    assert.equal(classifyNativeCallFacts({
      intentExists: true, callStarted: true, apiReturnNativeId: 'native-1',
      nativeEventCorrelationOnly: false, deleteTargetProvenAbsent: false,
      permissionOrManagedOrOtherError: false, waitingDependency: false,
    }), 'applied_with_evidence');
    assert.equal(classifyNativeCallFacts({
      intentExists: true, callStarted: true, nativeEventCorrelationOnly: true,
      newcomerCount: 1, deleteTargetProvenAbsent: false,
      permissionOrManagedOrOtherError: false, waitingDependency: false,
    }), 'result_unknown');
    assert.equal(classifyNativeCallFacts({
      intentExists: true, callStarted: true, nativeEventCorrelationOnly: false,
      newcomerCount: 0, deleteTargetProvenAbsent: false,
      permissionOrManagedOrOtherError: false, waitingDependency: false,
    }), 'result_unknown');
    assert.equal(classifyNativeCallFacts({
      intentExists: true, callStarted: true, nativeEventCorrelationOnly: false,
      newcomerCount: 1, deleteTargetProvenAbsent: false,
      permissionOrManagedOrOtherError: false, waitingDependency: false,
    }), 'result_unknown');
    assert.equal(classifyNativeCallFacts({
      intentExists: true, callStarted: true, nativeEventCorrelationOnly: false,
      deleteTargetProvenAbsent: true, permissionOrManagedOrOtherError: false, waitingDependency: false,
    }), 'absent');
    assert.equal(classifyNativeCallFacts({
      intentExists: true, callStarted: true, nativeEventCorrelationOnly: false,
      deleteTargetProvenAbsent: false, permissionOrManagedOrOtherError: true, waitingDependency: false,
    }), 'failed');
    assert.equal(classifyNativeCallFacts({
      intentExists: true, callStarted: false, nativeEventCorrelationOnly: false,
      deleteTargetProvenAbsent: false, permissionOrManagedOrOtherError: false, waitingDependency: true,
    }), 'waiting_dependency');
  });

  test('permission and managed errors are not absent', () => {
    const result = classifyNativeCallFacts({
      intentExists: true, callStarted: true, nativeEventCorrelationOnly: false,
      deleteTargetProvenAbsent: true, permissionOrManagedOrOtherError: true, waitingDependency: false,
    });
    assert.equal(result, 'failed');
    assert.notEqual(result, 'absent');
  });

  test('missing persisted fields read as unknown, not applied_with_evidence', () => {
    assert.equal(readStoredNativeResult({}), 'unknown');
    assert.equal(readStoredNativeResult({ nativeResult: 'applied_with_evidence' }), 'applied_with_evidence');
    assert.notEqual(readStoredNativeResult({}), 'applied_with_evidence');
    assert.equal(readStoredReplayState({}), 'unknown');
    assert.notEqual(readStoredReplayState({}), 'committed');
  });

  test('two legal nodes with the same parent/title/URL use different intent owners', () => {
    const shared = {
      scopeKey: 'scope-a', generation: 1, commandId: 'pull', eventId: 'event-1', substep: 'create',
    };
    const left = intentOwnerKey({ ...shared, colpId: 'node-a' });
    const right = intentOwnerKey({ ...shared, colpId: 'node-b' });
    assert.notEqual(left, right);
    assert.equal(intentOwnerKey({ ...shared, colpId: 'node-a' }), left);
  });
});
