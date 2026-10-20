import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import { createReplicaRebuilder } from '../src/replica-rebuild.js';
import { setupRetirement } from './replica-retirement-harness.js';

const fixtures: Awaited<ReturnType<typeof setupRetirement>>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });

for (const counts of [{ history: 0, pending: 117 }, { history: 117, pending: 2 }]) {
  test(`restarted retirement preview counts ${counts.pending} live operations past ${counts.history} historical terminal rows`, async () => {
    const f = await setupRetirement(true, counts); fixtures.push(f);
    const initial = await f.rebuilder.handle({ kind: 'known.scope.rebuild.preview' });
    assert.ok(initial.ok && 'preview' in initial);
    assert.equal(initial.preview.queuedOperations, counts.pending);
    f.setResponse(async () => { throw new Error('response_lost'); });
    assert.deepEqual(await f.rebuilder.handle(await f.request()), { ok: false, code: 'retirement_pending' });
    const before = await f.store.exportScope(f.scope);
    f.store.close();
    const restarted = createReplicaRebuilder(f.deps);
    const pending = await restarted.handle({ kind: 'known.scope.rebuild.preview' });
    assert.ok(pending.ok && 'preview' in pending);
    assert.equal(pending.preview.queuedOperations, counts.pending);
    assert.deepEqual(await f.store.exportScope(f.scope), before, 'preview never rewrites or prunes queue history');
    assert.equal(f.requests.length, 1, 'preview cannot retry the retirement request');
    assert.deepEqual(await f.credentials.loadBinding(), f.binding);
    f.setResponse(async () => new Response(null, { status: 204 }));
    f.setOfflineRegistration(true);
    assert.deepEqual(await restarted.handle(await f.request()), { ok: false, code: 'offline' });
    const archivedRows = (await f.store.exportArchive(f.scope)).queue;
    assert.ok(Array.isArray(archivedRows)); assert.equal(archivedRows.length, counts.history + counts.pending);
    const archived = await createReplicaRebuilder(f.deps).handle({ kind: 'known.scope.rebuild.preview' });
    assert.ok(archived.ok && 'preview' in archived);
    assert.equal(archived.preview.queuedOperations, counts.pending, 'archive retains the count the user confirmed');
    f.setOfflineRegistration(false);
    assert.equal(await createReplicaRebuilder(f.deps).resume(), true);
    assert.equal(f.requests.length, 2, 'confirmed retirement is not repeated after local archive');
  });
}
