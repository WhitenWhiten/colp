import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  classifySequenceReuse,
  logicalOperationIdentity,
  type SequenceReuseFacts,
} from '../src/logical-operation-identity.js';

const matching: SequenceReuseFacts = {
  code: 'sequence_reuse',
  authValid: true,
  accountMatches: true,
  collectionMatches: true,
  replicaMatches: true,
  replicaLifecycle: 'active',
  generationMatches: true,
  sequenceMatches: true,
  opIdMatches: true,
  operationBytesMatch: true,
  isLocalPendingInScope: true,
  clientResultUnknown: false,
};

describe('C-01 logical operation vs HTTP attempt', () => {
  test('rejects a different account, collection, retired replica, or changed Operation bytes', () => {
    assert.equal(classifySequenceReuse({ ...matching, accountMatches: false }), 'illegal');
    assert.equal(classifySequenceReuse({ ...matching, collectionMatches: false }), 'illegal');
    assert.equal(classifySequenceReuse({ ...matching, replicaMatches: false }), 'illegal');
    assert.equal(classifySequenceReuse({ ...matching, replicaLifecycle: 'retired' }), 'illegal');
    assert.equal(classifySequenceReuse({ ...matching, generationMatches: false }), 'illegal');
    assert.equal(classifySequenceReuse({ ...matching, operationBytesMatch: false }), 'illegal');
    assert.equal(classifySequenceReuse({ ...matching, authValid: false }), 'illegal');
    assert.equal(classifySequenceReuse({ ...matching, isLocalPendingInScope: false }), 'illegal');
  });

  test('does not treat sequence_reuse or op_id_reused as did-not-execute', () => {
    assert.notEqual(classifySequenceReuse(matching), 'did_not_execute');
    assert.notEqual(classifySequenceReuse({ ...matching, code: 'op_id_reused' }), 'did_not_execute');
    assert.equal(classifySequenceReuse(matching), 'reconcile');
    assert.equal(classifySequenceReuse({ ...matching, clientResultUnknown: true }), 'unknown');
    assert.equal(classifySequenceReuse({ ...matching, code: 'op_id_reused', clientResultUnknown: true }), 'unknown');
  });

  test('logical identity ignores HTTP session, bearer, batch, and request date', () => {
    const identity = logicalOperationIdentity({
      serverId: 'server-a',
      accountId: 'account-a',
      collectionId: 'collection-a',
      replicaId: 'replica-a',
      generation: 1,
      sequenceScope: 'collection-a',
      sequence: 8,
      opId: 'op-1',
      atomic: true,
      operationDigest: 'sha256:canonical-op',
    });
    assert.equal('sessionId' in identity, false);
    assert.equal('batchId' in identity, false);
    assert.equal('idempotencyKey' in identity, false);
    assert.equal(identity.operationDigest, 'sha256:canonical-op');
    assert.equal(identity.sequence, 8);
  });
});
