import { describe, expect, it, vi } from 'vitest';

import {
  bindSyncPushBatchId, coordinateSessionBoundPush, createSyncHost,
  type PushReplicaOwnershipVerifier, type PushTransactionRequest,
} from '../../src/sync/index.js';
import { DurableContractHandle, plan, request } from './push-transaction-harness.js';
import { verifiedSession } from './verified-session-fixture.js';

const ownsReplica: PushReplicaOwnershipVerifier = (session, key) =>
  session.principal.id === 'alice' && key.replicaId === 'replica-1' && key.collectionId === 'collection-1';
const batch = (sessionId: string, atomic: boolean): PushTransactionRequest => ({
  ...request(atomic, 1), batchId: bindSyncPushBatchId(sessionId, 'ownership'),
});
const scopes = { authorizationScopes: ['sync:push'] as const };

describe('Push Replica ownership is required before durable identity access', () => {
  it.each([false, true])('denies foreign writes without poisoning the owner lane (atomic=%s)', async (atomic) => {
    const alice = await verifiedSession('alice-session', scopes);
    const bob = await verifiedSession('bob-session', { ...scopes, principal: { type: 'user', id: 'bob' } });
    const adapter = new DurableContractHandle();
    const execute = vi.spyOn(adapter, 'execute');
    const preflight = vi.fn(async () => plan('applied', 1));
    const verify = vi.fn(ownsReplica);
    const attacker = createSyncHost({ owner: 'push', session: bob, pushOwnershipVerifier: verify });
    await expect(attacker.push(adapter, batch(bob.sessionId, atomic), preflight))
      .rejects.toMatchObject({ denial: { state: 'request_binding_mismatch' } });
    expect(verify).toHaveBeenCalledOnce();
    expect(verify).toHaveBeenCalledWith(bob, { replicaId: 'replica-1', collectionId: 'collection-1' });
    expect(execute).not.toHaveBeenCalled();
    expect(preflight).not.toHaveBeenCalled();
    expect(adapter.backend.state.receipts).toEqual([]);
    expect(adapter.backend.state.operationClaims.size).toBe(0);
    const owner = createSyncHost({ owner: 'push', session: alice, pushOwnershipVerifier: ownsReplica });
    await expect(owner.push(adapter, batch(alice.sessionId, atomic), preflight))
      .resolves.toMatchObject({ result: { results: [{ status: 'applied' }] } });
  });

  it.each([false, true])('denies foreign receipt replay and still permits owner replay (atomic=%s)', async (atomic) => {
    const alice = await verifiedSession('alice-session', scopes);
    const bob = await verifiedSession('bob-session', { ...scopes, principal: { type: 'user', id: 'bob' } });
    const adapter = new DurableContractHandle();
    const owner = createSyncHost({ owner: 'push', session: alice, pushOwnershipVerifier: ownsReplica });
    const first = await owner.push(adapter, batch(alice.sessionId, atomic), async () => plan('applied', 1));
    const execute = vi.spyOn(adapter, 'execute');
    const preflight = vi.fn(async () => { throw new Error('replays must not evaluate preflight'); });
    const attacker = createSyncHost({ owner: 'push', session: bob, pushOwnershipVerifier: ownsReplica });
    await expect(attacker.push(adapter, batch(bob.sessionId, atomic), preflight))
      .rejects.toMatchObject({ denial: { state: 'request_binding_mismatch' } });
    expect(execute).not.toHaveBeenCalled();
    expect(preflight).not.toHaveBeenCalled();
    expect((await owner.push(adapter, batch(alice.sessionId, atomic), preflight)).result.results)
      .toEqual(first.result.results);
    expect(adapter.backend.state.business).toHaveLength(1);
    expect(preflight).not.toHaveBeenCalled();
  });

  it('requires a Push verifier even when a lifecycle verifier is installed', async () => {
    const session = await verifiedSession('alice-session', scopes);
    const adapter = new DurableContractHandle();
    const lifecycle = vi.fn(() => true);
    const host = createSyncHost({ owner: 'push', session, ownershipVerifier: lifecycle });
    await expect(host.push(adapter, batch(session.sessionId, false), async () => plan('applied', 1)))
      .rejects.toMatchObject({ denial: { state: 'request_binding_mismatch', detail: expect.stringContaining('pushOwnershipVerifier') } });
    expect(adapter.executeCount).toBe(0);
    expect(lifecycle).not.toHaveBeenCalled();
  });

  it.each([false, true])('authorizes every distinct Replica before any batch work (atomic=%s)', async (atomic) => {
    const session = await verifiedSession('alice-session', scopes);
    const adapter = new DurableContractHandle();
    const source = batch(session.sessionId, atomic);
    const item = source.operations[0];
    const operation = item.operation;
    if (operation.type !== 'delete_node') throw new Error('Expected delete fixture');
    const verify = vi.fn(ownsReplica);
    const host = createSyncHost({ owner: 'push', session, pushOwnershipVerifier: verify });
    const candidate: PushTransactionRequest = { ...source, operations: [item,
      { ...item, operation: { ...operation, opId: 'second', sequence: 2 }, digest: 'second' },
      { ...item, operation: { ...operation, opId: 'foreign', replicaId: 'replica-foreign' }, digest: 'foreign' },
    ] };
    await expect(host.push(adapter, candidate, async () => plan('applied', 1)))
      .rejects.toMatchObject({ denial: { state: 'request_binding_mismatch' } });
    expect(verify).toHaveBeenCalledTimes(2);
    expect(adapter.executeCount).toBe(0);
    expect(adapter.backend.state.business).toEqual([]);
  });

  it('supports direct composition and propagates verification failures before UnitOfWork', async () => {
    const session = await verifiedSession('alice-session', scopes);
    const adapter = new DurableContractHandle();
    const failure = new Error('ownership store unavailable');
    const verify = vi.fn(async () => { throw failure; });
    await expect(coordinateSessionBoundPush(
      { kind: 'verified', session, pushOwnershipVerifier: verify }, adapter,
      batch(session.sessionId, false), async () => plan('applied', 1),
    )).rejects.toBe(failure);
    expect(adapter.executeCount).toBe(0);
    await expect(coordinateSessionBoundPush(
      { kind: 'verified', session, pushOwnershipVerifier: ownsReplica }, adapter,
      batch(session.sessionId, false), async () => plan('applied', 1),
    )).resolves.toMatchObject({ result: { results: [{ status: 'applied' }] } });
  });

  it.each([undefined, 'yes', { then: () => true }])('rejects invalid ownership evidence %j', async (verdict) => {
    const session = await verifiedSession('alice-session', scopes);
    const adapter = new DurableContractHandle();
    const verify = (() => verdict) as unknown as PushReplicaOwnershipVerifier;
    const host = createSyncHost({ owner: 'push', session, pushOwnershipVerifier: verify });
    await expect(host.push(adapter, batch(session.sessionId, false), async () => plan('applied', 1)))
      .rejects.toThrow(TypeError);
    expect(adapter.executeCount).toBe(0);
  });
});
