import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { bootstrapOpId } from '../src/bootstrap/matcher.js';
import { operationPayload } from '../src/bootstrap/coordinator-operations.js';
import { createSyncStateStore, type JsonObject } from '../src/sync-state-store.js';
import { setup, scope, operation, json } from './outbound-push-worker-harness.js';

export async function fixture(count: number, limit = 50, titleBytes = 0,
  change?: (payload: JsonObject, index: number) => JsonObject) {
  const base = await setup();
  const factory = new IDBFactory(); const store = createSyncStateStore({ indexedDB: factory });
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease-server',
    expiresAt: Date.parse('2099-01-01T00:00:00Z') }, checkpoint: null, selectedRoots: [] });
  for (let index = 1; index <= count; index += 1) {
    const opId = bootstrapOpId('first-sync', 'create', `native-${index}`);
    const payload = { ...operation, sequence: index, ...operationPayload({
      type: 'create_node', reason: 'local-only', opId, parentId: 'root-push',
      node: { kind: 'bookmark', title: `Bookmark ${index}${'x'.repeat(titleBytes)}`,
        url: `https://example.test/${index}` },
    }, String(operation.occurredAt)) };
    await store.allocateSequenceAndEnqueue(scope, { opId, batchId: opId, idempotencyKey: opId,
      digest: `digest-${index}`, endpointIdentity: 'syncPush', mediaType: 'application/json',
      baseRevision: null, operationRevision: `local-${index}`, status: 'pending',
      retry: { attempt: 0, notBefore: 0 }, payload: change?.(payload, index) ?? payload }, { allowUnstamped: true });
  }
  const sessions = { async get() { const value = await base.options.sessions.get();
    return { ...value, session: { ...value.session, maxBatchOperations: limit } }; } };
  base.store.close();
  return { store, factory, clock: base.clock, options: { ...base.options, store, sessions, initialBatchOperations: 50 } };
}

export function success(body: string) {
  const request = JSON.parse(body) as { batchId: string; operations: JsonObject[] };
  return json(200, { batchId: request.batchId, serverCursor: 'cursor-100',
    results: request.operations.map(op => ({ opId: op.opId, sequence: op.sequence, status: 'applied',
      targetId: `node-${op.sequence}`, revision: `revision-${op.sequence}`, cursor: `cursor-${op.sequence}`, warnings: [] })) });
}
