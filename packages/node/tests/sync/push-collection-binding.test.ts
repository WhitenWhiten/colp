import { describe, expect, it, vi } from 'vitest';
import { bindSyncPushBatchId, createSyncHost, requireVerifiedSyncSession, SyncSessionGateDeniedError } from '../../src/sync/index.js';
import { DurableContractHandle, request, plan } from './push-transaction-harness.js';

async function host() {
  const binding = { principal: { type: 'user' as const, id: 'alice' }, credential: { kind: 'token' as const, id: 'key-1' }, oauthClientId: null, origin: null, sessionScope: 'collection' as const, protocolVersion: '0.1' as const, collectionId: 'collection-1', purpose: null };
  const record = { ...binding, status: 'active' as const, sessionId: 'session-1', authorizationScopes: ['sync:push' as const] };
  const session = await requireVerifiedSyncSession({ load: async () => structuredClone(record), create: async () => { throw Error('unused'); }, terminate: async () => { throw Error('unused'); } }, { sessionId: record.sessionId, binding, authorization: { credentialActive: true, authorizationScopes: record.authorizationScopes }, terminatedAt: '2026-09-25T00:00:00Z' });
  return createSyncHost({ owner: 'push', session, pushOwnershipVerifier: () => true });
}

describe('Push Collection binding [evidence:sync.composition]', () => {
  it.each(['operation', 'lane', 'both'])('rejects mismatched %s before the first write in a non-atomic batch', async mismatch => {
    const facade = await host();
    const adapter = new DurableContractHandle();
    const original = request(false, 2);
    const input = { ...original, batchId: bindSyncPushBatchId('session-1', 'batch') };
    const second = input.operations[1]!;
    if (mismatch !== 'lane') Object.assign(second.operation, { collectionId: 'collection-2' });
    if (mismatch !== 'operation') Object.assign(second, { sequenceScope: 'collection-2' });
    const preflight = vi.fn(async (_item: unknown, index: number) => plan('applied', index + 1));
    await expect(facade.push(adapter, input, preflight)).rejects.toBeInstanceOf(SyncSessionGateDeniedError);
    expect(adapter.executeCount).toBe(0);
    expect(preflight).not.toHaveBeenCalled();
    expect(adapter.backend.state.receipts).toEqual([]);
  });

  it.each(['collection-1', 'collection:collection-1'])('allows the verified lane encoding %s and exact replay', async sequenceScope => {
    const facade = await host();
    const adapter = new DurableContractHandle();
    const original = request(true, 1);
    const input = { ...original, batchId: bindSyncPushBatchId('session-1', 'batch') };
    Object.assign(input.operations[0]!, { sequenceScope });
    await facade.push(adapter, input, async () => plan('applied', 1));
    const replay = vi.fn(async () => plan('applied', 1));
    await facade.push(adapter, input, replay);
    expect(replay).not.toHaveBeenCalled();
    expect(adapter.backend.state.business).toEqual(['business-1']);
  });
});
