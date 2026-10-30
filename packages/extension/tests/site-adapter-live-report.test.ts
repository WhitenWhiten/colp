import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, test } from 'vitest';
import { createSourceDatabase } from '../src/site-adapters/source-db.js';
import { sourceLiveReport } from '../src/site-adapters/live-report.js';
import { legacySite } from '../src/site-adapters/registry.js';
import { initialTransportState } from '../src/site-adapters/transport.js';

test('a live report locates admission, planning and native work without exporting content or identities', async () => {
  const db = createSourceDatabase(new IDBFactory()), now = Date.now();
  try {
    await db.transaction(['meta', 'authorities', 'observations', 'work'], 'readwrite', async tx => {
      tx.objectStore('authorities').put({ installationId: legacySite.adapterId, enabled: true, accountId: 'secret-account', connectionId: 'secret-connection' }, legacySite.adapterId);
      tx.objectStore('meta').put({ state: 'active', live: true, collectionIds: ['secret-collection'], root: { nativeId: 'secret-native' } }, 'archiveConfig:secret-connection');
      tx.objectStore('meta').put({ enabled: true, liveArchive: true }, 'policy:secret-connection');
      tx.objectStore('meta').put({ at: now, commandId: 'secret-command' }, 'localPipelineLast:secret-connection');
      for (let i = 0; i < 8; i++) tx.objectStore('observations').put({ id: `observation-${i}`, installationId: legacySite.adapterId, ordinal: i + 1,
        context: { connectionId: 'secret-connection', installationGeneration: 1, sourceSessionGeneration: 1 }, state: i === 7 ? 'pending' : 'settled', acceptedAt: now,
        observation: { type: 'favorite.confirmed', item: { title: 'secret-title', url: 'https://secret.example/' } },
        planning: i === 7 ? undefined : { reason: 'planned', planIds: ['secret-plan'] } }, `observation-${i}`);
      tx.objectStore('work').put({ id: 'secret-plan', connectionId: 'secret-connection', attempts: 2, dueAt: Number.MAX_SAFE_INTEGER,
        reason: 'token=secret https://secret.example/' }, 'secret-plan');
      tx.objectStore('work').put({ id: 'foreign', connectionId: 'foreign-connection', attempts: 1, dueAt: 0, reason: 'network' }, 'foreign');
    });
    const state = { ...initialTransportState(), enabled: true, accountId: 'secret-account', sourceUnresolved: false };
    const report = await sourceLiveReport(db, legacySite, state, new Set());
    expect(report.source).toEqual({ enabled: true, accountConfirmed: true, pendingAccount: false, documents: 0 });
    expect(report.configuration).toMatchObject({ present: true, state: 'active', live: true, policyEnabled: true, policyLive: true, collections: 1 });
    expect(report.events).toMatchObject({ pending: 1, settled: 7 });
    expect(report.events.recent).toHaveLength(5); expect(report.events.recent[0]).toMatchObject({ ordinal: 8, state: 'pending', currentSource: true });
    expect(report.work).toMatchObject({ count: 1, samples: [{ attempts: 2, parked: true, retryAt: null, reason: 'unclassified' }] });
    expect(report.pipeline).toMatchObject({ available: true, localAttention: 1, lastSavedAt: now, reason: 'unclassified' });
    expect(JSON.stringify(report)).not.toContain('secret');
    expect(await db.read('work', 'secret-plan')).toMatchObject({ attempts: 2, dueAt: Number.MAX_SAFE_INTEGER });
  } finally { await db.close(); }
});

test('an unconfigured site has no inherited progress from another site', async () => {
  const db = createSourceDatabase(new IDBFactory());
  try {
    const report = await sourceLiveReport(db, legacySite, initialTransportState(), new Set());
    expect(report.configuration).toMatchObject({ present: false, live: false, policyEnabled: false });
    expect(report.pipeline).toBeNull(); expect(report.events).toMatchObject({ pending: 0, settled: 0, recent: [] });
  } finally { await db.close(); }
});
