import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  buildSyncRouteAuthorityContext,
  sameSyncRouteLineage,
  syncPullCursorContext,
} from '../../../src/modules/sync/index.js';

const authority = buildSyncRouteAuthorityContext({ accountId: 'account-1', collectionId: 'collection-1',
  replicaId: 'replica-1', sessionId: 'session-bootstrap', leaseGeneration: '2',
  lifecycleRevision: '7', policyRevision: 'policy-r1', protocolVersion: '0.2' });

test('builds the exact cross-route Pull authority without route-local defaults', () => {
  assert.deepEqual(Object.keys(buildSyncRouteAuthorityContext({ ...authority,
    routeLocalDefault: 'must-not-escape' } as typeof authority)).sort(), [
    'accountId', 'collectionId', 'leaseGeneration', 'lifecycleRevision', 'policyRevision',
    'protocolVersion', 'replicaId', 'sessionId',
  ]);
  assert.deepEqual(syncPullCursorContext(authority,
    { commitOrdinal: '43', streamKind: 'operation', stableId: 'operation-43' }, 100), {
    replicaId: 'replica-1', collectionId: 'collection-1', leaseGeneration: '2',
    sessionId: 'session-bootstrap', principalId: 'account-1', protocolVersion: '0.2',
    policyRevision: 'policy-r1',
    purgeBoundary: { commitOrdinal: '43', streamKind: 'operation', stableId: 'operation-43' }, limit: 100,
  });
});

test('permits a proof-backed Session handoff only on the same monotonic authority lineage', () => {
  const active = buildSyncRouteAuthorityContext({ ...authority, sessionId: 'session-active',
    lifecycleRevision: '8' });
  assert.equal(sameSyncRouteLineage(authority, active), true);
  for (const changed of [
    { accountId: 'account-2' }, { collectionId: 'collection-2' }, { replicaId: 'replica-2' },
    { leaseGeneration: '3' },
    { policyRevision: 'policy-r2' }, { protocolVersion: '0.1' as const },
    { lifecycleRevision: '6' },
  ]) assert.equal(sameSyncRouteLineage(authority,
    buildSyncRouteAuthorityContext({ ...active, ...changed })), false);
});

test('rejects invalid page limits and authority counters before signing', () => {
  assert.throws(() => syncPullCursorContext(authority,
    { commitOrdinal: '0', streamKind: 'operation', stableId: '' }, 0));
  assert.throws(() => buildSyncRouteAuthorityContext({ ...authority, leaseGeneration: '01' }));
});
