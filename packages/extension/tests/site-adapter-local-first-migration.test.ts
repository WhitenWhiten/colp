import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, test, vi } from 'vitest';
import { createSourceDatabase, sourceKey } from '../src/site-adapters/source-db.js';
import { migrateLocalFirstBatch } from '../src/site-adapters/local-first-migration.js';
import { legacySite } from '../src/site-adapters/registry.js';
test('migration indexes pending work, preserves old commands and only reopens currently authorized transient failures', async () => {
  const db = createSourceDatabase(new IDBFactory());
  try {
    const context = { connectionId: 'source', installationGeneration: 1, sourceSessionGeneration: 1 };
    const original = { state: 'unknown', command: { commandId: 'old-command', managed: { command: { commandId: 'old-command' } } }, digest: 'original' };
    await db.transaction(['authorities', 'meta', 'savePlans', 'effects', 'outbox', 'observations', 'contentBindings'], 'readwrite', async tx => {
      tx.objectStore('authorities').put({ enabled: true, ...context }, legacySite.adapterId);
      tx.objectStore('meta').put({ enabled: true, liveArchive: true }, 'policy:source');
      for (let i = 0; i < 55; i++) tx.objectStore('savePlans').put({ state: 'approved', plan: { id: `history-${i}`, effects: [], trigger: { kind: 'observation' } } }, `history-${i}`);
      tx.objectStore('savePlans').put({ state: 'approved', plan: { id: 'pending', trigger: { kind: 'observation' }, effects: [{ effectId: 'bookmark', commandId: 'old-command' }] } }, 'pending');
      tx.objectStore('outbox').put(original, 'old-command');
      tx.objectStore('observations').put({ id: 'eligible', ordinal: 1, context, state: 'settled', planning: { reason: 'sourceSyncPending', planIds: [] } }, 'eligible');
      tx.objectStore('observations').put({ id: 'revoked', ordinal: 2, context: { ...context, installationGeneration: 0 }, state: 'settled', planning: { reason: 'sourceSyncPending', planIds: [] } }, 'revoked');
      tx.objectStore('contentBindings').put({ id: 'binding', native: { deviceId: 'device', nativeId: 'native', dateAdded: 10 }, title: 'Saved', parentId: 'parent', url: 'https://example.org', scopeId: 'old-cloud-owner' }, 'binding');
    });
    const lookup = vi.fn(async () => ({ dateAdded: 10, title: 'Saved', parentId: 'parent', url: 'https://example.org' }));
    const ports = { deviceId: 'device', lookup }; let rounds = 0;
    while (await migrateLocalFirstBatch(db, ports)) { if (++rounds > 10) throw Error('migration did not finish'); }
    expect(rounds).toBeGreaterThan(3);
    expect(await db.read('outbox', 'old-command')).toEqual(original);
    expect(await db.read('work', 'pending')).toBeDefined(); expect(await db.read('work', 'history-1')).toBeUndefined();
    expect(await db.read('observations', 'eligible')).toMatchObject({ state: 'pending', readyAt: 0 });
    expect(await db.read('observations', 'revoked')).toMatchObject({ state: 'settled' });
    expect(await db.read('contentBindings', 'binding')).toMatchObject({ scopeId: 'old-cloud-owner', scopeVersion: 2, native: { nativeId: 'native', dateAdded: 10 } });
    expect(await db.read('meta', sourceKey('unrelated'))).toBeUndefined();
    expect(await migrateLocalFirstBatch(db, ports)).toBe(false);
  } finally { await db.close(); }
});

test('v3 repairs device-wide v2 scopes using original owners and leaves unproven records for review', async () => {
  const db = createSourceDatabase(new IDBFactory());
  const native = { deviceId: 'device', nativeId: 'native', dateAdded: 10 };
  const owner = { serverOrigin: 'https://sync.test', accountId: 'original-owner', collectionId: 'original-library' };
  const scopeId = JSON.stringify([owner.serverOrigin, owner.accountId, owner.collectionId]);
  const originalCommand = { commandId: 'original-command', local: { owner }, deviceId: 'device' };
  try {
    await db.transaction(['meta', 'outbox', 'contentBindings'], 'readwrite', async tx => {
      tx.objectStore('meta').put({ stage: 'done' }, 'localFirstMigration:v2');
      tx.objectStore('meta').put({ native, owner }, sourceKey('localSourceTransfer', 'original-command'));
      tx.objectStore('outbox').put({ command: originalCommand, state: 'confirmed' }, 'original-command');
      for (const id of ['proven', 'unproven']) tx.objectStore('contentBindings').put({ id, native, commandId: id === 'proven' ? 'original-command' : 'unknown',
        title: 'Saved', parentId: 'parent', url: 'https://example.org', scopeId: '["local","device"]' }, id);
    });
    const ports = { deviceId: 'device', lookup: async () => ({ dateAdded: 10, title: 'Saved', parentId: 'parent', url: 'https://example.org' }) };
    for (let i = 0; await migrateLocalFirstBatch(db, ports); i++) if (i > 10) throw Error('unbounded migration');
    expect(await db.read('contentBindings', 'proven')).toMatchObject({ scopeId, scopeVersion: 2, native });
    expect(await db.read('contentBindings', 'unproven')).not.toHaveProperty('scopeVersion');
    expect(await db.read('outbox', 'original-command')).toEqual({ command: originalCommand, state: 'confirmed' });
  } finally { await db.close(); }
});
