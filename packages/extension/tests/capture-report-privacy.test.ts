import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createCaptureStore, type CaptureStore } from '../src/capture/store.js';
import type { CaptureScope, CaptureTask } from '../src/capture/contracts.js';
import type { IngressBoundary } from '../src/bookmark-event-ingress.js';
import { task, location } from './fixtures/capture.js';

const f = vi.hoisted(() => ({ ledger: null as CaptureStore | null, scope: null as CaptureScope | null,
  boundary: null as IngressBoundary | null, permission: true, parent: 'selected', excluded: false,
  subscription: false, managed: false, missing: false, readFailure: false,
  afterSession: null as (() => Promise<void> | void) | null, reports: [] as Record<string, unknown>[] }));
vi.mock('../src/sw/capture.js', () => ({ get captureStore() { return f.ledger; } }));
vi.mock('../src/sw/runtime.js', () => ({ hasBookmarkPermission: async () => f.permission,
  syncState: { getLocalSyncExclusion: async () => f.excluded ? {} : null } }));
vi.mock('../src/sw/scope.js', () => ({ currentSyncScope: async () => f.scope }));
vi.mock('../src/bookmark-event-ingress.js', async original => ({ ...await original<object>(),
  resolveIngressBoundary: async () => f.boundary }));
vi.mock('../src/bookmark-subscriptions/guards.js', () => ({ isSubscriptionExcluded: async () => f.subscription }));
vi.mock('../src/sw/capture-history.js', () => ({ captureDeviceId: async () => 'device' }));
vi.mock('../src/sw/capture-native.js', () => ({ currentCaptureScope: async () => f.scope,
  assertCaptureScope: async () => {}, nativeCaptureLocation: async (nativeId: string) => ({
    ...location, nativeId, path: [f.parent] }) }));
import { flushCaptureReports } from '../src/sw/capture-report.js';

beforeEach(() => {
  f.ledger = createCaptureStore(new IDBFactory()); f.scope = { ...task.scope }; f.parent = 'selected';
  f.boundary = { rootStatus: 'ready', selectedNative: new Set(['selected']), privateNative: new Set() };
  f.permission = true; f.excluded = false; f.subscription = false; f.managed = false;
  f.missing = false; f.readFailure = false; f.afterSession = null; f.reports = [];
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('chrome', { bookmarks: { get: async (id: string) => {
    if (f.readFailure) throw new Error('tree unavailable');
    if (id === 'saved') return f.missing ? [] : [{ id, title: task.title, url: task.url, parentId: f.parent }];
    return [{ id, title: id, ...(id === '0' ? {} : { parentId: '0' }), ...(f.managed ? { unmodifiable: 'managed' } : {}) }];
  } } });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith('/api/v1/session')) return Response.json({ authenticated: true, csrfToken: 'csrf' });
    if (url.endsWith('/api/v1/auth/get-session')) {
      await f.afterSession?.(); return Response.json({ user: { id: 'a' }, session: { id: 'session' } });
    }
    if (!url.endsWith('/api/v1/me/bookmark-captures')) throw new Error('unexpected request');
    const body = JSON.parse(init.body as string); f.reports.push(body);
    return Response.json({ revision: body.revision });
  }));
});
afterEach(async () => { await f.ledger?.close(); vi.unstubAllGlobals(); });

async function seed(patch: Partial<CaptureTask> = {}) {
  const now = Date.now();
  return f.ledger!.claim({ ...task, createdAt: now, updatedAt: now, nativeId: 'saved', save: 'local-saved', sync: 'syncing',
    localLocation: { ...location, nativeId: 'saved', path: ['selected'] }, ...patch });
}
test('a legacy syncing label outside the selected folders never sends page data or contacts the server', async () => {
  f.parent = 'local'; await seed();
  await flushCaptureReports();
  expect(fetch).not.toHaveBeenCalled(); expect(f.reports).toEqual([]);
  expect((await f.ledger!.get(task.scope, task.captureId))?.reportIntent).toBeUndefined();
});
test.each(['local-label', 'private-folder', 'stay-local', 'subscription', 'detached', 'bad-roots', 'permission',
  'missing', 'managed', 'tree-unavailable', 'other-collection', 'duplicate-local'])('%s blocks capture history disclosure', async kind => {
  let patch: Partial<CaptureTask> = {};
  if (kind === 'local-label') patch = { sync: 'local-only' };
  if (kind === 'private-folder') f.boundary = { ...f.boundary!, privateNative: new Set(['selected']) };
  if (kind === 'stay-local') f.excluded = true;
  if (kind === 'subscription') f.subscription = true;
  if (kind === 'detached') f.boundary = { ...f.boundary!, selectedNative: new Set() };
  if (kind === 'bad-roots') f.boundary = { ...f.boundary!, rootStatus: 'corrupt' };
  if (kind === 'permission') f.permission = false;
  if (kind === 'missing') f.missing = true;
  if (kind === 'managed') f.managed = true;
  if (kind === 'tree-unavailable') f.readFailure = true;
  if (kind === 'other-collection') patch = { scope: { ...task.scope, collectionId: 'old-collection' } };
  if (kind === 'duplicate-local') patch = { nativeId: null, disposition: 'existing' };
  await seed(patch); await flushCaptureReports();
  expect(fetch).not.toHaveBeenCalled(); expect(f.reports).toEqual([]);
});
test('selected native saves still report and are not uploaded twice', async () => {
  const seeded = await seed(); await flushCaptureReports(); await flushCaptureReports();
  expect(f.reports).toHaveLength(1);
  expect(f.reports[0]).toMatchObject({ url: task.url, title: task.title, collectionId: 'c', nodeId: 'n', localPath: ['selected'] });
  expect((await f.ledger!.get(task.scope, task.captureId))?.reportedRevision).toBe(seeded.revision);
});
test('reporting refreshes the folder path so a stale local path is never disclosed', async () => {
  await seed({ localLocation: { ...location, nativeId: 'saved', path: ['Private old folder'] } });
  await flushCaptureReports();
  expect(f.reports).toHaveLength(1); expect(f.reports[0]!.localPath).toEqual(['selected']);
});
test.each(['move', 'deselect', 'exclude', 'local-label', 'edit'])('a %s during authentication blocks the final report request', async kind => {
  await seed();
  f.afterSession = async () => {
    if (kind === 'move') f.parent = 'local';
    if (kind === 'deselect') f.boundary = { ...f.boundary!, selectedNative: new Set() };
    if (kind === 'exclude') f.excluded = true;
    if (kind === 'local-label' || kind === 'edit') {
      const latest = (await f.ledger!.get(task.scope, task.captureId))!;
      await f.ledger!.update({ ...latest, revision: latest.revision + 1,
        ...(kind === 'local-label' ? { sync: 'local-only' } : { title: 'Changed' }) }, latest.revision);
    }
  };
  await flushCaptureReports(); expect(f.reports).toEqual([]);
  expect((await f.ledger!.get(task.scope, task.captureId))?.reportedRevision).toBeUndefined();
});
