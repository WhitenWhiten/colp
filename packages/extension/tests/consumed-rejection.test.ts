import 'fake-indexeddb/auto';
import { expect, test } from 'vitest';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import { readOpenSyncIssues } from '../src/sync-issues.js';
import { handleSyncAttentionRequest } from '../src/sw/sync-attention.js';
import { sendReplicaHealthReport } from '../src/sw/replica-health-report.js';
import { MemoryStorageArea } from '../src/credential-store.js';
import { installOutboundPushIndexedDb, setup, scope, json } from './outbound-push-worker-harness.js';
installOutboundPushIndexedDb();

for (const historical of [false, true]) test(`consumed rejection remains visible and independent work advances (historical=${historical})`, async () => {
  const f = await setup();
  try {
    if (historical) await f.store.completeQueueWithReceipt(scope, 1, { kind: 'terminal', opId: f.queued.opId,
      operationDigest: f.queued.digest, receiptId: 'old-receipt', resultDigest: 'sha256:old', result: {
        results: [{ opId: f.queued.opId, sequence: 1, status: 'rejected', code: 'resource_id_unavailable', warnings: [] }] } });
    else await createOutboundPushWorker({ ...f.options, fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      return json(200, { batchId: body.batchId, results: [{ opId: f.queued.opId, sequence: 1,
        status: 'rejected', code: 'resource_id_unavailable', warnings: [] }], serverCursor: 'sync-unchanged' });
    } }).drain();
    f.store.close();
    expect((await f.store.getQueueReceipt(scope, 1))?.kind).toBe('terminal');
    const rows = await readOpenSyncIssues(f.store, scope);
    expect(rows.queue).toHaveLength(1); expect(rows.queue[0]?.status).toBe('terminal');
    expect(rows.queue[0]?.recovery?.code).toBe('resource_id_unavailable');
    expect((await handleSyncAttentionRequest({ scope: async () => scope, store: f.store })) ).toMatchObject({ ok: true,
      attention: { issueCount: 1, issues: [expect.objectContaining({ code: 'resource_id_unavailable' })] } });
    let report: any;
    await sendReplicaHealthReport({ scope, store: f.store, storage: new MemoryStorageArea(), now: () => 10000,
      origin: 'chrome-extension://test', mode: async () => 'enabled',
      credential: async () => ({ accessToken: 'test', subject: scope.accountId, serverOrigin: scope.serverOrigin }),
      fetch: async (_url, init) => { report = JSON.parse(String(init?.body)); return json(200, { replicaId: scope.replicaId,
        revision: report.revision, accepted: true, commands: [] }); } });
    expect(report).toMatchObject({ state: 'degraded', issues: { total: 1, items: [expect.objectContaining({ code: 'resource_id_unavailable' })] } });
    const { scopeKey: _scopeKey, sequence: _sequence, ...queueInput } = f.queued;
    const next = await f.store.allocateSequenceAndEnqueue(scope, { ...queueInput, opId: 'independent', batchId: 'independent',
      idempotencyKey: 'independent', digest: 'sha256:independent', payload: { ...f.queued.payload, opId: 'independent', sequence: 2,
        payload: { parentId: 'other-root', node: { kind: 'bookmark', title: 'Other', url: 'https://example.test/other' } } } }, { allowUnstamped: true });
    const sent: number[] = [];
    await createOutboundPushWorker({ ...f.options, fetch: async (_url, init) => { const body = JSON.parse(String(init?.body));
      sent.push(body.operations[0].sequence); return json(200, { batchId: body.batchId,
        results: [{ opId: next.opId, sequence: next.sequence, status: 'noop', warnings: [] }], serverCursor: 'sync-unchanged' }); } }).drain();
    expect(sent).toEqual([2]);
    expect((await readOpenSyncIssues(f.store, scope)).total).toBe(1);
  } finally { f.store.close(); }
});
