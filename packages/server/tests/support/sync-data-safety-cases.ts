import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Problem, SyncPushResult } from '@know-n/colp/types';
import { resolveProductConflictInTransaction } from '../../src/infrastructure/sync/sync-conflict-resolution-postgres.js';
import { syncNodeDeletePushRequest } from '../fixtures/phase3/sync-node-delete.js';
import { syncNodeUpdatePushRequest } from '../fixtures/phase3/sync-node-update.js';
import { observeSubtree } from './subtree-observation.js';
import type { IsolatedPostgresRuntime } from './postgres-test-runtime.js';
import type { createSyncSessionBlackBoxClient } from './sync-session-black-box-client.js';

type Identity = { session: { sessionId: string }; replica: { replicaId: string } };
interface Harness<C extends Identity> {
  runtime: IsolatedPostgresRuntime['runtime']; collectionId: string; accountId: string; subjectId: string;
  seedNode(kind: 'folder' | 'bookmark', input: { parentId?: string; title?: string }): Promise<{ id: string; revision: string }>;
  context(role?: 'owner' | 'editor' | 'viewer', version?: '0.1' | '0.2'): Promise<C>;
  start(context: C): Promise<{ origin: string }>;
  blackBox(origin: string): ReturnType<typeof createSyncSessionBlackBoxClient>;
  result(body: Problem | SyncPushResult): SyncPushResult;
  openConflict(): Promise<{ value: C; conflictId: string; revision: string }>;
}

export async function verifyObservedSubtreeSafety<C extends Identity>(h: Harness<C>): Promise<void> {
  const { runtime, collectionId: COLLECTION, accountId: ACCOUNT, subjectId: SUBJECT, seedNode, context, start, blackBox, result, openConflict } = h;
  const isolated = { runtime };
    for (const variant of ['updated', 'inserted', 'legacy'] as const) {
      const parent = await seedNode('folder', { title: 'Observed parent' });
      const nested = await seedNode('folder', { parentId: parent.id });
      const child = await seedNode('bookmark', { parentId: nested.id, title: 'Original' });
      const source = await observeSubtree(isolated.runtime.db, parent.id);
      if (variant === 'updated') {
        const b = await context('owner', '0.2'); const sb = await start(b);
        const updated = await blackBox(sb.origin).push({ idempotencyKey: `ds04-update-${randomUUID()}`,
          request: syncNodeUpdatePushRequest({ sessionId: b.session.sessionId, replicaId: b.replica.replicaId,
            collectionId: COLLECTION, targetId: child.id, baseRevision: child.revision,
            opId: `ds04-update-${randomUUID()}`, base: { title: 'Original' }, value: { title: 'Important new edit' } }) });
        assert.equal(result(updated.body).results[0]?.status, 'applied');
      }
      if (variant === 'inserted') await seedNode('bookmark', { parentId: nested.id, title: 'Unobserved addition' });
      const a = await context('owner', '0.2'); const sa = await start(a);
      const response = await blackBox(sa.origin).push({ idempotencyKey: `ds04-delete-${randomUUID()}`,
        request: syncNodeDeletePushRequest({ sessionId: a.session.sessionId, replicaId: a.replica.replicaId,
          collectionId: COLLECTION, targetId: parent.id, baseRevision: parent.revision,
          opId: `ds04-delete-${randomUUID()}`, subtree: true, ...(variant === 'legacy' ? {} : { source }) }) });
      assert.equal((response.body as Problem).code, variant === 'legacy' ? 'precondition_required' : 'revision_conflict');
      const row = (await isolated.runtime.pool.query('select deleted_at from nodes where id=$1', [child.id])).rows[0];
      assert.equal(row.deleted_at, null);
      assert.equal((await isolated.runtime.pool.query('select count(*)::int n from sync_node_tombstones where root_target_id=$1', [parent.id])).rows[0].n, 0);
    }
}

export async function verifyResolutionLaneSafety<C extends Identity>(h: Harness<C>): Promise<void> {
  const { runtime, collectionId: COLLECTION, accountId: ACCOUNT, subjectId: SUBJECT, seedNode, context, start, blackBox, result, openConflict } = h;
  const isolated = { runtime };
    const opened = await openConflict();
    const other = await seedNode('bookmark', { title: 'Another bookmark' });
    const pending = syncNodeUpdatePushRequest({ sessionId: opened.value.session.sessionId,
      replicaId: opened.value.replica.replicaId, collectionId: COLLECTION, targetId: other.id,
      baseRevision: other.revision, sequence: 2, opId: `ds05-pending-${randomUUID()}`,
      base: { title: 'Another bookmark' }, value: { title: 'Offline edit' } });
    const command = { accountId: ACCOUNT, subjectId: SUBJECT, conflictId: opened.conflictId,
      expectedRevision: opened.revision, commandId: `ds05-resolve-${randomUUID()}`, resolution: 'server' as const };
    const resolve = () => isolated.runtime.db.transaction().execute(tx => resolveProductConflictInTransaction(tx,
      command, { conflictPayloadKeyring: { active: { key: Buffer.alloc(32, 71), keyVersion: 7 }, retained: [] } }));
    const resolved = await resolve();
    assert.notEqual(resolved.operation.replicaId, opened.value.replica.replicaId);
    assert.equal(resolved.operation.sequence, 1);
    assert.deepEqual(await resolve(), resolved);
    const server = await start(opened.value);
    const pushed = await blackBox(server.origin).push({ idempotencyKey: `ds05-pending-${randomUUID()}`, request: pending });
    assert.equal(result(pushed.body).results[0]?.status, 'applied');
    assert.equal((await isolated.runtime.pool.query('select count(*)::int n from sync_resolution_authors where operation_id=$1',
      [resolved.operation.opId])).rows[0].n, 1);
    await assert.rejects(isolated.runtime.pool.query('delete from sync_resolution_authors where operation_id=$1', [resolved.operation.opId]));
}
