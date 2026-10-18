import { expect, test } from 'vitest';
import { conflicted, scope } from './bootstrap-merge-attention-harness.js';
import { handleAttentionDecide, handleAttentionGet } from '../src/sw/first-run-attention.js';
import { createOutboundPushWorker, type PushSessionController } from '../src/outbound-push-worker.js';
import { endpoints } from './outbound-push-worker-harness.js';

test('four actual local differences close only after authoritative Push receipts and rematching; restart is idempotent', async () => {
  const f = await conflicted(); const remote = f.input.remoteFacts!.map(row => ({ ...row }));
  try {
    expect(f.view.run.attention?.items.every(item => item.kind === 'local_difference')).toBe(true);
    const page = await handleAttentionGet(f.store, scope, f.view.run.runId, undefined, 'completed');
    expect(page).not.toHaveProperty('conflictHref');
    for (const item of f.view.run.attention!.items) {
      const request = { decision: 'keep_local' as const, evidenceDigest: item.evidenceDigest, input: f.input };
      expect((await handleAttentionDecide(f.store, scope, f.view.run.runId, item.itemId, 'completed', request)).ok).toBe(true);
      f.store.close();
      expect((await handleAttentionDecide(f.store, scope, f.view.run.runId, item.itemId, 'completed', request)).ok).toBe(true);
    }
    expect((await f.store.listQueue(scope))).toHaveLength(4);
    expect((await f.coordinator.status()).phase).toBe('needs_attention');
    const sessions: PushSessionController = { get: async () => ({ credential: { accessToken: 'test' }, session: {
      sessionId: 'merge-session', expiresAt: '2099-01-01T00:00:00Z', scope: 'collection', snapshotRequired: false,
      credentialAuthorityDigest: 'a'.repeat(64), collection: { collectionId: scope.collectionId, serverRevision: 'r1', serverCursor: 'c0' },
      replicaLease: { leaseId: 'lease', generation: '1', state: 'active', expiresAt: '2099-01-01T00:00:00Z' } } }) };
    await createOutboundPushWorker({ scope, store: f.store, sessions, endpoints: async () => endpoints,
      now: () => 10000, ownerId: () => 'merge', fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)); const op = body.operations[0];
        const node = remote.find(row => row.nodeId === op.targetId)!;
        expect(op.baseRevision).toBe(node.revision); expect(op.payload.base.title).toBe(node.title);
        node.title = op.payload.value.title; node.revision = `r-${op.sequence + 1}`;
        return Response.json({ batchId: body.batchId, results: [{ opId: op.opId, sequence: op.sequence, status: 'applied',
          targetId: node.nodeId, revision: node.revision, cursor: `c-${op.sequence}`, warnings: [] }], serverCursor: `c-${op.sequence}` });
      } }).drain();
    expect((await f.store.listQueue(scope)).every(row => row.status === 'terminal')).toBe(true);
    await f.coordinator.advance(f.view.run.runId, { ...f.input, remoteFacts: remote });
    expect(await f.coordinator.status()).toMatchObject({ phase: 'completed', attention: { items: [] } });
    f.store.close(); expect((await f.coordinator.status()).phase).toBe('completed');
    expect(remote.slice(2).map(row => row.title)).toEqual(f.input.localFacts.map(row => row.title));
  } finally { f.store.close(); }
});
test('changed local or remote evidence refuses the stale action without queueing data', async () => {
  const f = await conflicted();
  try {
    const item = f.view.run.attention!.items[0]!;
    const response = await handleAttentionDecide(f.store, scope, f.view.run.runId, item.itemId, 'completed', {
      decision: 'keep_local', evidenceDigest: item.evidenceDigest,
      input: { ...f.input, localFacts: f.input.localFacts.map(row => ({ ...row, title: 'Changed again' })) } });
    expect(response).toEqual({ ok: false, error: 'bootstrap_confirmation_stale' });
    expect(await f.store.listQueue(scope)).toHaveLength(0);
  } finally { f.store.close(); }
});

test('one choice resolves title, URL and parent differences without replacing the node', async () => {
  const f = await conflicted();
  try {
    await f.store.putMapping(scope, { nativeId: 'dest-native', colpId: 'dest', rootNativeId: '1', nodeKind: 'folder',
      parentNativeId: '1', parentColpId: 'bar', projection: { revision: 'dest-r1', childrenRevision: 'dest-cr1',
        digest: 'sha256:dest', content: { title: 'Destination' } } });
    const input = { ...f.input, localFacts: f.input.localFacts.map((row, i) => i ? row : { ...row,
      title: 'Chosen title', url: 'https://example.test/chosen', parentNativeId: 'dest-native' }),
      remoteFacts: [...f.input.remoteFacts!.map(row => row.nodeId === 'bar' ? { ...row, childrenRevision: 'cr1' } : { ...row }),
        { nodeId: 'dest', parentId: 'bar', title: 'Destination', kind: 'folder' as const, revision: 'dest-r1', childrenRevision: 'dest-cr1' }] };
    const view = await f.coordinator.advance(f.view.run.runId, input);
    const item = view.run.attention!.items.find(row => row.nodeRefs?.includes('local-0'))!;
    expect((await handleAttentionDecide(f.store, scope, view.run.runId, item.itemId, 'completed', {
      decision: 'keep_local', evidenceDigest: item.evidenceDigest, input })).ok).toBe(true);
    expect((await f.store.listQueue(scope)).map(row => row.payload.type)).toEqual(['update_node_content', 'move_node']);
    const session: PushSessionController = { get: async () => ({ credential: { accessToken: 'test' }, session: {
      sessionId: 's', expiresAt: '2099-01-01T00:00:00Z', scope: 'collection', snapshotRequired: false,
      credentialAuthorityDigest: 'a'.repeat(64), collection: { collectionId: scope.collectionId, serverRevision: 'r1', serverCursor: 'c0' },
      replicaLease: { leaseId: 'lease', generation: '1', state: 'active', expiresAt: '2099-01-01T00:00:00Z' } } }) };
    const remote = input.remoteFacts.find(row => row.nodeId === 'remote-0')!;
    await createOutboundPushWorker({ scope, store: f.store, sessions: session, endpoints: async () => endpoints,
      now: () => 10000, ownerId: () => 'multi-field', fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)); const op = body.operations[0];
        expect(op.targetId).toBe('remote-0'); expect(op.baseRevision).toBe(remote.revision);
        if (op.type === 'update_node_content') Object.assign(remote, op.payload.value);
        else { expect(op.payload.baseSourceParentRevision).toBe('cr1'); expect(op.payload.baseTargetParentRevision).toBe('dest-cr1'); remote.parentId = op.payload.newParentId; }
        remote.revision = `merged-${op.sequence}`;
        return Response.json({ batchId: body.batchId, results: [{ opId: op.opId, sequence: op.sequence,
          status: 'applied', targetId: remote.nodeId, revision: remote.revision, cursor: 'cursor-1', warnings: [] }], serverCursor: 'cursor-1' });
      } }).drain();
    const done = await f.coordinator.advance(view.run.runId, input);
    expect(done.report!.conflicts.filter(row => row.remoteNodeId === 'remote-0')).toHaveLength(0);
    expect(remote).toMatchObject({ nodeId: 'remote-0', parentId: 'dest', title: 'Chosen title', url: 'https://example.test/chosen' });
    expect((await f.store.getMappingByNativeId(scope, 'local-0'))?.colpId).toBe('remote-0');
  } finally { f.store.close(); }
});
