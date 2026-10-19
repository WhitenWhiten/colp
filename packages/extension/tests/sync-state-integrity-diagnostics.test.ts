import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, test } from 'vitest';
import { STORES } from '../src/sync-state/schema.js';
import { INTEGRITY_DETAIL_LIMIT, integrityRecordKey } from '../src/sync-state/scope-repository.js';
import { createSyncStateStore, type SyncScope } from '../src/sync-state-store.js';

const scope: SyncScope = Object.freeze({
  environment: 'production', serverId: 'server-a', serverOrigin: 'https://known.example',
  accountId: 'account-a', browserProfileId: 'profile-a', collectionId: 'collection-a',
  replicaId: 'replica-a', generation: 1,
});
const other = { ...scope, accountId: 'account-b' } as SyncScope;
const SECRETS = ['SECRET-TITLE', 'SECRET-MAPPING', 'SECRET-QUEUE', 'SECRET-BODY', 'SECRET-NOTE',
  'private.example', 'token-value'];

let indexedDB: IDBFactory;
beforeEach(() => { indexedDB = new IDBFactory(); });

test('integrity audit localizes every bad record by store/key/code without leaking content', async () => {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease-a', expiresAt: 10_000 },
    checkpoint: { serverRevision: 'rev', cursor: 'cursor' }, selectedRoots: [] });
  await store.registerScope({ ...other, lifecycle: 'active', lease: { leaseId: 'lease-b', expiresAt: 10_000 },
    checkpoint: { serverRevision: 'rev', cursor: 'cursor' }, selectedRoots: [] });
  const key = (await store.getScope(scope))!.scopeKey;
  const key2 = (await store.getScope(other))!.scopeKey;
  const db = await store.open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORES.queue, STORES.bookmarkEvents, STORES.mappings, STORES.pullPages,
      STORES.engine, STORES.recovery], 'readwrite');
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error as Error); tx.onabort = () => reject(tx.error as Error);
    // Two invalid queue rows in one scope: the first must not hide the second.
    tx.objectStore(STORES.queue).put({ scopeKey: key, sequence: 7, opId: 'op-bad-7', status: 'mystery',
      payload: { title: 'SECRET-QUEUE' } });
    tx.objectStore(STORES.queue).put({ scopeKey: key, sequence: 9, opId: 'op-bad-9', status: 'mystery',
      payload: { title: 'SECRET-QUEUE' } });
    // Another scope is localized independently.
    tx.objectStore(STORES.queue).put({ scopeKey: key2, sequence: 8, opId: 'op-bad-other', status: 'mystery' });
    tx.objectStore(STORES.bookmarkEvents).put({ scopeKey: key, eventId: 'bad-event', dedupeKey: 'dedupe-bad',
      occurredAt: '2026-10-01T00:00:00.000Z', kind: 'change', nativeId: 'native-bad', ordinal: 1,
      status: 'broken', opId: null,
      details: { title: 'SECRET-TITLE', url: 'https://private.example/bookmark', body: 'SECRET-BODY',
        note: 'SECRET-NOTE' } });
    tx.objectStore(STORES.mappings).put({ scopeKey: key, nativeId: 'bad-native', colpId: 'bad-colp',
      rootNativeId: 'native-root', nodeKind: 'not-a-kind',
      projection: { revision: 'r', digest: 'sha256:r', content: { title: 'SECRET-MAPPING',
        url: 'https://private.example/mapping' } } });
    tx.objectStore(STORES.pullPages).put({ scopeKey: key, pageId: 'bad-page', state: 'nonsense',
      previousCursor: 'cursor', nextCursor: 'cursor', pageDigest: 'sha256:bad', title: 'SECRET-TITLE' });
    tx.objectStore(STORES.engine).put({ scopeKey: key });
    tx.objectStore(STORES.recovery).put({ scopeKey: key, snapshotId: 'bad-snapshot' });
  });

  await assert.rejects(() => store.auditIntegrity(), /corruption_detected/);
  const exported = await store.exportDiagnostics();
  assert.equal(exported.mode, 'diagnostic_read_only');
  const corruption = exported.records.find((record) => record.kind === 'corruption' &&
    Array.isArray(record.details)) as { readonly problems: string[]; readonly details: Array<Record<string, unknown>>;
    readonly truncated?: boolean } | undefined;
  assert.ok(corruption, 'a corruption diagnostic with structured details is persisted');
  assert.ok(Array.isArray(corruption.problems) && corruption.problems.every((code) => typeof code === 'string'));
  assert.equal(corruption.problems.filter((code) => code === 'bad_record').length, 1);
  const details = corruption.details;
  assert.ok(details.length >= 6 && details.length <= 32);
  for (const detail of details) {
    assert.deepEqual(Object.keys(detail).sort(), ['code', 'key', 'scope', 'store']);
    assert.equal(typeof detail.store, 'string'); assert.equal(typeof detail.key, 'string');
    assert.equal(typeof detail.scope, 'string'); assert.equal(typeof detail.code, 'string');
  }
  const queue = details.filter((detail) => detail.store === STORES.queue);
  assert.ok(queue.some((detail) => String(detail.key).includes('sequence=7')));
  assert.ok(queue.some((detail) => String(detail.key).includes('sequence=9')), 'second bad row is not hidden');
  assert.ok(queue.some((detail) => String(detail.key).includes('sequence=8')), 'other scope is localized');
  assert.equal(new Set(queue.map((detail) => detail.scope)).size, 2, 'both scopes have distinct references');
  assert.ok(details.some((detail) => detail.store === STORES.bookmarkEvents
    && String(detail.key).includes('eventId=bad-event') && detail.code === 'bookmark_event_status_invalid'));
  assert.ok(details.some((detail) => detail.store === STORES.mappings
    && String(detail.key).includes('nativeId=bad-native') && detail.code === 'node_kind_invalid'));
  assert.ok(details.some((detail) => detail.store === STORES.pullPages
    && String(detail.key).includes('pageId=bad-page') && detail.code === 'pull_page_invalid'));
  assert.ok(details.some((detail) => detail.store === STORES.engine && detail.key === 'engine' && typeof detail.code === 'string' && detail.code.length > 0));
  assert.ok(details.some((detail) => detail.store === STORES.recovery
    && String(detail.key).includes('snapshotId=bad-snapshot') && detail.code === 'recovery_header_invalid'));
  const diagnostic = JSON.stringify(corruption);
  for (const secret of SECRETS) assert.equal(diagnostic.includes(secret), false, `no raw content: ${secret}`);
  store.close();
});

test('a relation-only corruption keeps the public problem array and writes no record details', async () => {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease-a', expiresAt: 10_000 },
    checkpoint: { serverRevision: 'rev', cursor: 'cursor' }, selectedRoots: [] });
  await store.injectCorruptionForTest('orphan_receipt', scope);
  await assert.rejects(() => store.auditIntegrity(), /corruption_detected/);
  const exported = await store.exportDiagnostics();
  const corruption = exported.records.find((record) => record.kind === 'corruption'
    && !Array.isArray(record.details)) as { readonly problems?: readonly string[] } | undefined;
  assert.ok(corruption?.problems?.includes('orphan_receipt'));
  store.close();
});

test('integrity keys keep only durable ids, hash scopes, and fall back when ids are unusable', () => {
  const scopeKey = 'scope\u001faccount-secret';
  const cases: Array<[string, Record<string, unknown>, string, string]> = [
    [STORES.queue, { sequence: 7, opId: 'op-7' }, 'sequence=7,opId=op-7', 'sequence=?'],
    [STORES.receipts, { receiptId: 'receipt-1', sequence: 3 }, 'receiptId=receipt-1,sequence=3', 'receiptId=?'],
    [STORES.bookmarkEvents, { eventId: 'event-1' }, 'eventId=event-1', 'eventId=?'],
    [STORES.mappings, { nativeId: 'native-1', colpId: 'colp-1' }, 'nativeId=native-1,colpId=colp-1', 'mapping=?'],
    [STORES.pullPages, { pageId: 'page-1' }, 'pageId=page-1', 'pageId=?'],
    [STORES.pullEvents, { eventId: 'event-2' }, 'eventId=event-2', 'eventId=?'],
    [STORES.effectPages, { eventId: 'event-3', pageNumber: 2 }, 'eventId=event-3,pageNumber=2', 'effectPage=?'],
    [STORES.ackIntents, { intentId: 'ack-1' }, 'intentId=ack-1', 'intentId=?'],
    [STORES.importPlans, { planId: 'plan-1' }, 'planId=plan-1', 'planId=?'],
    [STORES.importNodes, { planId: 'plan-1', sourceNodeId: 'source-1' }, 'planId=plan-1,sourceNodeId=source-1', 'importNode=?'],
    [STORES.recovery, { snapshotId: 'snapshot-1' }, 'snapshotId=snapshot-1', 'snapshotId=?'],
    [STORES.recoveryNodes, { snapshotId: 'snapshot-1', colpId: 'colp-2' }, 'snapshotId=snapshot-1,colpId=colp-2', 'recoveryNode=?'],
    [STORES.intents, { id: 'intent-1' }, 'id=intent-1', 'key=?'],
  ];
  // Empty, oversized, fractional and non-scalar ids never reach the key.
  const unusable = ['', 'x'.repeat(4_097), 1.5, { title: 'SECRET-TITLE' }];
  let next = 0;
  for (const [store, ids, key, fallback] of cases) {
    assert.equal(integrityRecordKey(store, { ...ids, scopeKey, title: 'SECRET-TITLE' }), key, store);
    const bad = Object.fromEntries(Object.keys(ids).map((name) => [name, unusable[(next += 1) % unusable.length]]));
    assert.equal(integrityRecordKey(store, bad), fallback, store);
  }
  assert.equal(integrityRecordKey(STORES.engine, { scopeKey }), 'engine');
  assert.equal(integrityRecordKey(STORES.scopes, {}), 'scopeKey=?');
  assert.equal(integrityRecordKey(STORES.scopes, { scopeKey: 7 }), 'scopeKey=no-scope');
  const hashed = integrityRecordKey(STORES.scopes, { scopeKey });
  assert.match(hashed, /^scopeKey=[0-9a-f]{16}$/u);
  assert.equal(hashed.includes('account-secret'), false);
});

type Row = readonly [store: string, record: Record<string, unknown>];
type CorruptionDetails = { readonly problems: string[]; readonly details: Array<Record<string, string>>;
  readonly truncated: boolean };

/** Writes raw rows beside one registered scope, audits a fresh database and returns its corruption record. */
async function auditRows(rows: (key: string) => readonly Row[]): Promise<CorruptionDetails> {
  const store = createSyncStateStore({ indexedDB: new IDBFactory() });
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease-a', expiresAt: 10_000 },
    checkpoint: { serverRevision: 'rev', cursor: 'cursor' }, selectedRoots: [] });
  const written = rows((await store.getScope(scope))!.scopeKey);
  const db = await store.open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([...new Set(written.map(([name]) => name))], 'readwrite');
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error as Error); tx.onabort = () => reject(tx.error as Error);
    for (const [name, record] of written) tx.objectStore(name).put(record);
  });
  await assert.rejects(() => store.auditIntegrity(), /corruption_detected/);
  const exported = await store.exportDiagnostics();
  store.close();
  const corruption = exported.records.find((record) => record.kind === 'corruption' && Array.isArray(record.details));
  assert.ok(corruption, 'a corruption diagnostic with structured details is persisted');
  return corruption as unknown as CorruptionDetails;
}

/** The base row passes; each variant breaks exactly one condition and is reported on its own. */
function variants(store: string, base: Record<string, unknown>, valid: readonly Record<string, unknown>[],
  broken: readonly Record<string, unknown>[]): Row[] {
  return [base, ...valid, ...broken].map((change) => [store, { ...base, ...change }] as const);
}

function assertLocalized(corruption: CorruptionDetails, store: string, expected: Record<string, string>) {
  const reported = Object.fromEntries(corruption.details.filter((detail) => detail.store === store)
    .map((detail) => [detail.key, detail.code]));
  assert.deepEqual(reported, expected, store);
}

test('integrity audit reports each failing condition of pull pages, pull events and effect pages', async () => {
  const corruption = await auditRows((key) => [
    ...variants(STORES.pullPages, { scopeKey: key, pageId: 'page', state: 'staged', previousCursor: 'cursor-0',
      nextCursor: 'cursor-1', pageDigest: 'sha256:page' }, [{ pageId: 'page-blocked', state: 'blocked' }], [
      { pageId: 'page-scope', scopeKey: 7 }, { pageId: 7 }, { pageId: 'page-state', state: 'nonsense' },
      { pageId: 'page-previous', previousCursor: null }, { pageId: 'page-next', nextCursor: 1 },
      { pageId: 'page-digest', pageDigest: null },
    ]),
    ...variants(STORES.pullEvents, { scopeKey: key, eventId: 'event', pageId: 'page', state: 'staged', ordinal: 0,
      payload: {} }, [], [
      { eventId: 'event-scope', scopeKey: 7 }, { eventId: 7, ordinal: 1 }, { eventId: 'event-page', pageId: 7 },
      { eventId: 'event-state', state: 'nonsense', ordinal: 2 }, { eventId: 'event-ordinal', ordinal: 1.5 },
      { eventId: 'event-text', payload: 'SECRET-BODY', ordinal: 3 }, { eventId: 'event-null', payload: null, ordinal: 4 },
      { eventId: 'event-array', payload: [], ordinal: 5 },
    ]),
    ...variants(STORES.effectPages, { scopeKey: key, eventId: 'event', pageId: 'page', pageNumber: 1,
      pageDigest: 'sha256:effect-1', previousPageDigest: null }, [{ pageNumber: 2, previousPageDigest: 'sha256:effect-1' }], [
      { pageNumber: 3, scopeKey: 7 }, { eventId: 7 }, { pageNumber: 1.5 }, { pageNumber: 0 },
      { pageNumber: 4, pageDigest: null }, { pageNumber: 5, previousPageDigest: 7 },
    ]),
  ]);
  assert.equal(corruption.truncated, false);
  assertLocalized(corruption, STORES.pullPages, Object.fromEntries(['page-scope', '7', 'page-state', 'page-previous',
    'page-next', 'page-digest'].map((id) => [`pageId=${id}`, 'pull_page_invalid'])));
  assertLocalized(corruption, STORES.pullEvents, Object.fromEntries(['event-scope', '7', 'event-page', 'event-state',
    'event-ordinal', 'event-text', 'event-null', 'event-array'].map((id) => [`eventId=${id}`, 'pull_event_invalid'])));
  assertLocalized(corruption, STORES.effectPages, Object.fromEntries(['eventId=event,pageNumber=3', 'eventId=7,pageNumber=1',
    'eventId=event', 'eventId=event,pageNumber=0', 'eventId=event,pageNumber=4', 'eventId=event,pageNumber=5']
    .map((id) => [id, 'effect_page_invalid'])));
  assert.equal(JSON.stringify(corruption).includes('SECRET-BODY'), false);
});

test('integrity audit reports each failing condition of recovery headers and recovery nodes', async () => {
  const corruption = await auditRows((key) => [
    ...variants(STORES.recovery, { scopeKey: key, snapshotId: 'snapshot', revision: 'revision', syncCursor: 'cursor',
      identityDigest: 'sha256:identity', rootNodeId: 'root', lastPage: 0, lastPageDigest: 'sha256:last',
      complete: false, nextCursor: null, sessionId: null }, [
      { snapshotId: 'snapshot-session', nextCursor: 'cursor-2', sessionId: 'session' },
    ], [
      { snapshotId: 'snapshot-scope', scopeKey: 7 }, { snapshotId: 7 }, { snapshotId: 'snapshot-revision', revision: null },
      { snapshotId: 'snapshot-cursor', syncCursor: null }, { snapshotId: 'snapshot-identity', identityDigest: null },
      { snapshotId: 'snapshot-root', rootNodeId: null }, { snapshotId: 'snapshot-fraction', lastPage: 1.5 },
      { snapshotId: 'snapshot-negative', lastPage: -1 }, { snapshotId: 'snapshot-last', lastPageDigest: null },
      { snapshotId: 'snapshot-complete', complete: 'yes' }, { snapshotId: 'snapshot-next', nextCursor: 7 },
      { snapshotId: 'snapshot-session-bad', sessionId: 7 },
    ]),
    // A header without a session id at all is the legacy shape and stays valid.
    [STORES.recovery, { scopeKey: key, snapshotId: 'snapshot-legacy', revision: 'revision', syncCursor: 'cursor',
      identityDigest: 'sha256:identity', rootNodeId: 'root', lastPage: 0, lastPageDigest: 'sha256:last',
      complete: true, nextCursor: null }],
    ...variants(STORES.recoveryNodes, { scopeKey: key, snapshotId: 'snapshot', page: 0, colpId: 'node', parentId: null,
      position: 'a0', kind: 'Folder', payloadDigest: 'sha256:node', mapping: { scopeKey: key, nativeId: 'native-node',
        colpId: 'node', rootNativeId: 'root', projection: { revision: 'revision', digest: 'sha256:projection' } } }, [
      { colpId: 'child', parentId: 'node', kind: 'Bookmark' },
    ], [
      { colpId: 'node-scope', scopeKey: 7 }, { colpId: 'node-snapshot', snapshotId: 7 }, { colpId: 'node-fraction', page: 1.5 },
      { colpId: 'node-negative', page: -1 }, { colpId: 7 }, { colpId: 'node-parent', parentId: 7 },
      { colpId: 'node-position', position: null }, { colpId: 'node-kind', kind: 'Mystery' },
      { colpId: 'node-digest', payloadDigest: null }, { colpId: 'node-mapping-null', mapping: null },
      { colpId: 'node-mapping-text', mapping: 'SECRET-MAPPING' }, { colpId: 'node-mapping-array', mapping: [] },
      { colpId: 'node-mapping-scope', mapping: { scopeKey: 'other', nativeId: 'native-node', colpId: 'node',
        rootNativeId: 'root', projection: { revision: 'revision', digest: 'sha256:projection' } } },
    ]),
  ]);
  assertLocalized(corruption, STORES.recovery, Object.fromEntries(['snapshot-scope', '7', 'snapshot-revision',
    'snapshot-cursor', 'snapshot-identity', 'snapshot-root', 'snapshot-fraction', 'snapshot-negative', 'snapshot-last',
    'snapshot-complete', 'snapshot-next', 'snapshot-session-bad'].map((id) => [`snapshotId=${id}`, 'recovery_header_invalid'])));
  assertLocalized(corruption, STORES.recoveryNodes, {
    ...Object.fromEntries(['node-scope', 'node-fraction', 'node-negative', 'node-parent', 'node-position', 'node-kind',
      'node-digest', 'node-mapping-null', 'node-mapping-text', 'node-mapping-array']
      .map((id) => [`snapshotId=snapshot,colpId=${id}`, 'recovery_node_invalid'])),
    'snapshotId=7,colpId=node-snapshot': 'recovery_node_invalid',
    'snapshotId=snapshot,colpId=7': 'recovery_node_invalid',
    'snapshotId=snapshot,colpId=node-mapping-scope': 'mapping_scope_invalid',
  });
  assert.equal(JSON.stringify(corruption).includes('SECRET-MAPPING'), false);
});

test('integrity audit localizes receipts, intents, Ack intents, import facts and scopes, then bounds the list', async () => {
  const corruption = await auditRows((key) => [
    [STORES.scopes, { scopeKey: 'scope-bad', lifecycle: 'mystery' }],
    [STORES.receipts, { scopeKey: key, receiptId: 'receipt-fraction', sequence: 1.5 }],
    [STORES.receipts, { scopeKey: key, receiptId: 'receipt-sequence', sequence: 2 }],
    [STORES.intents, { scopeKey: 7, intentId: 'intent-scope' }],
    [STORES.intents, { scopeKey: key, intentId: 'intent-shape' }],
    [STORES.ackIntents, { scopeKey: key, intentId: 'ack-bad' }],
    [STORES.importPlans, { scopeKey: key, planId: 'plan-bad' }],
    [STORES.importNodes, { scopeKey: key, planId: 'plan-bad', sourceNodeId: 'source-bad' }],
  ]);
  const codes = new Map(corruption.details.map((detail) => [`${detail.store} ${detail.key}`, detail.code]));
  for (const id of [`${STORES.scopes} scopeKey=`, `${STORES.receipts} receiptId=receipt-fraction`,
    `${STORES.receipts} receiptId=receipt-sequence,sequence=2`, `${STORES.intents} key=?`,
    `${STORES.ackIntents} intentId=ack-bad`, `${STORES.importPlans} planId=plan-bad`,
    `${STORES.importNodes} planId=plan-bad,sourceNodeId=source-bad`]) {
    assert.ok([...codes.keys()].some((key) => key.startsWith(id)), id);
  }
  assert.equal(corruption.details.filter((detail) => detail.store === STORES.intents).length, 2);
  assert.ok(corruption.details.some((detail) => detail.store === STORES.intents && detail.code === 'intent_scope_invalid'));
  assert.equal(corruption.truncated, false);

  const bounded = await auditRows((key) => Array.from({ length: INTEGRITY_DETAIL_LIMIT + 8 }, (_, index) =>
    [STORES.queue, { scopeKey: key, sequence: index + 1, opId: `op-bad-${index + 1}`, status: 'mystery' }] as const));
  assert.equal(bounded.details.length, INTEGRITY_DETAIL_LIMIT);
  assert.equal(bounded.truncated, true);
});
