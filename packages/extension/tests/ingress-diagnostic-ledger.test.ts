import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { recordIngressDiagnostic } from '../src/bookmark-event-ingress.js';
import { PARK_MARKER_PREFIX } from '../src/bookmark-event-quarantine.js';
import { createSyncStateStore } from '../src/sync-state-store.js';
import { INGRESS_DIAGNOSTIC_SCAN_LIMIT } from '../src/sync-state/bookmark-event-repository.js';
import { PARKED_DIAGNOSTIC, PARK_ADOPTION_PENDING_KEY, STORES } from '../src/sync-state/schema.js';
import { scopeKey } from '../src/sync-state/scope-key.js';
import type { BookmarkEventParkMarker } from '../src/sync-state/types.js';
import { fixture, scope } from './bookmark-event-queue-harness.js';

/**
 * SR-10 storage semantics: the ingress diagnostic row is the durable ledger a
 * suppressed local bookmark leaves behind. The primary key
 * `ingress:${key}:${code}` is stable, so a repeated code must update one row
 * with an accumulated count and a monotone `lastAt` instead of overwriting the
 * previous occurrence — and a park marker, being an unresolved state, must
 * survive a later plain diagnostic of the same code.
 */
type Store = ReturnType<typeof createSyncStateStore>;

let indexedDB: IDBFactory;
beforeEach(() => { indexedDB = new IDBFactory(); });
afterEach(() => { vi.useRealTimers(); });


/** Rows still carrying a `park` marker, read directly without the scan budget. */

/** Models the v16→v17 upgrade having run, which is what arms the sweep. */
async function putAdoptionPending(store: Store): Promise<void> {
  const db = await store.open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORES.metadata, 'readwrite');
    tx.objectStore(STORES.metadata).put({ key: PARK_ADOPTION_PENDING_KEY, pending: true });
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error as Error);
  });
}

async function parkedDiagnosticCount(store: Store): Promise<number> {
  const db = await store.open();
  const tx = db.transaction(STORES.diagnostics, 'readonly');
  const values = await new Promise<unknown[]>((resolve, reject) => {
    const request = tx.objectStore(STORES.diagnostics).getAll();
    request.onsuccess = () => resolve(request.result as unknown[]);
    request.onerror = () => reject(request.error as Error);
  });
  return values.filter((value) => value && typeof value === 'object'
    && (value as { readonly park?: unknown }).park !== undefined).length;
}

async function putRawMetadata(store: Store, value: Record<string, unknown>): Promise<void> {
  const db = await store.open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORES.metadata, 'readwrite');
    tx.objectStore(STORES.metadata).put(value);
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error as Error);
  });
}

async function activeStore(factory: IDBFactory = indexedDB): Promise<{ store: Store; key: string }> {
  const store = createSyncStateStore({ indexedDB: factory });
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 10_000 },
    checkpoint: { serverRevision: 'collection-revision-3', cursor: 'cursor-3' }, selectedRoots: [], rootStatus: 'ready' });
  return { store, key: scopeKey(scope) };
}

/** Writes a row the way a pre-ledger build (or a corrupt disk) would have. */
async function putRawDiagnostic(store: Store, row: unknown): Promise<void> {
  await putRawDiagnostics(store, [row]);
}

/**
 * Writes many rows in one transaction. The over-window cases below cannot afford
 * a transaction per row: the production entry point costs ~60ms for 1_001 rows,
 * a single bulk transaction ~0.3ms a row.
 */
async function putRawDiagnostics(store: Store, rows: readonly unknown[]): Promise<void> {
  const db = await store.open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORES.diagnostics, 'readwrite');
    for (const row of rows) tx.objectStore(STORES.diagnostics).put(row);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** A `park:${eventId}` marker as it rests in the ledger: one minimal row. */
function rawParkRow(key: string, ordinal: number): unknown {
  return { id: `ingress:${key}:park:event-${ordinal}`, scopeKey: key, kind: 'ingress',
    code: `park:event-${ordinal}`, count: 1, firstAt: 1, lastAt: 1 };
}

const parkCodes = (rows: readonly { readonly code: string }[]) =>
  rows.filter((row) => row.code.startsWith(PARK_MARKER_PREFIX)).map((row) => row.code);

function parkMarker(overrides: Partial<BookmarkEventParkMarker> = {}): BookmarkEventParkMarker {
  return { eventId: 'event-parked', state: 'parked', code: 'dependency_rejected', attempts: 2,
    at: '2026-07-27T00:00:00Z', reason: 'dependency_rejected', dependencyNativeId: 'folder-new', ...overrides };
}

describe('SR-10 ingress diagnostic ledger', () => {
  test('a repeated code keeps exactly one row with an accumulated count and a monotone lastAt', async () => {
    const { store, key } = await activeStore();
    const observed: number[] = [];
    for (let round = 0; round < 5; round += 1) {
      await store.putIngressDiagnostic(scope, { code: 'unsupported_url_scheme' }, { now: 1_000 + round * 10 });
      const rows = await store.listIngressDiagnostics(scope);
      assert.equal(rows.length, 1, 'a repeated code never appends a second row');
      observed.push(rows[0]!.lastAt);
    }
    assert.deepEqual(observed, [1_000, 1_010, 1_020, 1_030, 1_040], 'lastAt is monotone non-decreasing');
    const rows = await store.listIngressDiagnostics(scope);
    assert.equal(rows.length, 1, 'one row per (scope, code) — never one row per event');
    const row = rows[0]!;
    assert.equal(row.id, `ingress:${key}:unsupported_url_scheme`, 'the primary key stays code-derived');
    assert.equal(row.code, 'unsupported_url_scheme');
    assert.equal(row.count, 5);
    assert.equal(row.firstAt, 1_000, 'firstAt is set by the first occurrence only');
    assert.equal(row.lastAt, 1_040, 'lastAt tracks the most recent occurrence');
    assert.equal(row.park, undefined);
  });

  test('lastAt never regresses when the injected clock moves backwards', async () => {
    const { store } = await activeStore();
    await store.putIngressDiagnostic(scope, { code: 'managed' }, { now: 5_000 });
    await store.putIngressDiagnostic(scope, { code: 'managed' }, { now: 4_000 });
    const row = (await store.listIngressDiagnostics(scope))[0]!;
    assert.equal(row.count, 2);
    assert.equal(row.firstAt, 5_000);
    assert.equal(row.lastAt, 5_000, 'a rewound clock must not report lastAt < firstAt');
  });

  test('distinct codes keep independent rows and counts', async () => {
    const { store } = await activeStore();
    await store.putIngressDiagnostic(scope, { code: 'managed' }, { now: 1_000 });
    await store.putIngressDiagnostic(scope, { code: 'unselected_range' }, { now: 2_000 });
    await store.putIngressDiagnostic(scope, { code: 'managed' }, { now: 3_000 });
    const rows = await store.listIngressDiagnostics(scope);
    assert.equal(rows.length, 2);
    const byCode = new Map(rows.map((row) => [row.code, row]));
    assert.deepEqual([byCode.get('managed')!.count, byCode.get('managed')!.firstAt, byCode.get('managed')!.lastAt],
      [2, 1_000, 3_000]);
    assert.deepEqual([byCode.get('unselected_range')!.count, byCode.get('unselected_range')!.firstAt,
      byCode.get('unselected_range')!.lastAt], [1, 2_000, 2_000]);
  });

  test('a park marker survives a later plain diagnostic and is replaced only by a newer marker', async () => {
    const { store } = await activeStore();
    const code = 'park:event-parked';
    await store.putIngressDiagnostic(scope, { code, park: parkMarker() }, { now: 1_000 });
    // A plain repeat of the same code carries no marker: the park is unresolved
    // state, so it must not be cleared by an observability write.
    await store.putIngressDiagnostic(scope, { code }, { now: 2_000 });
    const surviving = (await store.listIngressDiagnostics(scope))[0]!;
    assert.equal(surviving.count, 2);
    assert.deepEqual(surviving.park, parkMarker(), 'the existing park marker is retained');

    // A newer marker for the same code is the only thing that replaces it.
    const reopened = parkMarker({ state: 'open', attempts: 3 });
    await store.putIngressDiagnostic(scope, { code, park: reopened }, { now: 3_000 });
    const replaced = (await store.listIngressDiagnostics(scope))[0]!;
    assert.equal(replaced.count, 3);
    assert.deepEqual(replaced.park, reopened);
  });

  test('park markers for events that left the inbox are pruned from the ledger', async () => {
    // One marker row per parked event, and an event never leaves the inbox on
    // its own: without a prune the ledger eventually pushes the ingress range
    // past the scan budget, and every flush then rejects — outbound sync stops.
    const { store } = await activeStore();
    await store.putIngressDiagnostic(scope, { code: `${PARK_MARKER_PREFIX}live-1`,
      park: parkMarker({ eventId: 'live-1' }) }, { now: 1_000 });
    await store.putIngressDiagnostic(scope, { code: `${PARK_MARKER_PREFIX}gone-1`,
      park: parkMarker({ eventId: 'gone-1' }) }, { now: 1_000 });
    await store.putIngressDiagnostic(scope, { code: `${PARK_MARKER_PREFIX}gone-2`,
      park: parkMarker({ eventId: 'gone-2' }) }, { now: 1_000 });

    const markers = await store.pruneParkDiagnostics(scope, new Set(['live-1']));
    assert.deepEqual([...markers.keys()], ['live-1'], 'a live event keeps its marker');
    assert.deepEqual((await store.listIngressDiagnostics(scope)).map((row) => row.code),
      [`${PARK_MARKER_PREFIX}live-1`], 'markers for departed events are gone');

    // The live marker survives a second pass and a settled one stays gone.
    const again = await store.pruneParkDiagnostics(scope, new Set(['live-1']));
    assert.deepEqual([...again.keys()], ['live-1']);
  });

  test('listIngressDiagnostics orders by lastAt descending with a deterministic code tie-break', async () => {
    const { store } = await activeStore();
    await store.putIngressDiagnostic(scope, { code: 'managed' }, { now: 3_000 });
    await store.putIngressDiagnostic(scope, { code: 'private_local' }, { now: 1_000 });
    await store.putIngressDiagnostic(scope, { code: 'unselected_range' }, { now: 2_000 });
    assert.deepEqual((await store.listIngressDiagnostics(scope)).map((row) => row.code),
      ['managed', 'unselected_range', 'private_local'], 'most recent suppression first');
    await store.putIngressDiagnostic(scope, { code: 'invalid_title' }, { now: 3_000 });
    assert.deepEqual((await store.listIngressDiagnostics(scope)).map((row) => row.code),
      ['invalid_title', 'managed', 'unselected_range', 'private_local'], 'equal lastAt falls back to code order');
  });

  test('a pre-ledger row is listed as one suppression at epoch 0 and its count continues', async () => {
    const { store, key } = await activeStore();
    // The exact shape an older build persisted: five keys, no ledger counters.
    await putRawDiagnostic(store, { id: `ingress:${key}:managed`, scopeKey: key, kind: 'ingress', code: 'managed' });
    await putRawDiagnostic(store, { id: `ingress:${key}:park:legacy-event`, scopeKey: key, kind: 'ingress',
      code: 'park:legacy-event', park: parkMarker({ eventId: 'legacy-event' }) });
    const rows = await store.listIngressDiagnostics(scope);
    assert.equal(rows.length, 2, 'an upgraded profile still lists its diagnostics');
    const legacy = rows.find((row) => row.code === 'managed')!;
    assert.deepEqual([legacy.count, legacy.firstAt, legacy.lastAt], [1, 0, 0], 'missing counters normalize, never throw');
    const legacyPark = rows.find((row) => row.code === 'park:legacy-event')!;
    assert.equal(legacyPark.count, 1);
    assert.equal(legacyPark.park?.eventId, 'legacy-event', 'the quarantine marker load path keeps working');

    // A pre-v17 row carries no `parked` discriminator, so `by_scope_parked` does
    // not contain it. The prune adopts it on its next pass: a live event's marker
    // is stamped into the index, and one whose event has left the inbox is
    // removed rather than left on disk forever.
    assert.equal(await parkedDiagnosticCount(store), 1, 'the legacy row is in the ledger but not the index');
    // An unstamped marker can only exist in a database that predates v17, so the
    // upgrade sets this flag; without it the sweep is skipped by design.
    await putAdoptionPending(store);
    const adopted = await store.pruneParkDiagnostics(scope, new Set(['legacy-event']));
    assert.equal(adopted.get('legacy-event')?.eventId, 'legacy-event', 'the prune adopts the legacy marker');
    assert.equal(await store.pruneParkDiagnostics(scope, new Set(['legacy-event'])).then((m) => m.size), 1,
      'and the adopted marker is now found through the index');
    await store.putIngressDiagnostic(scope, { code: 'park:legacy-event' }, { now: 2_000 });
    const gone = await store.pruneParkDiagnostics(scope, new Set());
    assert.equal(gone.size, 0);
    assert.equal(await parkedDiagnosticCount(store), 0, 'a departed event leaves no marker behind');

    // The next write for that code continues the legacy row in place.
    await store.putIngressDiagnostic(scope, { code: 'managed' }, { now: 7_000 });
    const continued = (await store.listIngressDiagnostics(scope)).find((row) => row.code === 'managed')!;
    assert.deepEqual([continued.count, continued.firstAt, continued.lastAt], [2, 0, 7_000]);
  });


  test('a second scope still adopts its own legacy markers', async () => {
    // REGRESSION, caught by an independent reviewer. Adoption used to gate on the
    // database-global `park-adoption-pending` flag and delete it when the FIRST
    // scope finished, so every other scope returned early forever: its pre-v17
    // markers were never adopted into the index and never pruned. Completion is
    // per scope now, and the flag only means "an in-place upgrade happened".
    const first = await activeStore();
    const secondScope = { ...scope, collectionId: 'collection-b', replicaId: 'replica-b' };
    await first.store.registerScope({ ...secondScope, lifecycle: 'active',
      lease: { leaseId: 'lease-b', expiresAt: 10_000 },
      checkpoint: { serverRevision: 'collection-revision-3', cursor: 'cursor-3' },
      selectedRoots: [], rootStatus: 'ready' });
    await putAdoptionPending(first.store);
    await putRawDiagnostic(first.store, { id: `ingress:${scopeKey(scope)}:park:first-event`,
      scopeKey: scopeKey(scope), kind: 'ingress', code: 'park:first-event',
      count: 1, firstAt: 0, lastAt: 0, park: parkMarker({ eventId: 'first-event' }) });
    await putRawDiagnostic(first.store, { id: `ingress:${scopeKey(secondScope)}:park:second-event`,
      scopeKey: scopeKey(secondScope), kind: 'ingress', code: 'park:second-event',
      count: 1, firstAt: 0, lastAt: 0, park: parkMarker({ eventId: 'second-event' }) });

    // The first scope completes its sweep and, before the fix, disarmed the rest.
    const firstAdopted = await first.store.pruneParkDiagnostics(scope, new Set(['first-event']));
    assert.equal(firstAdopted.get('first-event')?.eventId, 'first-event');

    const secondAdopted = await first.store.pruneParkDiagnostics(secondScope, new Set(['second-event']));
    assert.equal(secondAdopted.get('second-event')?.eventId, 'second-event',
      "the second scope must still adopt its own legacy marker");
    assert.equal(await first.store.pruneParkDiagnostics(secondScope, new Set(['second-event'])).then((m) => m.size), 1,
      'and it is found through the index afterwards');
  });


  test('a scope adopts its legacy markers even with no upgrade flag present', async () => {
    // REGRESSION, found by an independent reviewer. `e81297ba3` deleted the
    // database-global `park-adoption-pending` flag when the first scope finished
    // its sweep, so a database written by that build has NO flag while other
    // scopes still hold unstamped pre-v17 markers. Recording a permanent
    // `adopted: 0` from an absent flag — which an earlier version of this fix did
    // — meant those rows were never adopted, never indexed and never pruned: the
    // leak the sweep exists to close, kept forever, in the one state a real
    // upgraded profile can actually be in.
    //
    // An absent flag is therefore not evidence of completion. The sweep runs, and
    // it is cheap because it visits only the park-code range rather than the whole
    // ingress ledger.
    const { store, key } = await activeStore();
    await putRawDiagnostic(store, { id: `ingress:${key}:park:stranded-event`,
      scopeKey: key, kind: 'ingress', code: 'park:stranded-event',
      count: 1, firstAt: 0, lastAt: 0, park: parkMarker({ eventId: 'stranded-event' }) });

    // Deliberately NO putAdoptionPending: this is the poisoned-database state.
    const adopted = await store.pruneParkDiagnostics(scope, new Set(['stranded-event']));
    assert.equal(adopted.get('stranded-event')?.eventId, 'stranded-event',
      'a marker left unstamped by an earlier build must still be adopted');
    assert.equal(await store.pruneParkDiagnostics(scope, new Set(['stranded-event'])).then((m) => m.size), 1,
      'and it is reachable through the index afterwards');
  });


  test('a completion marker left by the buggy build does not strand markers', async () => {
    // RESIDUAL, found by an independent verifier. The build that recorded
    // `adopted: 0` from an ABSENT upgrade flag wrote a permanent completion marker
    // for scopes it never swept, so a profile written by it stays stranded even
    // after the sweep runs again for everyone else. Those records carry no version,
    // so they are treated as incomplete and repaired once.
    const { store, key } = await activeStore();
    await putRawDiagnostic(store, { id: `ingress:${key}:park:stale-event`,
      scopeKey: key, kind: 'ingress', code: 'park:stale-event',
      count: 1, firstAt: 0, lastAt: 0, park: parkMarker({ eventId: 'stale-event' }) });
    // Exactly what the buggy build left behind: a completion marker with adopted 0
    // and no version, for a scope whose marker was never adopted.
    await putRawMetadata(store, { key: `park-adoption:${key}`, adopted: 0, at: 1_000 });

    const adopted = await store.pruneParkDiagnostics(scope, new Set(['stale-event']));
    assert.equal(adopted.get('stale-event')?.eventId, 'stale-event',
      'a stale completion marker must not prevent adoption');
  });

  test('a corrupt pre-existing ledger row restarts the ledger instead of failing the capture write', async () => {
    const { store, key } = await activeStore();
    await putRawDiagnostic(store, { id: `ingress:${key}:managed`, scopeKey: key, kind: 'ingress', code: 'managed',
      count: -5, firstAt: 0, lastAt: 0 });
    await store.putIngressDiagnostic(scope, { code: 'managed' }, { now: 9_000 });
    const row = (await store.listIngressDiagnostics(scope))[0]!;
    assert.deepEqual([row.count, row.firstAt, row.lastAt], [1, 9_000, 9_000]);
  });

  test('a ledger larger than one cursor window still lists every real code', async () => {
    const { store, key } = await activeStore();
    // The `ingress:${key}:*` range is shared with the unbounded `park:${eventId}`
    // markers, and `park:` sorts ahead of real codes like
    // `unsupported_url_scheme`. 1_001 markers is one more than the fixed row
    // window this read used to stop at, so the real row below could only ever be
    // reached by scanning the whole range. Written through the production entry
    // point (one transaction per marker, ~60ms for the whole loop).
    for (let ordinal = 0; ordinal < 1_001; ordinal += 1) {
      await store.putIngressDiagnostic(scope, { code: `${PARK_MARKER_PREFIX}event-${ordinal}` }, { now: 1_000 });
    }
    await store.putIngressDiagnostic(scope, { code: 'managed' }, { now: 2_000 });
    await store.putIngressDiagnostic(scope, { code: 'unsupported_url_scheme' }, { now: 3_000 });

    const rows = await store.listIngressDiagnostics(scope);
    assert.equal(rows.length, 1_003, 'the whole ledger is listed, not one 1_000-row window of it');
    assert.equal(parkCodes(rows).length, 1_001, 'every marker is still listed');
    assert.deepEqual(rows.filter((row) => !row.code.startsWith(PARK_MARKER_PREFIX)).map((row) => row.code),
      ['unsupported_url_scheme', 'managed'], 'a real code past the window is never dropped');
    assert.deepEqual(rows.map((row) => row.code),
      ['unsupported_url_scheme', 'managed',
        ...Array.from({ length: 1_001 }, (_, ordinal) => `park:event-${ordinal}`).sort()],
      'order stays lastAt descending, then code ascending, across the whole ledger');
    assert.equal(rows[0]!.id, `ingress:${key}:unsupported_url_scheme`, 'the listed row keeps its stable id');
    assert.equal(rows.find((row) => row.code === 'unsupported_url_scheme')!.count, 1);
  });

  test('a ledger exactly at the scan budget is listed completely', async () => {
    const { store, key } = await activeStore();
    await putRawDiagnostics(store, Array.from({ length: INGRESS_DIAGNOSTIC_SCAN_LIMIT - 1 },
      (_, ordinal) => rawParkRow(key, ordinal)));
    await putRawDiagnostic(store, { id: `ingress:${key}:unsupported_url_scheme`, scopeKey: key, kind: 'ingress',
      code: 'unsupported_url_scheme', count: 2, firstAt: 5, lastAt: 9 });

    const rows = await store.listIngressDiagnostics(scope);
    assert.equal(rows.length, INGRESS_DIAGNOSTIC_SCAN_LIMIT, 'the budget is inclusive: that many rows still list');
    assert.equal(new Set(rows.map((row) => row.code)).size, INGRESS_DIAGNOSTIC_SCAN_LIMIT,
      'no row is dropped or duplicated at the boundary');
    assert.equal(rows[0]!.code, 'unsupported_url_scheme', 'the one real row is still the most recent one');
  });

  test('a ledger past the scan budget fails loudly instead of listing a truncated window', async () => {
    const { store, key } = await activeStore();
    await putRawDiagnostics(store, Array.from({ length: INGRESS_DIAGNOSTIC_SCAN_LIMIT },
      (_, ordinal) => rawParkRow(key, ordinal)));
    await putRawDiagnostic(store, { id: `ingress:${key}:unsupported_url_scheme`, scopeKey: key, kind: 'ingress',
      code: 'unsupported_url_scheme', count: 1, firstAt: 9, lastAt: 9 });

    // The complete list is the ledger's contract; an incomplete one that looks
    // complete is the failure this read must never produce.
    await assert.rejects(store.listIngressDiagnostics(scope), /ingress_diagnostic_scan_exceeded/u);
  });

  test('the production capture entry point exposes code + count + lastAt for the UI', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = await fixture(new IDBFactory(), { mappedNode: true });
    const first = Date.parse('2026-09-12T00:00:00Z');
    vi.setSystemTime(first);
    await recordIngressDiagnostic(f.store, scope, 'unsupported_url_scheme');
    vi.setSystemTime(first + 60_000);
    await recordIngressDiagnostic(f.store, scope, 'unsupported_url_scheme');
    // SR-08/A-09 changed this entry point's observable contract: a reorder is a
    // real user edit, so the queue authors a `move_node` for it instead of only
    // refreshing the local projection. The old expectations here were
    //   assert.equal((await f.queue.reordered(...)).outcome, 'filtered');
    //   const reorder = rows.find((row) => row.code === 'reorder_children_local_only')!;
    //   assert.deepEqual(rows.map((row) => row.code),
    //     ['reorder_children_local_only', 'unsupported_url_scheme']);
    // The production entry point still writes the same ledger shape — with the
    // code that matches what it actually did.
    assert.equal((await f.queue.reordered('root-selected', ['mapped', 'folder-parent'])).outcome, 'staged');
    await f.queue.flush();
    assert.deepEqual((await f.store.listQueue(scope)).map((row) => row.payload.type), ['move_node']);

    const rows = await f.store.listIngressDiagnostics(scope);
    const suppressed = rows.find((row) => row.code === 'unsupported_url_scheme')!;
    assert.deepEqual([suppressed.count, suppressed.firstAt, suppressed.lastAt], [2, first, first + 60_000]);
    const reorder = rows.find((row) => row.code === 'reorder_uplink_staged')!;
    assert.deepEqual([reorder.count, reorder.firstAt, reorder.lastAt], [1, first + 60_000, first + 60_000]);
    assert.equal(rows.some((row) => row.code === 'reorder_children_local_only'), false,
      'a reorder that reached the queue must not be reported as local-only');
    assert.deepEqual(rows.map((row) => row.code), ['reorder_uplink_staged', 'unsupported_url_scheme'],
      'list order is recency-first, then code order');
  });

  test('a flush completes and prunes on a ledger that is already past the budget', async () => {
    // The original defect was not the budget check but what happened past it:
    // every flush rejected at its first step, so events stayed in the inbox and
    // outbound sync stopped for good. The budget test above asserts the
    // over-budget READ throws; it never ran a flush, so the stall it was
    // supposed to catch was invisible.
    const f = await fixture(indexedDB, { mappedNode: true });
    const key = scopeKey(scope);
    // A real staged event, so "the flush worked" means the inbox drained. The
    // order must move a node that is not already there, or the reorder is
    // filtered rather than staged.
    assert.equal((await f.queue.moved('mapped', { parentId: 'folder-parent', index: 0,
      oldParentId: 'root-selected', oldIndex: 1 })).outcome, 'staged');

    const total = INGRESS_DIAGNOSTIC_SCAN_LIMIT + 50;
    const stale = [0, 1, 2].map((index) => `bulk_${String(index).padStart(6, '0')}`);
    const rows: unknown[] = [];
    for (let index = 0; index < total; index += 1) {
      const code = `bulk_${String(index).padStart(6, '0')}`;
      rows.push({ id: `ingress:${key}:${code}`, scopeKey: key, kind: 'ingress', code, count: 1,
        firstAt: 1, lastAt: 1, ...(stale.includes(code)
          ? { park: { eventId: `gone-${code}`, reason: 'quarantined', code },
            parked: PARKED_DIAGNOSTIC } : {}) });
    }
    await putRawDiagnostics(f.store, rows);

    // The ledger is past the 20_000 read budget, so `listIngressDiagnostics`
    // refuses it — a flush that depended on that read could not finish. It is
    // affordable only because `by_scope_parked` lets the prune visit the MARKERS
    // instead of the ledger: walking `by_scope` here took over a minute.
    const flush = await Promise.race([
      f.queue.flush().then(() => 'ok' as const, (error: unknown) => error),
      new Promise<'timeout'>((resolve) => { setTimeout(() => resolve('timeout'), 10_000).unref?.(); }),
    ]);
    assert.notEqual(flush, 'timeout',
      'the flush must not spend seconds walking the ingress ledger to find markers');
    assert.equal(flush, 'ok', `the flush must complete with an oversized ledger, got: ${String(flush)}`);
    assert.deepEqual((await f.store.listQueue(scope)).map((row) => row.payload.type), ['move_node'],
      'the flush must drain the inbox rather than leave the event staged');
    // Read directly rather than through the listing API, which refuses a ledger
    // this size; calling the prune again would only re-walk it.
    assert.equal(await parkedDiagnosticCount(f.store), 0,
      'markers whose event left the inbox are pruned by the flush');
  }, 60_000);
});
