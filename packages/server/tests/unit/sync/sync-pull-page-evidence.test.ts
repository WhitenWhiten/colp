import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'vitest';
import {
  prepareIssuedCursorEvidenceItems,
  selectPersistedIssuedCursorItems,
  type CursorEvidenceAuthorityFacts,
} from '../../../src/infrastructure/sync/postgres/sync-pull-postgres.js';
import { createSyncPullCursorKeyring, type SyncPullCursorContext } from '../../../src/modules/sync/index.js';

const context: SyncPullCursorContext = Object.freeze({
  replicaId: 'replica-1', collectionId: 'collection-1', leaseGeneration: '7',
  sessionId: 'session-1', principalId: 'account-1', protocolVersion: '0.1',
  policyRevision: 'policy-4', limit: 2,
  purgeBoundary: { commitOrdinal: '0', streamKind: 'operation', stableId: '' },
});
const authority: CursorEvidenceAuthorityFacts = Object.freeze({
  accountId: 'account-1', collectionId: 'collection-1', replicaId: 'replica-1',
  leaseGeneration: '7', policyRevision: 'policy-4', collectionRevision: 'content-r1',
  protocolVersion: '0.1',
});

test('selectPersistedIssuedCursorItems keeps one next-cursor row after verifying the whole page', () => {
  const keys = createSyncPullCursorKeyring({
    active: { id: 'page-unit', secret: Buffer.alloc(32, 53).toString('base64') },
    retained: [], ttlMs: 60_000, now: () => 1_000,
  });
  const tupleOne = Object.freeze({ commitOrdinal: '10', streamKind: 'operation' as const, stableId: 'op-10' });
  const tupleTwo = Object.freeze({ commitOrdinal: '11', streamKind: 'conflict' as const, stableId: 'conflict-11' });
  const cursorOne = keys.sign({ ...context, tuple: tupleOne });
  const cursorTwo = keys.sign({ ...context, tuple: tupleTwo });
  const prepared = prepareIssuedCursorEvidenceItems({
    visible: [
      { commitOrdinal: '10', streamKind: 'operation', stableId: 'op-10' },
      { commitOrdinal: '11', streamKind: 'conflict', stableId: 'conflict-11' },
    ],
    eventCursors: [cursorOne, cursorTwo],
    nextCursor: cursorTwo,
    pageUpperTuple: tupleTwo,
    keyring: keys,
    context,
    authority,
  });
  assert.equal(prepared.items.length, 2);
  const persisted = selectPersistedIssuedCursorItems(prepared);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0]?.digest, createHash('sha256').update(cursorTwo, 'utf8').digest('hex'));
  assert.equal(keys.verify(cursorOne, context).valid, true);
  keys.destroy();
});
