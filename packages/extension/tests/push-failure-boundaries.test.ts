import { expect, test } from 'vitest';
import 'fake-indexeddb/auto';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import { SyncStateError } from '../src/sync-state/types.js';
import { resetIndexedDb, scope, setup } from './outbound-push-worker-harness.js';

for (const stage of ['hook', 'endpoints', 'fetch', 'dispatch'] as const) {
  test(`${stage} programming failure remains diagnostic without pretending a network failure`, async () => {
    resetIndexedDb(); const f = await setup(); let requests = 0;
    const fail = async (): Promise<never> => { throw new ReferenceError('internal browser identifier unavailable'); };
    try {
      await createOutboundPushWorker({ ...f.options,
        ...(stage === 'hook' ? { beforeDispatch: fail } : {}),
        ...(stage === 'endpoints' ? { endpoints: fail } : {}),
        ...(stage === 'dispatch' ? { dispatch: fail } : {}),
        fetch: async () => { requests++; return fail(); } }).drain();
      f.store.close();
      const persisted = await f.store.getQueueByOpId(scope, f.queued.opId);
      expect(persisted).toMatchObject({ status: 'unknown', recovery: { code: 'push_dispatch_failed' },
        attempt: { body: expect.any(String) } });
      expect(requests).toBe(stage === 'fetch' ? 1 : 0);
      expect(JSON.stringify(persisted)).not.toContain('internal browser identifier');
    } finally { f.store.close(); }
  });
}
for (const error of [new TypeError('Failed to fetch'), new DOMException('Timed out', 'AbortError'),
  new SyncStateError('record_invalid', 'field contains private browser context')]) {
  test(`actual transport preserves ${error.name} evidence and the exact unsettled attempt`, async () => {
    resetIndexedDb(); const f = await setup();
    try {
      await createOutboundPushWorker({ ...f.options, fetch: async () => { throw error; } }).drain();
      const persisted = await f.store.getQueueByOpId(scope, f.queued.opId);
      expect(persisted?.recovery?.code).toBe(error instanceof SyncStateError ? 'record_invalid' : 'push_network_failed');
      expect(persisted?.status).toBe('unknown'); expect(persisted?.attempt?.body).toBeTruthy();
      expect(JSON.stringify(persisted)).not.toContain('private browser context');
    } finally { f.store.close(); }
  });
}
