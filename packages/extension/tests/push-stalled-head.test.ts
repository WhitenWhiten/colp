import assert from 'node:assert/strict';
import { test } from 'vitest';
import { MemoryStorageArea } from '../src/credential-store.js';
import { STALLED_UPLOAD_ATTEMPTS, stalledUploadHead } from '../src/engine-public-stability.js';
import { sendReplicaHealthReport } from '../src/sw/replica-health-report.js';
import { handleSyncAttentionRequest } from '../src/sw/sync-attention.js';
import { readOpenSyncIssues } from '../src/sync-issues.js';
import type { QueueOperation } from '../src/sync-state-store.js';
import { json, scope, setup } from './durable-sync-engine-harness.js';

/**
 * A sent change keeps its attempt and sequence until the server settles it, so
 * the lane behind it must wait. That wait was invisible: Status and the Sync
 * center said syncing while every later upload sat behind a head the server
 * kept answering in a way this browser could not settle.
 */
async function sentHead(f: Awaited<ReturnType<typeof setup>>, settle: { readonly outcome: 'unknown' | 'deferred';
  readonly attempt: number; readonly code?: string }) {
  await f.enqueue('op-head-1', { payload: { parentId: 'root-old', node: { kind: 'bookmark', title: 'Stuck recipe', url: 'https://example.test/stuck' } } });
  await f.enqueue('op-next-2');
  const lease = await f.store.acquireLease(scope, 'test-owner', f.clock.now, 60_000);
  const claimed = (await f.store.claimNextQueue(scope, 'test-owner', lease.fence, f.clock.now))!;
  const body = JSON.stringify({ sessionId: 'session-engine', batchId: claimed.batchId, atomic: false, operations: [claimed.payload] });
  await f.store.bindPushAttempt(scope, claimed.sequence, 'test-owner', lease.fence, { sessionId: 'session-engine',
    batchId: claimed.batchId, idempotencyKey: claimed.idempotencyKey, endpointIdentity: 'syncPush',
    mediaType: 'application/json', body, bodyDigest: claimed.digest });
  const receipt = { opId: claimed.opId, operationDigest: claimed.digest, kind: 'deferred' as const,
    receiptId: `push-${claimed.opId}`, resultDigest: 'sha256:deferred', result: { status: 'deferred' } };
  await f.store.settleClaimedPush(scope, claimed.sequence, 'test-owner', lease.fence, settle.outcome === 'deferred'
    ? { outcome: 'deferred', receipt, retry: { attempt: settle.attempt, notBefore: 0 } }
    : { outcome: 'unknown', retry: { attempt: settle.attempt, notBefore: 0 }, recovery: { code: settle.code! } });
  return claimed;
}

async function report(f: Awaited<ReturnType<typeof setup>>) {
  const reports: any[] = [];
  const outcome = await sendReplicaHealthReport({ scope, store: f.store, storage: new MemoryStorageArea(),
    origin: 'chrome-extension://known', mode: async () => 'enabled', extensionVersion: '0.2.0', now: () => f.clock.now,
    credential: async () => ({ accessToken: 'token', serverOrigin: scope.serverOrigin, subject: scope.accountId }),
    fetch: async (_url, init) => { reports.push(JSON.parse(String(init?.body)));
      return json(200, { accepted: true, replicaId: scope.replicaId, revision: reports.at(-1).revision, commands: [] }); } });
  assert.equal(outcome, 'sent');
  return reports[0];
}

test('a sent change the server keeps unsettled is reported as a stalled upload, not hidden behind syncing', async () => {
  const f = await setup();
  const head = await sentHead(f, { outcome: 'unknown', attempt: STALLED_UPLOAD_ATTEMPTS, code: 'push_response_unrecognized' });
  // Not an open item: nothing is set aside, the ceiling and the closure do not count it.
  assert.equal((await readOpenSyncIssues(f.store, scope)).total, 0);
  const attention = await handleSyncAttentionRequest({ scope: async () => scope, store: f.store });
  assert.equal(attention.ok, true); if (!attention.ok) return;
  assert.equal(attention.attention.issueCount, 1);
  assert.deepEqual(attention.attention.issues, [{ direction: 'push', code: 'push_response_unrecognized' }]);
  assert.equal(attention.attention.queueProjection, 'syncing');
  // K3 (C-01/C-02): a sent change the server never settles had no exit; the server-fenced Reset is it.
  assert.equal(attention.attention.rebuildAvailable, true, 'a stalled upload is a reason to reset');
  assert.equal(attention.attention.rebuildMode, 'server_fenced');
  const sent = await report(f);
  assert.equal(sent.state, 'degraded');
  assert.equal(sent.issues.total, 1);
  assert.deepEqual(sent.issues.items.map((item: any) => [item.code, item.direction, item.opId, item.title, item.count, item.actions]),
    [['push_response_unrecognized', 'push', head.opId, 'Stuck recipe', STALLED_UPLOAD_ATTEMPTS, []]]);
  f.store.close();
});

test('a deferral that never ends is a stalled upload too', async () => {
  const f = await setup();
  await sentHead(f, { outcome: 'deferred', attempt: STALLED_UPLOAD_ATTEMPTS + 3 });
  const sent = await report(f);
  assert.equal(sent.state, 'degraded');
  assert.deepEqual(sent.issues.items.map((item: any) => [item.code, item.count]), [['push_deferred', STALLED_UPLOAD_ATTEMPTS + 3]]);
  f.store.close();
});

test('220 explicit move revision denials are visible even after the old attempt is cleared', async () => {
  const f = await setup();
  try {
    await f.store.allocateSequenceAndEnqueue(scope, { opId: 'stale-move', batchId: 'move-batch',
      idempotencyKey: 'move-key', digest: 'sha256:move', endpointIdentity: 'syncPush', mediaType: 'application/json',
      baseRevision: 'old', operationRevision: 'local-move', status: 'pending',
      retry: { attempt: 0, notBefore: 0 },
      payload: { type: 'move_node', targetId: 'bookmark', payload: { newParentId: 'dest' } } }, { allowUnstamped: true });
    const lease = await f.store.acquireLease(scope, 'owner', f.clock.now, 60_000);
    const claimed = (await f.store.claimNextQueue(scope, 'owner', lease.fence, f.clock.now))!;
    await f.store.settleClaimedPush(scope, claimed.sequence, 'owner', lease.fence, { outcome: 'unknown',
      retry: { attempt: 220, notBefore: 0 }, recovery: { code: 'revision_conflict' }, clearAttempt: true });
    const attention = await handleSyncAttentionRequest({ scope: async () => scope, store: f.store });
    assert.equal(attention.ok && attention.attention.issueCount, 1);
    const sent = await report(f);
    assert.equal(sent.state, 'degraded');
    assert.equal(sent.issues.items[0].code, 'revision_conflict');
    assert.equal(sent.issues.items[0].count, 220);
  } finally { f.store.close(); }
});

test('lost connectivity, a busy server, authority problems and ordinary retries are not stalled uploads', async () => {
  for (const [code, attempt] of [['push_network_failed', 20], ['rate_limited', 20], ['server_unavailable', 20],
    ['push_session_refresh_failed', 20], ['push_response_unrecognized', STALLED_UPLOAD_ATTEMPTS - 1]] as const) {
    const f = await setup();
    await sentHead(f, { outcome: 'unknown', attempt, code });
    const attention = await handleSyncAttentionRequest({ scope: async () => scope, store: f.store });
    assert.equal(attention.ok && attention.attention.issueCount, 0, code);
    assert.equal((await report(f)).state, 'syncing', code);
    f.store.close();
  }
});

test('a change that was never sent is not a stalled upload; its own hold reports it', () => {
  const row = (overrides: Partial<QueueOperation>): QueueOperation => ({ scopeKey: 's', sequence: 1, opId: 'op', batchId: 'b',
    idempotencyKey: 'k', digest: 'd', endpointIdentity: 'syncPush', mediaType: 'application/json', baseRevision: null,
    operationRevision: 'r', status: 'unknown', retry: { attempt: 20, notBefore: 0 }, recovery: { code: 'push_response_unrecognized' },
    payload: { type: 'create_node' }, ...overrides } as QueueOperation);
  const attempt = { sessionId: 's', batchId: 'b', idempotencyKey: 'k', endpointIdentity: 'syncPush' as const,
    mediaType: 'application/json' as const, body: '{}', bodyDigest: 'x' };
  assert.equal(stalledUploadHead([row({})]), undefined);
  assert.equal(stalledUploadHead([row({ attempt })])?.code, 'push_response_unrecognized');
  // The head is the earliest unsettled row; a conflict or a held row is reported on its own.
  assert.equal(stalledUploadHead([row({ sequence: 1, status: 'blocked', recovery: { code: 'conflict_pending' } }),
    row({ sequence: 2, attempt })])?.row.sequence, 2);
  assert.equal(stalledUploadHead([row({ attempt, status: 'gap', recovery: { code: 'sequence_gap' } })])?.code, 'sequence_gap');
});
