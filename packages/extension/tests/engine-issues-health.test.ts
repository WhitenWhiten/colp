import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { MemoryStorageArea } from '../src/credential-store.js';
import { replicaIssuesFromUnreadable, replicaIssuesFromWakeFailures, unreadableQueueDiagnostics,
  wakeFailureDiagnostics } from '../src/sw/engine-issues.js';
import { sendReplicaHealthReport, type ReplicaHealthReporterDeps } from '../src/sw/replica-health-report.js';
import type { WakeFailure } from '../src/sw/wake-failure.js';
import { scope, setup } from './durable-sync-engine-harness.js';

/**
 * The Sync center must see what Status sees for the engine-level items no row carries: a saved upload
 * that cannot be read (Rule C) and a wake step that keeps failing (Rule E).
 */
const failure: WakeFailure = { stage: 'rebuild_resume', code: 'quota_exceeded', count: 5, firstAt: 1_000, lastAt: 9_000, replicaId: scope.replicaId };

describe('engine-level items', () => {
  test('are shaped for Status and for the health report', () => {
    const [local] = wakeFailureDiagnostics([failure]);
    assert.deepEqual([local?.direction, local?.code, local?.stage, local?.rootCause, local?.count], ['local', 'sync_step_failed', 'rebuild_resume', 'quota_exceeded', 5]);
    const [report] = replicaIssuesFromWakeFailures([failure]);
    assert.deepEqual([report?.code, report?.direction, report?.count, report?.actions], ['sync_step_failed', 'local', 5, []]);
    assert.match(report!.issueId, /^[0-9a-f]{32}$/u);
    assert.equal(report!.firstSeenAt, '1970-01-01T00:00:01.000Z');
    const rows = [{ kind: 'sent' as const, sequence: 4, opId: 'op-4' }, { kind: 'unsent' as const, sequence: 5 }];
    assert.deepEqual(unreadableQueueDiagnostics(rows).map((issue) => [issue.direction, issue.code, issue.opId]),
      [['push', 'queue_head_unreadable', 'op-4'], ['push', 'queue_row_unreadable', undefined]]);
    assert.deepEqual(replicaIssuesFromUnreadable(rows, 5_000).map((issue) => [issue.code, issue.opId, issue.actions]),
      [['queue_head_unreadable', 'op-4', []], ['queue_row_unreadable', undefined, []]]);
    // Two different rows are two different issues.
    const ids = replicaIssuesFromUnreadable(rows, 5_000).map((issue) => issue.issueId);
    assert.equal(new Set(ids).size, 2);
  });

  test('an unreadable sent upload makes the browser report itself degraded with that item', async () => {
    const f = await setup(); f.clock.now = Date.parse('2026-10-24T12:00:00.000Z');
    await f.enqueue('op-sent-1');
    const lease = await f.store.acquireLease(scope, 'o', f.clock.now, 60_000);
    const claimed = (await f.store.claimNextQueue(scope, 'o', lease.fence!, f.clock.now))!;
    await f.store.bindPushAttempt(scope, claimed.sequence, 'o', lease.fence!, { sessionId: 'session-engine', batchId: claimed.batchId,
      idempotencyKey: claimed.idempotencyKey, endpointIdentity: 'syncPush', mediaType: 'application/json',
      body: JSON.stringify({ sessionId: 'session-engine', batchId: claimed.batchId, atomic: false, operations: [claimed.payload] }),
      bodyDigest: claimed.digest });
    await f.store.settleClaimedPush(scope, claimed.sequence, 'o', lease.fence!,
      { outcome: 'unknown', retry: { attempt: 2, notBefore: 0 }, recovery: { code: 'push_network_failed' } });
    const db = await f.store.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('outbound_queue', 'readwrite'); const queue = tx.objectStore('outbound_queue');
      queue.openCursor().onsuccess = (event: Event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result; if (!cursor) return;
        cursor.update({ ...(cursor.value as Record<string, unknown>), endpointIdentity: 'weird' }); cursor.continue();
      };
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    });
    const bodies: Array<Record<string, any>> = [];
    const deps: ReplicaHealthReporterDeps = { scope, store: f.store, mode: async () => 'enabled',
      credential: async () => ({ accessToken: 'access-token', serverOrigin: scope.serverOrigin, subject: scope.accountId }),
      fetch: async (_input, init) => { const body = JSON.parse(String(init?.body)); bodies.push(body);
        return new Response(JSON.stringify({ replicaId: body.replicaId, revision: body.revision, accepted: true, commands: [] }),
          { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } }); },
      storage: new MemoryStorageArea(), origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
      extensionVersion: '0.2.0', now: () => f.clock.now };
    assert.equal(await sendReplicaHealthReport(deps), 'sent');
    assert.equal(bodies[0]!.state, 'degraded');
    assert.deepEqual((bodies[0]!.issues.items as Array<{ code: string; opId?: string }>).map((item) => [item.code, item.opId]),
      [['queue_head_unreadable', 'op-sent-1']]);
    assert.equal(bodies[0]!.issues.total, 1);
    f.store.close();
  });
});
