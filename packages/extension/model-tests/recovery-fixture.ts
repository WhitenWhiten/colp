import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { createDurableSyncEngine } from '../src/durable-sync-engine.js';
import { recoverVerifiedOrFreeze } from '../src/recovery-guard.js';
import { projectNativeWaits } from '../src/native-wait.js';
import type { StoredSession } from '../src/types.js';
import { setupT02, reopenT02, t02Scope as scope } from '../tests/srg-t02-native-harness.js';

export async function setupRecoveryWait(interruptAfterAck = false) {
  let f = await setupT02('after_create_before_evidence');
  try {
    const event = f.createEvent('Bookmark', 1);
    const effect = event.effect;
    assert.ok(effect?.kind === 'node_created' && effect.node.kind === 'bookmark');
    const node = effect.node;
    await f.applier.stage(f.page([event], 'old-pull-cut'));
    await assert.rejects(f.applier.resume(), /worker_crash/u);
    f = await reopenT02(f);
    await assert.rejects(f.applier.resume(), /native_result_unknown/u);
    assert.equal((await projectNativeWaits(f.store, scope)).length, 1);
    const { scopeKey: _scopeKey, ...root } = (await f.store.getMappingByColpId(scope, 'root-colp'))!;
    const child = { nativeId: `recovery:${node.id}`, colpId: node.id,
      rootNativeId: 'native-root', parentColpId: root.colpId, nodeKind: 'bookmark' as const,
      projection: { revision: node.revision, digest: effect.effectDigest,
        content: { title: node.title, ...(node.url ? { url: node.url } : {}) } } };
    await f.store.stageRecoveryPage(scope, { snapshotId: 'handoff-snapshot', sessionId: 'session-recovery',
      revision: 'snapshot-revision', syncCursor: 'snapshot-cut', capability: 'src1.model-capability',
      identityDigest: 'sha256:model', rootNodeId: root.colpId, page: 0, pageDigest: 'sha256:page',
      previousPageDigest: null, nextCursor: null, complete: true,
      nodes: [root, child].map((mapping, i) => ({ colpId: mapping.colpId,
        parentId: 'parentColpId' in mapping ? mapping.parentColpId ?? null : null,
        position: String(i), kind: mapping.nodeKind === 'bookmark' ? 'Bookmark' : 'Folder',
        payloadDigest: mapping.projection.digest, mapping })) });
    await f.store.transitionEngine(scope, { phase: 'recovery', recoveryFrozen: true,
      authorityRefreshRequired: true, lastError: 'sync_cursor_expired', updatedAt: 1000, notBefore: 0 });
    let active = false;
    let interrupt = interruptAfterAck;
    const acks: string[] = [];
    const checkpoints: Array<{ point: string; observed: unknown }> = [];
    const observe = async () => {
      const state = (await f.store.getEngineState(scope))!;
      const durable = await f.store.getCursor(scope);
      const intents = await f.store.listAckIntents(scope);
      return { cursor: durable?.cursor === 'active-cut' ? 2 : durable?.cursor === 'snapshot-cut' ? 1 : 0,
        frozen: state.recoveryFrozen, refresh: state.authorityRefreshRequired,
        staged: await f.store.hasRecoveryStaging(scope),
        pending: intents.some(row => row.kind === 'bootstrap' && row.state === 'pending'),
        complete: intents.some(row => row.kind === 'bootstrap' && row.state === 'complete'),
        nativeUnknown: (await projectNativeWaits(f.store, scope)).length > 0, requests: acks.length };
    };
    const capture = async (point: string) => { checkpoints.push({ point, observed: await observe() }); };
    await capture('initial');
    const makeEngine = () => createDurableSyncEngine({ scope, store: { ...f.store,
      async rebaseRecoveryCursor(...args) {
        await f.store.rebaseRecoveryCursor(...args); await capture('activated');
      },
    }, now: () => 1000,
      endpoints: async () => ({ syncPull: 'https://known.example/pull', syncSnapshot: 'https://known.example/snapshot',
        syncAck: 'https://known.example/ack' }),
      sessions: { get: async () => {
        if (active && (await f.store.getEngineState(scope))?.phase === 'bootstrap'
            && (await f.store.listAckIntents(scope)).some(row => row.kind === 'bootstrap' && row.state === 'complete')) {
          await capture('before_activation');
        }
        return { credential: { accessToken: 'token' }, session: {
        sessionId: active ? 'session-active' : 'session-recovery', acceptedProtocolVersion: '0.2',
        scope: 'collection', snapshotRequired: !active, expiresAt: '2099-01-01T00:00:00Z',
        collection: { collectionId: scope.collectionId, serverCursor: active ? 'active-cut' : 'old-pull-cut', serverRevision: 'snapshot-revision' },
        replicaLease: { leaseId: 'lease-t02', generation: '1', state: 'active',
          expiresAt: '2099-01-01T00:00:00Z' },
      } as StoredSession }; } },
      pullApplier: f.applier, pushWorker: { drain: async () => { throw new Error('unexpected_push'); } },
      snapshotProjector: (staged, mode) => recoverVerifiedOrFreeze({ scope, store: f.store, api: f.api,
        staged, freezeUnprovenIdentity: true, ...mode }),
      boundary: async point => {
        if (point === 'before_ack' || point === 'after_ack') await capture(point);
        if (point === 'after_ack' && interrupt) { interrupt = false; throw new Error('worker_crash'); }
      },
      fetch: async (url, init) => {
        if (String(url).includes('/snapshot/conflicts')) return Response.json({ snapshotId: 'handoff-snapshot',
          offset: 0, conflictCount: 0, conflicts: [], nextOffset: null });
        assert.ok(String(url).endsWith('/ack'), `unexpected request: ${String(url)}`);
        const body = JSON.parse(String(init?.body)); acks.push(String(init?.body)); active = true;
        return Response.json({ replicaId: scope.replicaId, ackedCursor: body.cursor, ackedAt: '2026-10-18T00:00:00Z' });
      },
    });
    return { get fixture() { return f; }, acks, checkpoints, capture, engine: makeEngine,
      async restart() { f = await reopenT02(f); await capture('restart'); return makeEngine(); } };
  } catch (error) { f.store.close(); throw error; }
}
