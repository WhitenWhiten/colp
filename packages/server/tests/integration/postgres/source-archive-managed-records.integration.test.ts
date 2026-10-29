import { afterAll, beforeAll, expect, test } from 'vitest';
import { sql } from 'kysely';
import { createIsolatedPostgresRuntime, describeWithPostgres, type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createManagedRecordStore, migrateManagedRecords } from '../../../src/infrastructure/source-archives/managed-record-store.js';
import { saveManagedCopy, cancelManagedCopy, observeManagedCopy, claimManagedSemantic, managedSlotKey, sourceHash,
  type ManagedSaveCommand, type ManagedNode, type ManagedSaveState } from '../../../src/modules/source-archives/index.js';

const command = (id: string, itemId = 'one'): ManagedSaveCommand => ({ commandId: id, replicaId: 'replica', collectionId: 'library', parentId: 'folder', parentRevision: 'r1', title: 'Title', url: `https://posts.test/${itemId}`,
  slot: { kind: 'bookmark', copy: { purpose: 'sourceArchive', sourceAccount: 'reader', sourceCollectionId: 'saved', content: { site: 'fixture.posts', identityVersion: 1, accountId: null, itemId } } } });

describeWithPostgres('indexed source archive records', () => {
  let isolated: IsolatedPostgresRuntime;
  const nodes = new Map<string, ManagedNode>();
  const original: ManagedSaveState = { bindings: {}, receipts: {} };
  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('source_records'); await runMigrations(isolated.runtime.db, 'latest');
    const db = isolated.runtime.db;
    await sql`INSERT INTO accounts(id,subject_id,status) VALUES('source-owner','source-subject','active')`.execute(db);
    for (let i = 0; i < 2500; i++) {
      const c = command(`old-${i}`, String(i)), node = { nodeId: `node-${i}`, parentId: c.parentId, title: c.title, url: c.url, revision: 'r1' };
      nodes.set(node.nodeId, node);
      const key = managedSlotKey(c.collectionId, c.slot);
      original.bindings[key] = { collectionId: c.collectionId, slot: c.slot, node, state: 'active' };
      original.receipts[c.commandId] = { version: 1, commandId: c.commandId, key, node, digest: sourceHash(c), disposition: 'created' };
    }
    const state = { version: 1, connections: {}, plans: {}, folders: {}, copies: {}, cancellations: {}, managed: original };
    await sql`INSERT INTO source_archive_accounts(account_id,state_json) VALUES('source-owner',${JSON.stringify(state)}::jsonb)`.execute(db);
  }, 120000);
  afterAll(async () => { await isolated?.close(); });
  const transaction = async <T>(work: (store: ReturnType<typeof createManagedRecordStore>) => Promise<T>) => isolated.runtime.db.transaction().execute(async tx => {
    await sql`SELECT account_id FROM source_archive_accounts WHERE account_id='source-owner' FOR UPDATE`.execute(tx);
    return work(createManagedRecordStore(tx, 'source-owner'));
  });
  test('migration preserves all original receipts while steady state reads only indexed dependencies', async () => {
    await isolated.runtime.db.transaction().execute(async tx => {
      await sql`SELECT account_id FROM source_archive_accounts WHERE account_id='source-owner' FOR UPDATE`.execute(tx);
      await migrateManagedRecords(tx, 'source-owner');
    });
    const header = (await sql<{ state_json: { version: number; managed?: unknown } }>`SELECT state_json FROM source_archive_accounts WHERE account_id='source-owner'`.execute(isolated.runtime.db)).rows[0]!.state_json;
    expect(header.version).toBe(2); expect(header.managed).toBeUndefined();
    const receipt = await transaction(async store => { const state = await store.load('managed.recover', { commandId: 'old-1250', digest: 'unused' }); return state; });
    expect(Object.keys(receipt.receipts)).toEqual(['old-1250']); expect(Object.keys(receipt.bindings)).toHaveLength(0);
    expect(receipt.receipts['old-1250']).toEqual(original.receipts['old-1250']);
    await transaction(async store => {
      const c = command('lookup', '1'), state = await store.load('managed.lookup', { collectionId: 'library', slot: c.slot });
      expect(Object.keys(state.bindings)).toHaveLength(1); expect(Object.keys(state.receipts)).toHaveLength(0);
      await observeManagedCopy(state, 'library', c.slot, { read: async (_library, id) => nodes.get(id) ?? null }); await store.flush();
    });
    const count = (await sql<{ count: string }>`SELECT count(*) AS count FROM source_archive_managed_records WHERE account_id='source-owner' AND kind='receipts'`.execute(isolated.runtime.db)).rows[0]!.count;
    expect(Number(count)).toBe(2500);
  });
  test('two database transactions arbitrate a shared physical copy and recover independent commands', async () => {
    const source = { ...command('source-race', 'new-item'), copyPolicy: 'singleKeepExisting' as const };
    if (source.slot.kind !== 'bookmark') throw new Error('fixture');
    const semantic: ManagedSaveCommand = { ...source, commandId: 'semantic-race', parentId: 'topics', slot: { kind: 'bookmark', copy: { purpose: 'semantic', content: source.slot.copy.content } } };
    if (semantic.slot.kind !== 'bookmark') throw new Error('fixture');
    const copy = semantic.slot.copy;
    const claim = await transaction(async store => {
      const state = await store.load('managed.semantic.claim', { collectionId: 'library', copy, ownerId: 'semantic-race', replicaId: 'replica' });
      const result = claimManagedSemantic(state, 'library', copy, 'semantic-race'); await store.flush(); return result;
    });
    if (claim.status !== 'claimed') throw new Error('fixture');
    semantic.semanticClaim = { ownerId: 'semantic-race', revision: claim.claim.revision };
    let creates = 0;
    const ports = { assertTarget: async () => {}, read: async (_library: string, id: string) => nodes.get(id) ?? null,
      create: async (c: ManagedSaveCommand) => { creates++; const node = { nodeId: 'race-node', parentId: c.parentId, title: c.title, url: c.url, revision: 'r1' }; nodes.set(node.nodeId, node); return node; } };
    const results = await Promise.all([source, semantic].map(c => transaction(async store => {
      const state = await store.load('managed.save', c), result = await saveManagedCopy(state, c, ports); await store.flush(); return result;
    })));
    expect(creates).toBe(1); expect(results[0]!.node.nodeId).toBe(results[1]!.node.nodeId);
    for (const result of results) await transaction(async store => {
      const state = await store.load('managed.recover', { commandId: result.commandId }); expect(state.receipts[result.commandId]).toEqual(result);
    });
  });
  test('a durable cancellation fences a late save while a committed receipt wins the race', async () => {
    const cancelled = command('fenced-registration', 'fenced');
    await transaction(async store => {
      const state = await store.load('managed.cancel', { commandId: cancelled.commandId });
      expect(cancelManagedCopy(state, cancelled.commandId, sourceHash(cancelled))).toBeNull();
      await store.flush();
    });
    let creates = 0;
    const ports = { assertTarget: async () => {}, read: async () => null,
      create: async (c: ManagedSaveCommand) => { creates++; return { nodeId: 'created', parentId: c.parentId, title: c.title, url: c.url, revision: 'r1' }; } };
    await expect(transaction(async store => {
      const state = await store.load('managed.save', cancelled);
      return saveManagedCopy(state, cancelled, ports);
    })).rejects.toThrow('source_command_cancelled');
    expect(creates).toBe(0);
    const committed = command('committed-registration', 'committed');
    const receipt = await transaction(async store => {
      const state = await store.load('managed.save', committed), result = await saveManagedCopy(state, committed, ports);
      await store.flush(); return result;
    });
    const recovered = await transaction(async store => {
      const state = await store.load('managed.cancel', { commandId: committed.commandId });
      const result = cancelManagedCopy(state, committed.commandId, sourceHash(committed)); await store.flush(); return result;
    });
    expect(recovered).toEqual(receipt);
    expect(creates).toBe(1);
  });
  test('binding listing is keyset paged independently of retained receipts', async () => {
    const first = await transaction(store => store.list('library', null));
    expect(first.bindings).toHaveLength(100); expect(first.nextCursor).toMatch(/^v2:/u);
    const next = await transaction(store => store.list('library', first.nextCursor));
    expect(next.bindings).toHaveLength(100);
    expect(new Set([...first.bindings, ...next.bindings].map(b => b.key)).size).toBe(200);
  });
});

describeWithPostgres('managed record migration rollback', () => {
  let isolated: IsolatedPostgresRuntime;
  beforeAll(async () => { isolated = await createIsolatedPostgresRuntime('source_records_rollback'); await runMigrations(isolated.runtime.db, 'latest'); }, 120000);
  afterAll(async () => { await isolated?.close(); });
  test('an interrupted migration retains the original version and receipts for the next attempt', async () => {
    const db = isolated.runtime.db, c = command('toString', 'legacy'), node = { nodeId: 'legacy', parentId: 'folder', title: 'Title', url: c.url, revision: 'r1' };
    const key = managedSlotKey('library', c.slot), receipt = { version: 1, commandId: c.commandId, digest: sourceHash(c), key, node, disposition: 'created' };
    const legacy = { version: 1, folders: {}, copies: {}, managed: { bindings: { [key]: { slot: c.slot, collectionId: 'library', state: 'active', node } }, receipts: { toString: receipt } } };
    await sql`INSERT INTO accounts(id,subject_id,status) VALUES('owner','subject','active')`.execute(db);
    await sql`INSERT INTO source_archive_accounts(account_id,state_json) VALUES('owner',${JSON.stringify(legacy)}::jsonb)`.execute(db);
    await expect(db.transaction().execute(async tx => { await migrateManagedRecords(tx, 'owner'); throw new Error('worker-cut'); })).rejects.toThrow('worker-cut');
    expect((await sql<{ count: string }>`SELECT count(*) AS count FROM source_archive_managed_records`.execute(db)).rows[0]!.count).toBe('0');
    expect((await sql<{ version: string }>`SELECT state_json->>'version' AS version FROM source_archive_accounts`.execute(db)).rows[0]!.version).toBe('1');
    await db.transaction().execute(async tx => {
      await migrateManagedRecords(tx, 'owner'); const store = createManagedRecordStore(tx, 'owner');
      const state = await store.load('managed.save', c);
      expect(state.receipts.toString).toEqual(receipt);
      expect(Object.keys(state.bindings)).toHaveLength(0);
    });
  });
});
