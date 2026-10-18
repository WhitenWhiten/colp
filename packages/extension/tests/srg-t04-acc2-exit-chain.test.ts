/**
 * T-04 round-2 acceptance (independent of the dev report). Two claims are probed
 * end-to-end through the real durable engine + real Pull applier:
 *
 *  1. A blocked page never dead-ends. When the authority cursor finally moves, the
 *     blocked page is handed over, the chain restarts from the rebased cursor and the
 *     scope returns to `active` - no page is left neither replayed nor completed, and
 *     the engine never loops on `constraint_error` with the same cursor.
 *  2. The freeze set is exactly "block or freeze": the F005/F008/B1 family freezes,
 *     while transport/staging failures stay retryable (no over-freezing), and a plain
 *     forward chain is untouched by the growth-page adoption path.
 */
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { createDurableSyncEngine } from '../src/durable-sync-engine.js';
import { shouldFreezePullApply } from '../src/pull-recovery-freeze.js';
import { syncAttentionTerminalCode } from '../src/sync-attention-ui.js';
import { needsReplicaRebuild } from '../src/sync-failure-class.js';
import { pullFixtures } from './pull-effect-fixtures.js';
import { installKns05IndexedDb, mappingInput, scope, setup } from './kns-05-pull-harness.js';

installKns05IndexedDb();

function session(cursor: string) {
  return { sessionId: 'session-acc2', credentialAuthorityDigest: 'a'.repeat(64),
    expiresAt: '2099-01-01T00:00:00Z', scope: 'collection' as const, acceptedProtocolVersion: '0.2' as const,
    snapshotRequired: false, conversionPolicy: { separator: 'preserve_remote' as const },
    collection: { collectionId: scope.collectionId, serverCursor: cursor, serverRevision: `revision-${cursor}` },
    replicaLease: { leaseId: 'lease-kns05', generation: '1', state: 'active' as const,
      expiresAt: '2099-01-01T00:00:00Z' } };
}

describe('T-04R2 acceptance: a blocked page always has an exit', () => {
  // Sync resilience (2026-10-18): a mapping identity conflict is a replica-class stop
  // whose exit is Rebuild. The engine never re-pulls the stale cursor, never mints a
  // Session to get past it, and keeps the blocked page's evidence, even when the
  // server's checkpoint for the replica has moved on. Status and health show it as
  // terminal with Rebuild; the automatic handover exit remains for authority codes.
  test('a mapping identity conflict keeps its evidence and waits for Rebuild instead of looping', async () => {
    const fixture = await setup();
    const clock = { now: 1_000 }; const forced: boolean[] = []; const pullCursors: string[] = [];
    // The replica checkpoint only moves once the server has accepted the acked page; until
    // then every forced refresh keeps re-anchoring the local cursor on the same head.
    let serverCursor = 'cursor-old';
    const leading = fixture.createEvent('Bookmark', 1) as Record<string, unknown>;
    const extra = fixture.createEvent('Bookmark', 2) as Record<string, unknown>;
    const first = pullFixtures.page({ events: [leading], nextCursor: 'cursor-next',
      collectionRevision: 'revision-next' });
    // Same chain head, new pageId, same leading eventId with different bytes: the server
    // re-paged the unacked stretch but re-signed a different effect for the same opId.
    const mutated = { ...pullFixtures.createEvent({ kind: 'Bookmark', sequence: 1,
      collectionId: scope.collectionId, parentId: 'root-colp',
      extensions: { 'https://known.example/x': 'mutated' } }), cursor: 'cursor-next' };
    const conflicting = pullFixtures.page({ events: [mutated, extra], nextCursor: 'cursor-next-2',
      collectionRevision: 'revision-next' });
    let call = 0;
    const engine = createDurableSyncEngine({ ...fixture.options, origin: 'chrome-extension://extension-id',
      now: () => clock.now, schedule: () => undefined, pullApplier: fixture.applier,
      endpoints: async () => ({ syncPull: 'https://known.example/pull', syncAck: 'https://known.example/ack',
        syncSnapshot: 'https://known.example/snapshot' }),
      sessions: { async get(force = false) { forced.push(force);
        return { credential: { accessToken: 'access-token' }, session: session(serverCursor) }; } },
      pushWorker: { async drain() { return { outcome: 'idle' } as never; } },
      snapshotProjector: async (rows) => rows,
      fetch: async (input, init) => { const url = String(input);
        if (url.includes('/pull')) { pullCursors.push(String(new URL(url).searchParams.get('cursor'))); call += 1;
          if (call === 1) return Response.json(first);
          if (call === 2) return Response.json(conflicting);
          return Response.json(pullFixtures.page({ events: [], nextCursor: 'cursor-next-2',
            collectionRevision: 'revision-next-2' })); }
        const cursor = (JSON.parse(String(init?.body)) as { readonly cursor: string }).cursor;
        return Response.json({ replicaId: scope.replicaId, ackedCursor: cursor, ackedAt: '2026-07-28T00:00:00Z' }); } });
    await fixture.store.putMapping(scope, mappingInput('native-blocker', 'node-created-1'));

    // wake 0: the page blocks on the pre-existing mapping and freezes.
    await engine.wake('manual');
    const blocked = await fixture.store.exportScope(scope);
    assert.equal(blocked.pullPages[0]?.state, 'blocked');
    assert.equal(blocked.engine.recoveryFrozen, true);
    assert.equal(blocked.engine.authorityRefreshRequired, true);

    assert.equal(blocked.scope?.lifecycle, 'recovery_required');
    assert.equal(blocked.scope?.metadata?.recoveryCode, 'mapping_identity_conflict');

    // wakes 1-3: with and without the replica checkpoint advancing on the server, the
    // engine makes no Pull or Session request and the blocked page keeps its evidence.
    for (const [reason, cursor] of [['manual', 'cursor-old'], ['startup', 'cursor-next-2'], ['alarm', 'cursor-next-2']] as const) {
      serverCursor = cursor; clock.now += 600_000;
      await engine.wake(reason);
    }
    const held = await fixture.store.exportScope(scope);
    assert.equal(held.scope?.lifecycle, 'recovery_required');
    assert.equal(held.engine.recoveryFrozen, true);
    assert.equal(held.scope?.metadata?.recoveryCode, 'mapping_identity_conflict');
    assert.equal(held.pullPages[0]?.state, 'blocked');
    assert.equal(held.pullEvents.length, 1, 'the applied event stays as evidence for Rebuild');
    assert.equal(held.cursor?.cursor ?? held.scope?.checkpoint?.cursor, 'cursor-old');
    assert.equal((await fixture.store.auditIntegrity()).outcome, 'valid');
    // The decisive anti-loop evidence: one Pull, one Session, and a terminal exit.
    assert.deepEqual(pullCursors, ['cursor-old']);
    assert.deepEqual(forced, [false]);
    assert.equal(syncAttentionTerminalCode(held.engine.lastError, held.scope?.metadata?.recoveryCode as string),
      'mapping_identity_conflict');
    assert.equal(needsReplicaRebuild('mapping_identity_conflict'), true);
    fixture.store.close();
  });
});

describe('T-04R2 acceptance: freeze surface and forward path', () => {
  test('freezes only the block family and keeps transport/staging failures retryable', () => {
    for (const code of ['pull_page_reuse', 'recovery_required', 'recovery_capability_premature',
      'recovery_capability_invalid', 'recovery_authority_invalid', 'pull_event_conflict',
      // Snapshot integrity failures are fail-closed too (third review, task 3).
      'snapshot_chain_invalid', 'snapshot_graph_incomplete']) {
      assert.equal(shouldFreezePullApply(new Error(code)), true, code);
    }
    // `constraint_error` is a generic IndexedDB failure: the B1 fix removes its cause
    // instead of freezing every storage error.
    for (const code of ['pull_failed', 'rate_limited', 'network_unavailable', 'pull_page_pending',
      'pull_cursor_discontinuous', 'pull_cursor_missing', 'pull_page_incomplete', 'pull_effect_gate_closed',
      'effect_endpoint_binding_invalid', 'pull_transport_unavailable', 'pull_cursor_not_durable',
      'snapshot_http_503', 'payload_too_large',
      'native_result_unknown', 'range_dependency_pending', 'sync_paused', 'constraint_error']) {
      assert.equal(shouldFreezePullApply(new Error(code)), false, code);
    }
  });

  test('a normal forward chain completes without adoption or blocked pages', async () => {
    const fixture = await setup();
    // Two bookmark creates keep the harness' fake Chrome nodes JSON-stable (a created
    // folder would carry an `url: undefined` key, which the fixture digest rejects).
    await fixture.applier.stage(fixture.page([fixture.createEvent('Bookmark', 1)], 'cursor-1'));
    await fixture.applier.resume();
    await fixture.applier.stage(fixture.page([fixture.createEvent('Bookmark', 2)], 'cursor-2'));
    await fixture.applier.resume();
    const exported = await fixture.store.exportScope(scope);
    assert.equal(exported.cursor?.cursor, 'cursor-2');
    assert.equal(exported.pullPages.length, 2);
    assert.ok(exported.pullPages.every((page) => page.state === 'page_complete'));
    assert.equal(exported.pullEvents.length, 2);
    const diagnostics = (await fixture.store.exportDiagnostics()).records;
    assert.equal(diagnostics.some((row) => row.kind === 'pull_page_handover'), false);
    assert.equal(diagnostics.some((row) => row.kind === 'pull_page_blocked'), false);
    assert.equal(fixture.api.calls.filter((call) => call.kind === 'create').length, 2);
    assert.equal((await fixture.store.auditIntegrity()).outcome, 'valid');
    fixture.store.close();
  });
});
