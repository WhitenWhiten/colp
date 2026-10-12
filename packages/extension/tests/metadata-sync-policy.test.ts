import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { containsMetadataUpload, createMetadataSyncPolicyStore, metadataPolicyKey,
  parseMetadataPolicy, type MetadataPolicyScope } from '../src/metadata-sync-policy.js';

const scope: MetadataPolicyScope = { serverOrigin: 'https://known.example', accountId: 'account-a', collectionId: 'collection-a' };
function fixture() {
  const data: Record<string, unknown> = {};
  const storage = { async get(key: string) { return { [key]: data[key] }; },
    async set(value: Record<string, unknown>) { Object.assign(data, value); } };
  return { data, storage, policy: createMetadataSyncPolicyStore(storage) };
}

describe('metadata sync consent', () => {
  it('persists a negative choice across worker recreation', async () => {
    const { policy, storage } = fixture();
    await policy.write(scope, false);
    const restarted = createMetadataSyncPolicyStore(storage);
    assert.equal((await restarted.read(scope)).mode, 'local-only');
    await assert.rejects(restarted.capture(scope), /metadata_sync_disabled/u);
    let sent = false;
    await assert.rejects(restarted.dispatch(scope, async () => { sent = true; }), /metadata_sync_disabled/u);
    assert.equal(sent, false);
  });
  it('isolates the server, account and collection independently', async () => {
    const { policy } = fixture();
    await policy.write(scope, false);
    for (const other of [{ ...scope, accountId: 'account-b' }, { ...scope, collectionId: 'collection-b' },
      { ...scope, serverOrigin: 'https://other.example' }]) {
      await policy.write(other, true);
      assert.equal((await policy.read(other)).mode, 'sync');
      assert.equal((await policy.read(scope)).mode, 'local-only');
    }
  });
  it('distinguishes tuple keys containing punctuation', () => {
    assert.notEqual(metadataPolicyKey({ ...scope, accountId: 'a:b', collectionId: 'c' }),
      metadataPolicyKey({ ...scope, accountId: 'a', collectionId: 'b:c' }));
  });
  it('requires affirmative consent for missing, corrupt and future records', () => {
    assert.equal(parseMetadataPolicy(undefined).mode, 'local-only');
    for (const value of [null, true, [], {}, { mode: 'sync' }, { mode: 'sync', revision: 'broken' },
      { mode: 'sync', revision: crypto.randomUUID(), future: true }]) {
      assert.equal(parseMetadataPolicy(value).mode, 'local-only');
    }
  });
  it('does not infer permission from a pre-policy installation or a new collection', async () => {
    const { policy } = fixture();
    await assert.rejects(policy.capture(scope), /metadata_sync_disabled/u);
    let sent = false;
    await assert.rejects(policy.dispatch(scope, async () => { sent = true; }), /metadata_sync_disabled/u);
    assert.equal(sent, false);
  });
  it('invalidates an old scan even when the user subsequently opts in again', async () => {
    const { policy } = fixture();
    await policy.write(scope, true);
    const assertCurrent = await policy.capture(scope);
    await assertCurrent();
    await policy.write(scope, false);
    await policy.write(scope, true);
    await assert.rejects(assertCurrent(), /metadata_sync_disabled/u);
    await (await policy.capture(scope))();
  });
  it('orders upload admission behind an already requested off switch', async () => {
    const { policy } = fixture();
    await policy.write(scope, true);
    let sent = false;
    const disable = policy.write(scope, false);
    const dispatch = policy.dispatch(scope, async () => { sent = true; });
    await disable;
    await assert.rejects(dispatch, /metadata_sync_disabled/u);
    assert.equal(sent, false);
  });
  it('does not let a stalled response prevent disabling or admitting other scopes', async () => {
    const { policy } = fixture();
    await policy.write(scope, true);
    await policy.write({ ...scope, collectionId: 'other' }, true);
    let finish!: (value: string) => void;
    let admitted!: () => void;
    const started = new Promise<void>(resolve => { admitted = resolve; });
    const response = policy.dispatch(scope, () => { admitted(); return new Promise<string>(resolve => { finish = resolve; }); });
    await started;
    await policy.write(scope, false);
    assert.equal(await policy.dispatch({ ...scope, collectionId: 'other' }, async () => 'other'), 'other');
    await assert.rejects(policy.dispatch(scope, async () => 'late'), /metadata_sync_disabled/u);
    finish('already dispatched');
    assert.equal(await response, 'already dispatched');
  });
  it('does not poison the admission lane on a synchronous network error', async () => {
    const { policy } = fixture();
    await policy.write(scope, true);
    await assert.rejects(policy.dispatch(scope, () => { throw new Error('network'); }), /network/u);
    await policy.write(scope, false);
    assert.equal((await policy.read(scope)).mode, 'local-only');
  });
  it('keeps an off intent denied in memory when persisting it fails', async () => {
    const { policy, storage } = fixture();
    await policy.write(scope, true);
    storage.set = async () => { throw new Error('storage_write_failed'); };
    await assert.rejects(policy.write(scope, false), /storage_write_failed/u);
    assert.equal((await policy.read(scope)).mode, 'local-only');
    let sent = false;
    await assert.rejects(policy.dispatch(scope, async () => { sent = true; }), /metadata_sync_disabled/u);
    assert.equal(sent, false);
  });
  it('does not turn unreadable storage into upload consent', async () => {
    const policy = createMetadataSyncPolicyStore({ get: async () => { throw new Error('storage'); }, set: async () => undefined });
    let sent = false;
    await assert.rejects(policy.dispatch(scope, async () => { sent = true; }), /storage/u);
    assert.equal(sent, false);
  });
  it('rejects invalid scope and nonboolean consent', async () => {
    const { policy } = fixture();
    assert.throws(() => metadataPolicyKey({ ...scope, accountId: '' }), /metadata_scope_invalid/u);
    await assert.rejects(policy.write(scope, 'yes' as unknown as boolean), /metadata_policy_invalid/u);
  });
});

describe('immutable COLP metadata dispatch detection', () => {
  const body = (payload: unknown) => JSON.stringify({ sessionId: 's', batchId: 'b', atomic: false,
    operations: [{ type: 'update_node_content', payload }] });
  it('detects tags, clear operations and descriptions without modifying the body', () => {
    for (const payload of [{ value: { tags: ['private'] } }, { value: { tags: [] } },
      { value: { description: null } }, { node: { description: 'private' } }]) {
      const encoded = body(payload), original = encoded;
      assert.equal(containsMetadataUpload(encoded), true);
      assert.equal(encoded, original);
    }
  });
  it('allows empty defaults only when a new server-selected node is being created', () => {
    const create = (node: unknown) => JSON.stringify({ operations: [{ type: 'create_node', payload: { node } }] });
    assert.equal(containsMetadataUpload(create({ title: 'Bookmark', tags: [], description: null })), false);
    assert.equal(containsMetadataUpload(create({ title: 'Bookmark', description: '' })), false);
    assert.equal(containsMetadataUpload(create({ tags: ['private'] })), true);
    assert.equal(containsMetadataUpload(create({ description: 'private' })), true);
    assert.equal(containsMetadataUpload(body({ value: { tags: [], description: null } })), true);
  });
  it('does not gate ordinary bookmark writes, ack traffic, or copy mentioning metadata', () => {
    for (const value of [undefined, null, '', 'not json', '{}', '[]', JSON.stringify({ cursor: 'x' }),
      body({ value: { title: 'tags and description', url: 'https://example.org' } }), body({ newParentId: 'folder' })]) {
      assert.equal(containsMetadataUpload(value), false);
    }
  });
});
