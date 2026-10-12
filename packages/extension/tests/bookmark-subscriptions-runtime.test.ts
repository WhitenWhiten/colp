import { setImmediate as immediate } from 'node:timers/promises';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { SubscriptionStore } from '../src/bookmark-subscriptions/store.js';
import type { ExitTask, Mapping, SnapshotDescriptor } from '../src/bookmark-subscriptions/contracts.js';
import type { AccountScope } from '../src/bookmark-subscriptions/local-types.js';
import { database, leaf, nativeFixture, owned, root, row, scope } from './bookmark-subscriptions-fixture.js';
import { digest } from '../src/bookmark-subscriptions/projection.js';

const state = vi.hoisted(() => ({
  db: undefined as unknown as SubscriptionStore,
  scope: undefined as unknown as AccountScope,
  request: vi.fn(),
}));
vi.mock('../src/sw/runtime.js', () => ({
  store: {
    loadCredential: async () => ({ subject: state.scope.accountId, serverOrigin: state.scope.serverOrigin }),
    loadBinding: async () => null,
    fence: { read: async () => ({ generation: state.scope.authorityGeneration, revoked: false }) },
  },
  hasBookmarkPermission: async () => true,
}));
vi.mock('../src/sw/scope.js', () => ({ loadConfig: async () => ({ serverOrigin: state.scope.serverOrigin }) }));
vi.mock('../src/bookmark-subscriptions/store.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/bookmark-subscriptions/store.js')>(),
  get subscriptionStore() { return state.db; },
}));
vi.mock('../src/bookmark-subscriptions/product-client.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/bookmark-subscriptions/product-client.js')>(),
  createSubscriptionProductClient: () => ({ request: state.request }),
}));
vi.mock('../src/bookmark-subscriptions/events.js', () => ({ repairSubscriptionEvents: async () => {} }));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const minute = 60_000;
const start = 1_000_000;
let runtime: typeof import('../src/bookmark-subscriptions/runtime.js');
let fixture: ReturnType<typeof nativeFixture>;
let alarm: number | undefined;
let contentEnabled: boolean;
let actions: ExitTask[];
let requests: { path: string; at: number }[];
let releases: (() => void)[];
let wakes: Promise<void>[];

async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 2000; i++) {
    if (await check()) return;
    await immediate();
  }
  throw new Error('runtime did not reach the expected checkpoint');
}
async function settle() { for (let i = 0; i < 100; i++) await immediate(); }
function wake(reason: Parameters<typeof runtime.wakeSubscriptions>[0] = 'management') {
  const task = runtime.wakeSubscriptions(reason);
  wakes.push(task);
  return task;
}
function count(suffix: string) { return requests.filter(request => request.path.split('?')[0]!.endsWith(suffix)).length; }
async function seed(id: string, interval: Mapping['checkIntervalMinutes'] = 15) {
  const mapping = { ...row(), id, scope: { ...state.scope }, state: 'current' as const, rootNativeId: 'root-' + id, projectionEtag: '"current"' };
  mapping.mapping = { ...mapping.mapping, mappingId: id, checkIntervalMinutes: interval };
  await state.db.put('mappings', mapping);
  fixture.nodes.set(mapping.rootNativeId, { id: mapping.rootNativeId, parentId: 'bar', index: 0, title: 'Source' });
  await state.db.put('nodes', owned(mapping, root, mapping.rootNativeId));
  return mapping;
}
function blockContentRead(id: string, error?: Error) {
  const gate = deferred();
  const get = fixture.api.get;
  const initial = count('/' + id + '/projection');
  let entered = false;
  fixture.api.get = async nativeId => {
    if (!entered && nativeId === 'root-' + id && count('/' + id + '/projection') > initial) {
      entered = true;
      await gate.promise;
      if (error) throw error;
    }
    return get(nativeId);
  };
  releases.push(gate.resolve);
  return { ...gate, entered: () => entered };
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(start);
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  state.db = database();
  state.scope = { ...scope };
  fixture = nativeFixture();
  alarm = undefined;
  contentEnabled = true;
  actions = [];
  requests = [];
  releases = [];
  wakes = [];
  await state.db.put('meta', { id: 'profile', value: scope.profileId });
  vi.stubGlobal('chrome', { bookmarks: fixture.api, alarms: {
    create: vi.fn(async (_name: string, options: { when: number }) => { alarm = options.when; }),
    clear: vi.fn(async () => { alarm = undefined; }),
  } });
  state.request.mockReset().mockImplementation(async (path: string) => {
    requests.push({ path, at: Date.now() });
    if (path.endsWith('/capabilities') || path.endsWith('-capabilities')) return { data: { protocolVersion: 1, contentEnabled } };
    if (path.includes('/bookmark-subscription-actions?')) return { data: { items: structuredClone(actions), nextCursor: null } };
    if (path.endsWith('/ack')) { actions = actions.filter(action => !path.includes(action.actionId)); return { data: {} }; }
    const id = path.split('/')[3]!;
    const mapping = (await state.db.get('mappings', id))!;
    if (path.endsWith('/projection')) return { status: 304, data: undefined, etag: '"current"' };
    if (path.split('?')[0]!.endsWith('/access')) return { data: { mappingId: id, generation: mapping.mapping.generation, mappingRevision: mapping.mapping.revision, authorityRevision: 'a1', contentEnabled, state: 'available', removeEditionIds: [] } };
    return { data: structuredClone(mapping.mapping) };
  });
  runtime = await import('../src/bookmark-subscriptions/runtime.js');
});
afterEach(async () => {
  for (const release of releases) release();
  await Promise.all(wakes);
  await settle();
  await state.db.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test.each([15, 60] as const)('%i-minute content cadence survives intervening permission alarms', async interval => {
  await seed('a', interval);
  await wake('startup');
  await until(async () => (await state.db.get('mappings', 'a'))?.lastCheckedAt === start);
  await settle();
  const deadline = (await state.db.get('mappings', 'a'))!.nextCheckAt;
  expect(deadline).toBe(start + interval * minute + 7500);
  vi.setSystemTime(start + 15 * minute);
  await wake('alarm');
  expect((await state.db.get('mappings', 'a'))!.nextCheckAt).toBe(deadline);
  for (let i = 0; i < 12 && count('/projection') < 3; i++) {
    await settle();
    expect(alarm).toBeDefined();
    vi.setSystemTime(alarm!);
    await wake('alarm');
  }
  await until(() => count('/projection') === 3);
  const times = requests.filter(request => request.path.endsWith('/projection')).map(request => request.at);
  expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(interval * minute);
  expect(times[1]! - times[0]!).toBeLessThanOrEqual(interval * minute + 30_000);
  expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(interval * minute);
});

test('a management wake preserves content that is already not due', async () => {
  await seed('a', 60);
  const deadline = start + 50 * minute;
  await state.db.changeMapping('a', mapping => ({ ...mapping, nextCheckAt: deadline }));
  await wake('management');
  expect(count('/access')).toBe(1);
  expect(count('/projection')).toBe(0);
  expect((await state.db.get('mappings', 'a'))!.nextCheckAt).toBe(deadline);
});

test.each(['timed', 'paused', 'gate-off', 'manual'] as const)('%s maintenance recovers an interrupted create before content becomes due', async mode => {
  const mapping = await seed('a', mode === 'manual' ? null : 60);
  const deadline = start + 50 * minute;
  await state.db.remove('nodes', owned(mapping, root, mapping.rootNativeId!).id);
  await state.db.changeMapping(mapping.id, current => ({ ...current, rootNativeId: undefined, state: mode === 'paused' ? 'paused' : 'initializing', enabled: mode !== 'paused', nextCheckAt: deadline }));
  await state.db.put('operations', { id: 'interrupted-create', mappingId: mapping.id, generation: mapping.mapping.generation, applyEpoch: mapping.applyEpoch, kind: 'create', phase: 'issued', parentNativeId: 'bar', beforeIds: [], node: root, createdAt: start });
  if (mode === 'gate-off') contentEnabled = false;
  await wake('startup');
  expect(await state.db.get('mappings', mapping.id)).toMatchObject({ state: 'repair_pending', error: 'recovery_identity_uncertain', enabled: false, nextCheckAt: deadline });
  expect(await state.db.get('exclusions', mapping.rootNativeId!)).toMatchObject({ reason: 'quarantine' });
  expect(await state.db.get('operations', 'interrupted-create')).toMatchObject({ phase: 'issued' });
  expect(fixture.calls).toEqual([]);
  expect(count('/projection')).toBe(0);
});

test('later rounds pull actions and maintain an unrelated mapping during a blocked native content read', async () => {
  await seed('a', 5);
  await seed('b', 60);
  const held = blockContentRead('a');
  const first = wake('startup');
  await until(held.entered);
  await until(async () => (await state.db.get('mappings', 'b'))?.lastCheckedAt === start);
  vi.setSystemTime(start + 16 * minute);
  let completed = false;
  const next = wake('alarm').then(() => { completed = true; });
  await settle();
  expect(count('/bookmark-subscription-actions')).toBe(2);
  await until(() => count('/b/access') === 2);
  await until(() => completed);
  expect(count('/a/projection')).toBe(1);
  held.resolve();
  await Promise.all([first, next]);
});

test.each(['paused', 'gate-off'] as const)('%s mappings keep their content deadline without a busy alarm loop', async mode => {
  await seed('a', 15);
  if (mode === 'paused') await state.db.changeMapping('a', mapping => ({ ...mapping, enabled: false, state: 'paused' }));
  else contentEnabled = false;
  await wake('startup');
  for (let i = 1; i <= 4; i++) {
    expect(alarm).toBe(start + i * 15 * minute);
    expect((await state.db.get('mappings', 'a'))!.nextCheckAt).toBe(0);
    vi.setSystemTime(alarm!);
    await wake('alarm');
  }
  expect(count('/a/access')).toBe(5);
  expect(count('/projection')).toBe(0);
});

test('queued content is deduplicated while its permission maintenance remains available', async () => {
  for (const id of ['a', 'b', 'c', 'd']) await seed(id, 60);
  const held = ['a', 'b', 'c', 'd'].map(id => blockContentRead(id));
  await wake('startup');
  await until(() => held[0]!.entered() && held[1]!.entered());
  expect(count('/projection')).toBe(2);
  expect((await state.db.get('mappings', 'c'))!.nextCheckAt).toBe(0);
  vi.setSystemTime(start + 16 * minute);
  await Promise.all([wake('alarm'), wake('online'), wake('management')]);
  expect(count('/projection')).toBe(2);
  expect(count('/c/access')).toBeGreaterThanOrEqual(2);
  expect(count('/d/access')).toBeGreaterThanOrEqual(2);
  expect((await state.db.get('mappings', 'c'))!.nextCheckAt).toBe(0);
  expect(alarm! - Date.now()).toBeGreaterThan(30_000);
  held[0]!.resolve();
  await until(held[2]!.entered);
  expect(count('/projection')).toBe(3);
  expect(held[3]!.entered()).toBe(false);
  held[1]!.resolve();
  await until(held[3]!.entered);
  held[2]!.resolve();
  held[3]!.resolve();
  await until(async () => (await state.db.get('mappings', 'd'))?.lastCheckedAt === Date.now());
  await settle();
  await wake('management');
  for (const id of ['a', 'b', 'c', 'd']) expect(count('/' + id + '/projection')).toBe(1);
  expect((await state.db.get('mappings', 'c'))!.nextCheckAt).toBe(Date.now() + 60 * minute + 7500);
});

test('an exit for blocked content is fenced immediately while later unrelated actions complete', async () => {
  const a = await seed('a', 60);
  const b = await seed('b', 60);
  const held = blockContentRead('a');
  await wake('startup');
  await until(held.entered);
  await until(async () => (await state.db.get('mappings', 'b'))?.lastCheckedAt === start);
  function exit(mappingId: string): ExitTask { return {
    actionId: crypto.randomUUID(), exitId: crypto.randomUUID(), sequence: '1', subscriptionId: 'sub',
    mappingId, profileId: scope.profileId, generation: 'g1', trigger: 'unsubscribe', effectiveAction: 'remove',
    policyOrigin: 'global', preferenceRevision: 'p1', mappingRevision: 'r1', createdAt: new Date().toISOString(),
  }; }
  actions.push(exit(a.id));
  await wake('management');
  expect(await state.db.get('mappings', a.id)).toMatchObject({ enabled: false, state: 'terminating', applyEpoch: 2 });
  expect(fixture.nodes.has(a.rootNativeId)).toBe(true);
  const second = exit(b.id);
  actions.push(second);
  await wake('online');
  expect(await state.db.get('mappings', b.id)).toMatchObject({ state: 'detached' });
  expect(await state.db.get('acks', second.actionId)).toMatchObject({ pending: false });
  held.resolve();
  await until(async () => (await state.db.get('mappings', a.id))?.state === 'detached');
  expect(fixture.calls.filter(call => call === 'remove:' + a.rootNativeId)).toHaveLength(1);
});

test('a gate change fences active content and cancels queued content before native execution', async () => {
  for (const id of ['a', 'b', 'c']) await seed(id, 60);
  const a = blockContentRead('a'), b = blockContentRead('b');
  await wake('startup');
  await until(() => a.entered() && b.entered());
  contentEnabled = false;
  await wake('management');
  for (const id of ['a', 'b', 'c']) expect((await state.db.get('mappings', id))!.applyEpoch).toBe(2);
  a.resolve();
  b.resolve();
  await settle();
  expect(count('/c/projection')).toBe(0);
  expect((await state.db.get('mappings', 'c'))!.nextCheckAt).toBe(0);
  contentEnabled = true;
  await wake('management');
  await until(() => count('/c/projection') === 1);
});

test('wake requests arriving during alarm scheduling settle through one merged maintenance rerun', async () => {
  await seed('a', 60);
  const held = deferred();
  releases.push(held.resolve);
  const create = vi.mocked(chrome.alarms.create);
  create.mockImplementationOnce(async () => { await held.promise; });
  let finished = 0;
  const first = wake('startup').then(() => { finished++; });
  await until(() => create.mock.calls.length === 1);
  const second = wake('alarm').then(() => { finished++; });
  const third = wake('management').then(() => { finished++; });
  expect(finished).toBe(0);
  held.resolve();
  await Promise.all([first, second, third]);
  expect(finished).toBe(3);
  expect(count('/bookmark-subscription-actions')).toBe(2);
  await until(() => count('/a/projection') === 1);
  await settle();
  expect(count('/a/projection')).toBe(1);
});

test('an old account content failure cannot mark or remove a newer account job', async () => {
  await seed('a', 60);
  const old = blockContentRead('a', new Error('old_account_native_failure'));
  await wake('startup');
  await until(old.entered);
  const oldRow = (await state.db.get('mappings', 'a'))!;
  state.scope = { ...scope, accountId: 'account-b', authorityGeneration: 2 };
  await seed('a', 60);
  await state.db.changeMapping('a', mapping => ({ ...mapping, applyEpoch: 10 }));
  const fresh = blockContentRead('a');
  await wake('management');
  await runtime.markFailure(oldRow, new Error('offline'));
  expect(await state.db.get('mappings', 'a')).toMatchObject({ scope: state.scope, applyEpoch: 10, state: 'current' });
  old.resolve();
  await until(fresh.entered);
  await wake('management');
  expect(count('/a/projection')).toBe(2);
  fresh.resolve();
  await until(async () => (await state.db.get('mappings', 'a'))?.lastCheckedAt === start);
  await settle();
  expect(await state.db.get('mappings', 'a')).toMatchObject({ scope: state.scope, applyEpoch: 10 });
  expect((await state.db.get('mappings', 'a'))!.error).not.toBe('old_account_native_failure');
});

test('a blocked native apply allows fresh maintenance and a gate fence stops its remaining writes', async () => {
  const a = await seed('a', 60);
  await seed('b', 60);
  const before = leaf();
  fixture.nodes.set('leaf-a', { id: 'leaf-a', parentId: a.rootNativeId, index: 0, title: before.title, url: before.url });
  await state.db.put('nodes', owned(a, before, 'leaf-a', a.rootNativeId));
  const nodes = [root, { ...before, title: 'Changed' }, { ...leaf('second'), index: 1 }];
  const descriptor: SnapshotDescriptor = {
    snapshotId: 'snapshot', projectionVersion: '1', source: a.source, mappingId: a.id, generation: 'g1',
    projectionRevision: 'p2', projectionEtag: '"p2"', contentDigest: digest(nodes), rootKey: root.key,
    policyRevision: 'policy-1', skippedByReason: [], editions: [],
    digestMode: null, editionLimit: null, counts: { nodes: 3, bookmarks: 2, editions: 0, skipped: 0 },
    maxPageSize: 200, expiresAt: new Date(start + 120 * minute).toISOString(),
  };
  const request = state.request.getMockImplementation()!;
  state.request.mockImplementation(async (path: string, options?: { ifNoneMatch?: string; body?: { nodes: unknown[] } }) => {
    if (path === '/me/bookmark-subscription-mappings/a/projection') {
      requests.push({ path, at: Date.now() });
      return options?.ifNoneMatch === '"p2"' ? { status: 304, data: undefined } : { status: 200, etag: '"p2"', data: { state: 'available', mappingId: a.id, generation: 'g1' } };
    }
    if (path === '/me/bookmark-subscription-snapshots') return { data: descriptor };
    if (path === '/me/bookmark-subscription-snapshots/snapshot/nodes') return { data: { snapshotId: 'snapshot', projectionRevision: 'p2', items: nodes, nextCursor: null, complete: true } };
    if (path.endsWith('/node-access-checks')) return { data: { mappingId: a.id, generation: 'g1', mappingRevision: 'r1', authorityRevision: 'a1', contentEnabled, state: 'available', removeNodes: [], requestDigest: digest(options!.body!.nodes) } };
    return request(path, options);
  });
  const gate = deferred();
  releases.push(gate.resolve);
  let entered = false;
  const update = fixture.api.update;
  fixture.api.update = async (id, input) => {
    if (id === 'leaf-a') { entered = true; await gate.promise; }
    return update(id, input);
  };
  await wake('startup');
  await until(() => entered);
  vi.setSystemTime(start + 16 * minute);
  await wake('alarm');
  expect(count('/bookmark-subscription-actions')).toBe(2);
  expect(count('/b/access')).toBe(2);
  expect(fixture.nodes.has('leaf-a')).toBe(true);
  expect(fixture.nodes.get('leaf-a')!.title).toBe(before.title);
  contentEnabled = false;
  await wake('management');
  expect((await state.db.get('mappings', 'a'))!.applyEpoch).toBe(2);
  gate.resolve();
  await until(() => fixture.nodes.get('leaf-a')!.title === 'Changed');
  await settle();
  expect(fixture.calls.filter(call => call.startsWith('create:'))).toHaveLength(0);
  expect((await state.db.get('mappings', 'a'))!.lastAppliedRevision).toBeUndefined();
  expect((await state.db.pendingOperations()).filter(operation => operation.mappingId === 'a')).toHaveLength(0);
});

test('a failed content job releases its slot and retains the retry deadline', async () => {
  for (const id of ['a', 'b', 'c']) await seed(id, 60);
  const a = blockContentRead('a', new Error('network_failed'));
  const b = blockContentRead('b');
  await wake('startup');
  await until(() => a.entered() && b.entered());
  a.resolve();
  await until(() => count('/c/projection') === 1);
  expect(await state.db.get('mappings', 'a')).toMatchObject({ state: 'retrying', error: 'network_failed', nextCheckAt: start + minute });
  b.resolve();
  await settle();
  expect(alarm).toBe(start + minute);
  vi.setSystemTime(alarm!);
  await wake('alarm');
  await until(() => count('/a/projection') === 2);
});

test('manual refreshes join queued content and every caller settles after its single attempt', async () => {
  for (const id of ['a', 'b', 'c']) await seed(id, 60);
  const a = blockContentRead('a'), b = blockContentRead('b'), c = blockContentRead('c');
  await wake('startup');
  await until(() => a.entered() && b.entered());
  const ctx = await runtime.subscriptionContext();
  const queued = (await state.db.get('mappings', 'c'))!;
  let completed = 0;
  const manual = [runtime.refreshMapping(ctx, queued), runtime.refreshMapping(ctx, queued)].map(task => task.then(() => { completed++; }));
  await wake('management');
  expect(completed).toBe(0);
  a.resolve();
  await until(c.entered);
  expect(count('/c/projection')).toBe(1);
  expect(completed).toBe(0);
  c.resolve();
  await Promise.all(manual);
  expect(completed).toBe(2);
  b.resolve();
  await settle();
  expect(count('/c/projection')).toBe(1);
});

test('manual refresh after an epoch change waits for a fresh attempt instead of joining stale content', async () => {
  const mapping = await seed('a', null);
  const held = blockContentRead('a');
  const ctx = await runtime.subscriptionContext();
  const old = runtime.refreshMapping(ctx, mapping);
  await until(held.entered);
  const changed = await state.db.changeMapping('a', current => ({ ...current, applyEpoch: current.applyEpoch + 1, nextCheckAt: 0, mapping: { ...current.mapping, revision: 'r2' } }));
  const refreshed = runtime.refreshMapping(ctx, changed);
  held.resolve();
  await Promise.all([old, refreshed]);
  expect(count('/a/projection')).toBe(2);
  expect((await state.db.get('mappings', 'a'))!.mapping.revision).toBe('r2');
});

test('permission failure backs off maintenance without replacing an unattempted content deadline', async () => {
  await seed('a', 15);
  const request = state.request.getMockImplementation()!;
  let failed = false;
  state.request.mockImplementation(async (path: string, options: unknown) => {
    if (!failed && path.endsWith('/access')) { failed = true; throw new Error('offline'); }
    return request(path, options);
  });
  await wake('startup');
  expect(await state.db.get('mappings', 'a')).toMatchObject({ nextCheckAt: 0, nextMaintenanceAt: start + minute, state: 'retrying' });
  expect(alarm).toBe(start + minute);
  expect(count('/projection')).toBe(0);
  vi.setSystemTime(alarm!);
  await wake('alarm');
  await until(() => count('/projection') === 1);
  await settle();
  expect((await state.db.get('mappings', 'a'))!.nextCheckAt).toBe(start + 16 * minute + 7500);
});

test('a remote configuration change can make future content due while manual mappings stay off alarms', async () => {
  await seed('a', 60);
  await seed('manual', null);
  await state.db.changeMapping('a', mapping => ({ ...mapping, nextCheckAt: start + 50 * minute }));
  const request = state.request.getMockImplementation()!;
  state.request.mockImplementation(async (path: string, options: unknown) => {
    const response = await request(path, options);
    if (path === '/me/bookmark-subscription-mappings/a') return { data: { ...response.data, revision: 'r2', checkIntervalMinutes: 15 } };
    return response;
  });
  await wake('management');
  await until(() => count('/a/projection') === 1);
  expect(count('/manual/access')).toBe(1);
  expect(count('/manual/projection')).toBe(0);
  await settle();
  vi.setSystemTime(alarm!);
  await wake('alarm');
  expect(count('/manual/access')).toBe(1);
  expect((await state.db.get('mappings', 'a'))!.mapping.revision).toBe('r2');
});

test('a deferred management wake still maintains a manual mapping after its content finishes', async () => {
  const mapping = await seed('a', null);
  const held = blockContentRead('a');
  const refresh = runtime.refreshMapping(await runtime.subscriptionContext(), mapping);
  await until(held.entered);
  await wake('management');
  expect(count('/a/access')).toBe(1);
  held.resolve();
  await refresh;
  await until(() => count('/a/access') === 2);
  await settle();
  expect(count('/a/projection')).toBe(1);
  expect(alarm).toBeUndefined();
});
