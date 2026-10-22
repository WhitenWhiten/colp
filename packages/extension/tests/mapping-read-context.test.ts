import assert from 'node:assert/strict';
import { test } from 'vitest';
import { resumeLocalProjection } from '../src/local-projection-recovery.js';
import { leftoverVirtualChildrenNeedReproject, unprotectedProjectionIntents } from '../src/recovery-guard.js';
import { createMappingReadContext } from '../src/sync-state/mapping-repository.js';
import type { MappingInput, SyncScope } from '../src/sync-state-store.js';

const scope = {
  environment: 'development', serverId: 'server', serverOrigin: 'https://example.test',
  accountId: 'account', browserProfileId: 'profile', collectionId: 'collection',
  replicaId: 'replica', generation: 1,
} as SyncScope;

const native = mapping('1', 'root');
const virtual = mapping('recovery:child', 'child', { parentColpId: 'root', nodeKind: 'bookmark',
  projection: { revision: 'r', digest: 'd', content: { title: 'Child', url: 'https://child.test/' } } });

test('a mapping snapshot freezes nested projection content without freezing the source', async () => {
  const content = { title: 'Child', url: 'https://child.test/' };
  const childrenOrder = ['child'];
  const source = mapping('1', 'root', { projection: { revision: 'r', digest: 'd', content, childrenOrder } });
  let lists = 0;
  const store = {
    async listMappings() {
      lists += 1;
      return [source];
    },
  };
  const reads = createMappingReadContext(store, scope);
  const rows = await reads.read();
  assert.equal(Object.isFrozen(rows), true);
  assert.equal(Object.isFrozen(rows[0]), true);
  assert.equal(Object.isFrozen(rows[0]?.projection), true);
  assert.equal(Object.isFrozen(rows[0]?.projection.content), true);
  assert.equal(Object.isFrozen(rows[0]?.projection.childrenOrder), true);
  assert.throws(() => {
    (rows[0]!.projection.content as { title: string }).title = 'Changed';
  }, TypeError);
  assert.equal(content.title, 'Child');
  assert.equal(Object.isFrozen(source), false);
  assert.equal(Object.isFrozen(source.projection), false);
  assert.equal(rows[0]?.projection.content?.title, 'Child');
  assert.equal((await reads.read())[0]?.projection.content?.title, 'Child');
  assert.equal(lists, 1);
});

test('one unchanged phase lists mappings once and a write is visible after invalidation', async () => {
  let rows = [native];
  let lists = 0;
  const store = {
    async listMappings() {
      lists += 1;
      return rows.map((row) => ({ ...row }));
    },
    async listMountBindings() { return []; },
  };
  const reads = createMappingReadContext(store, scope);
  const guard = store as never;
  assert.equal(await leftoverVirtualChildrenNeedReproject(guard, scope, await reads.read()), false);
  assert.equal(await leftoverVirtualChildrenNeedReproject(guard, scope, await reads.read()), false);
  assert.equal(lists, 1);
  rows = [native, virtual];
  assert.equal(await leftoverVirtualChildrenNeedReproject(guard, scope, await reads.read()), false);
  reads.invalidate();
  assert.equal(await leftoverVirtualChildrenNeedReproject(guard, scope, await reads.read()), true);
  assert.equal(lists, 2);
});

test('a no-work projection resume lists mappings once', async () => {
  let lists = 0;
  const store = projectionStore(() => {
    lists += 1;
    return [native];
  });
  await resumeLocalProjection({
    store: store as never, scope, snapshotProjector: async () => { throw new Error('unexpected_projection'); },
  }, async () => { throw new Error('unexpected_session'); }, createMappingReadContext(store, scope));
  assert.equal(lists, 1);
});

test('projection sees the pre-write snapshot and the following check sees the write', async () => {
  let projected = false;
  const generations: string[] = [];
  const written = mapping('written', 'fresh', { nodeKind: 'bookmark' });
  const store = projectionStore(() => {
    generations.push(projected ? 'after-write' : 'before-write');
    return projected ? [native, written] : [native, virtual];
  }, {
    async listLocalIssues() { return [{ nativeId: 'written', code: 'held' }]; },
    async listProjectionIntents() { return [{ intentId: 'held', colpId: 'fresh', state: 'executing', kind: 'update' }]; },
  });
  await resumeLocalProjection({
    store: store as never, scope, now: () => 10,
    snapshotProjector: async (rows) => {
      assert.deepEqual(rows.map((row) => row.nativeId), ['1', 'recovery:child']);
      projected = true;
      return rows;
    },
  }, session, createMappingReadContext(store, scope));
  assert.deepEqual(generations, ['before-write', 'after-write']);
  assert.equal(store.unfrozen, true);
});

test('a live special root keeps its role when no mount binding matches', async () => {
  const special = mapping('1', 'mount-bar', { rootRole: 'bookmarks-bar' });
  const store = projectionStore(() => [special]);
  assert.equal(await leftoverVirtualChildrenNeedReproject(store as never, scope), false);
});

test('unprotected projection intents read mappings when the caller did not preload them', async () => {
  let lists = 0;
  const store = projectionStore(() => {
    lists += 1;
    return [native];
  }, {
    async listProjectionIntents() {
      return [
        { intentId: 'free', colpId: 'free', state: 'executing', kind: 'update' },
        { intentId: 'done', colpId: 'done', state: 'terminal', kind: 'update' },
      ];
    },
  });
  const rows = await unprotectedProjectionIntents(store as never, scope);
  assert.deepEqual(rows.map((row) => row.intentId), ['free']);
  assert.equal(lists, 1);
});

function mapping(nativeId: string, colpId: string, overrides: Partial<MappingInput> = {}): MappingInput {
  return {
    nativeId, colpId, rootNativeId: '1', nodeKind: 'folder',
    projection: { revision: 'r', digest: 'd', content: { title: nativeId } },
    ...overrides,
  };
}

function projectionStore(list: () => readonly MappingInput[], extras: {
  listLocalIssues?: () => Promise<readonly unknown[]>;
  listProjectionIntents?: () => Promise<readonly unknown[]>;
} = {}) {
  const engine = {
    phase: 'sleeping' as const, recoveryFrozen: false, revision: 3, localProjectionOwner: undefined as number | undefined,
    updatedAt: 1, authorityRefreshRequired: false,
  };
  return {
    unfrozen: false,
    async getEngineState() { return { ...engine }; },
    async listMappings() { return list().map((row) => ({ ...row })); },
    async listMountBindings() { return []; },
    async listProjectionIntents() { return extras.listProjectionIntents?.() ?? []; },
    async listLocalIssues() { return extras.listLocalIssues?.() ?? []; },
    async getScope() {
      return { lifecycle: 'active', generation: scope.generation, lease: { leaseId: 'lease-1', generation: '1' } };
    },
    async listAckIntents() { return [{ kind: 'bootstrap', state: 'complete' }]; },
    async hasRecoveryStaging() { return false; },
    async transitionEngine(_scope: SyncScope, next: { readonly recoveryFrozen?: boolean; readonly localProjectionOwner?: number }) {
      engine.revision += 1;
      engine.recoveryFrozen = next.recoveryFrozen === true;
      engine.localProjectionOwner = next.localProjectionOwner;
      if (next.recoveryFrozen === false) this.unfrozen = true;
      return { ...engine };
    },
  };
}

function session() {
  return {
    credential: { accessToken: 'token' },
    session: {
      snapshotRequired: false,
      replicaLease: { leaseId: 'lease-1', generation: '1', state: 'active' },
    },
  } as never;
}
