import { describe, expect, it } from 'vitest';

import type { AuthoritativePullEffect, Operation, SyncPullEventV02 } from '../../src/types/index.js';
import {
  canonicalAuthoritativeEffectDigest, canonicalOperationDigest, validateAuthoritativePullEvent,
  type PushPreparedOperation, type SyncPullCursorRecord, type SyncPullCursorStore,
  type SyncPullEventStore, type SyncPullRequestContext,
} from '../../src/sync/index.js';
import { coordinatePushTransaction, coordinateSyncPull } from '../../src/sync/unsafe.js';
import {
  DurableContractHandle, type Audit, type Conflict, type Outbox, type TestTransaction,
} from './push-transaction-harness.js';
import { folderNode, placement, parentRevision, operationBase } from './authoritative-effect-binding-fixture.js';

function event(memberCount: number): Extract<SyncPullEventV02, { operation: { type: 'create_node' } }> {
  const extensions = { 'https://example.com/ext': Object.fromEntries(
    Array.from({ length: memberCount }, (_, index) => [`k${index}`, index]),
  ) };
  const operation: Extract<Operation, { type: 'create_node' }> = {
    // Push-owned lanes now admit only the next durable Sequence. This fixture
    // starts from an empty lane, so make its first operation explicit.
    ...operationBase, sequence: 1, type: 'create_node', baseRevision: null,
    payload: { parentId: placement.parentId, afterId: null, beforeId: null,
      node: { kind: 'folder', title: 'Node', extensions } },
  };
  const input = {
    effectId: 'effect-1', status: 'applied' as const, opId: operation.opId,
    replicaId: operation.replicaId, sequence: operation.sequence,
    collectionId: operation.collectionId, operationDigest: canonicalOperationDigest(operation),
    effectDigest: '', kind: 'node_created' as const, node: { ...folderNode, extensions },
    placement, parentRevision, nodeChildrenRevision: 'cr-node-1',
  };
  return { cursor: 'cursor-1', kind: 'operation', operation,
    effect: { ...input, effectDigest: canonicalAuthoritativeEffectDigest(input) } };
}

function stores(source: SyncPullEventV02, request: SyncPullRequestContext) {
  const cursorStore: SyncPullCursorStore = {
    resolveCursor: async (cursor): Promise<SyncPullCursorRecord> => ({
      cursor, sessionId: request.sessionId, principal: request.principal,
      collectionId: request.collectionId, protocolVersion: request.protocolVersion,
      commitOrdinal: cursor === 'cursor-0' ? '0' : '1', state: 'active',
    }),
  };
  const eventStore: SyncPullEventStore = {
    readCommittedAfter: async ({ afterCommitOrdinal }) => ({
      entries: afterCommitOrdinal === '0' ? [{ commitOrdinal: '1', event: source }] : [],
      hasMore: false, collectionRevision: 'r2', recommendedPullAfterSeconds: 30,
    }),
  };
  return { cursorStore, eventStore };
}

describe('0.2 Pull budgets operation and effect independently', () => {
  it.each([6_000, 9_950])('delivers a Push accepted %i-member extension and continues from its cursor', async (members) => {
    const source = event(members);
    const adapter = new DurableContractHandle();
    const preflight = async (): Promise<PushPreparedOperation<TestTransaction, Conflict, Audit, Outbox>> => ({
      status: 'applied',
      apply: async (transaction) => {
        await transaction.putBusiness('created-node');
        return { opId: source.operation.opId, sequence: source.operation.sequence,
          status: 'applied', revision: 'r2', warnings: [] };
      },
      audit: async () => ({ id: 'audit', result: { status: 'applied' } }),
      outbox: async ({ cursor }) => ({ id: 'outbox', cursor: cursor! }),
    });
    await coordinatePushTransaction(adapter, {
      batchId: 'batch-1', atomic: false, serverCursor: 'cursor-0',
      operations: [{ operation: source.operation, sequenceScope: 'collection-1',
        digest: canonicalOperationDigest(source.operation) }],
    }, preflight);
    expect(adapter.backend.state.operations).toHaveLength(1);
    expect(validateAuthoritativePullEvent(source, '0.2')).toEqual(source);
    for (const principalId of ['alice', 'bob']) {
      const request: SyncPullRequestContext = {
        sessionId: `session-${principalId}`, principal: { type: 'user', id: principalId },
        collectionId: 'collection-1', protocolVersion: '0.2', cursor: 'cursor-0', limit: 1,
      };
      const { cursorStore, eventStore } = stores(source, request);
      const result = await coordinateSyncPull(request, cursorStore, eventStore);
      expect(result).toMatchObject({ ok: true, body: { events: [source], nextCursor: source.cursor } });
      expect(Object.isFrozen(result)).toBe(true);
      await expect(coordinateSyncPull({ ...request, cursor: source.cursor }, cursorStore, eventStore))
        .resolves.toMatchObject({ ok: true, body: { events: [], nextCursor: source.cursor } });
    }
  });

  it.each(['operation', 'effect'] as const)('still rejects an over-budget individual %s', (part) => {
    const source = event(1);
    const extensions = { 'https://example.com/ext': Object.fromEntries(
      Array.from({ length: 10_001 }, (_, index) => [`k${index}`, index]),
    ) };
    const oversized = part === 'operation'
      ? { ...source, operation: { ...source.operation,
        payload: { ...source.operation.payload, node: { ...source.operation.payload.node, extensions } } } }
      : { ...source, effect: { ...source.effect, node: { ...source.effect.node, extensions } } };
    expect(() => validateAuthoritativePullEvent(oversized, '0.2')).toThrow(/maximum JSON member count/);
  });

  it('rejects invalid effect identity even in a combined member-heavy event', () => {
    const source = event(6_000);
    const draft: AuthoritativePullEffect = { ...source.effect, opId: 'other-op' };
    const effect = { ...draft, effectDigest: canonicalAuthoritativeEffectDigest(draft) };
    expect(() => validateAuthoritativePullEvent({ ...source, effect }, '0.2'))
      .toThrow(/source Operation binding/);
  });
});
