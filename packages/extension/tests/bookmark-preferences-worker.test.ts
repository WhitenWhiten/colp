import { readCaptureControl } from '../src/capture/control.js';
import assert from 'node:assert/strict';
import { DEFAULT_BOOKMARK_PREFERENCES, normalizeBookmarkPreferences } from '../src/bookmark-preferences.js';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class ProductError extends Error {
    constructor(readonly code: string, readonly status: number) { super(code); }
  }
  return {
    ProductError,
    credential: { serverOrigin: 'https://known.example', subject: 'user-a' } as { serverOrigin: string; subject: string } | null,
    generation: 1,
    serverOrigin: 'https://known.example',
    read: vi.fn(), patch: vi.fn(),
  };
});

vi.mock('../src/sw/scope.js', () => ({ loadConfig: async () => ({ serverOrigin: mocks.serverOrigin }) }));
vi.mock('../src/sw/runtime.js', () => ({
  store: { loadCredential: async () => mocks.credential,
    fence: { read: async () => ({ generation: mocks.generation, revoked: mocks.credential === null }) } },
  extensionOrigin: () => 'chrome-extension://fixture',
}));
vi.mock('../src/bookmark-preferences-product-client.js', () => ({
  BookmarkPreferencesProductError: mocks.ProductError,
  createBookmarkPreferencesProductClient: () => ({ read: mocks.read, patch: mocks.patch }),
}));

import {
  flushBookmarkPreferences,
  handleBookmarkPreferencesRequest,
  readEffectiveBookmarkPreferences,
  restoreDeviceBookmarkPreferences,
} from '../src/sw/bookmark-preferences.js';
import { validBookmarkPreferencesRequest } from '../src/sw/messages.js';

const values = new Map<string, unknown>();
const area = {
  async get(key: string) { return { [key]: values.get(key) }; },
  async set(items: Record<string, unknown>) { Object.assign(Object.fromEntries(values), items); for (const [key, value] of Object.entries(items)) values.set(key, value); },
};

beforeEach(() => {
  values.clear(); mocks.credential = { serverOrigin: 'https://known.example', subject: 'user-a' };
  mocks.generation = 1; mocks.serverOrigin = 'https://known.example';
  mocks.read.mockReset().mockResolvedValue({ value: { bookmarkInsertPosition: 'bottom', foldersFirst: true }, revision: '0', etag: '"0"' });
  mocks.patch.mockReset();
  vi.stubGlobal('chrome', { storage: { local: area } });
});
afterEach(async () => { await flushBookmarkPreferences(); });

describe('bookmark preference worker authority', () => {
  test('keeps an offline account update pending with a stable UUID command', async () => {
    mocks.patch.mockRejectedValue(new mocks.ProductError('transport_error', 0));
    const first = await handleBookmarkPreferencesRequest({ kind: 'known.bookmark.preferences.update', userGesture: true,
      bookmarkInsertPosition: 'top', foldersFirst: false });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.pending, true);
    const stored = values.get('known.bookmark.preferences.v1') as { records: Record<string, { pending?: { commandId: string } }> };
    const pending = stored.records['https://known.example\u001faccount\u001fuser-a']!.pending;
    assert.match(pending?.commandId ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  });

  test('412 refreshes remote state and blocks an ordinary edit until explicit resolve', async () => {
    mocks.patch.mockRejectedValue(new mocks.ProductError('precondition_failed', 412));
    mocks.read.mockResolvedValue({ value: { bookmarkInsertPosition: 'top', foldersFirst: false }, revision: '2', etag: '"2"' });
    await handleBookmarkPreferencesRequest({ kind: 'known.bookmark.preferences.update', userGesture: true,
      bookmarkInsertPosition: 'bottom', foldersFirst: true });
    await flushBookmarkPreferences();
    const conflicted = await handleBookmarkPreferencesRequest({ kind: 'known.bookmark.preferences.local' });
    assert.equal(conflicted.ok, true);
    if (!conflicted.ok) return;
    assert.equal(conflicted.conflict, true);
    const calls = mocks.patch.mock.calls.length;
    const ordinaryEdit = await handleBookmarkPreferencesRequest({ kind: 'known.bookmark.preferences.update', userGesture: true,
      bookmarkInsertPosition: 'top', foldersFirst: true });
    assert.equal(ordinaryEdit.ok, true);
    assert.equal(mocks.patch.mock.calls.length, calls);
  });

  test('online flush reuses the pending command and clears it after the server receipt', async () => {
    mocks.patch.mockRejectedValueOnce(new mocks.ProductError('transport_error', 0));
    await handleBookmarkPreferencesRequest({ kind: 'known.bookmark.preferences.update', userGesture: true,
      bookmarkInsertPosition: 'top', foldersFirst: false });
    await flushBookmarkPreferences();
    const storedBefore = values.get('known.bookmark.preferences.v1') as { records: Record<string, { pending?: { commandId: string } }> };
    const commandId = storedBefore.records['https://known.example\u001faccount\u001fuser-a']!.pending!.commandId;
    mocks.patch.mockResolvedValue({ value: { bookmarkInsertPosition: 'top', foldersFirst: false }, revision: '1', etag: '"1"' });
    await flushBookmarkPreferences();
    const storedAfter = values.get('known.bookmark.preferences.v1') as { records: Record<string, { pending?: unknown; revision: string }> };
    assert.equal(storedAfter.records['https://known.example\u001faccount\u001fuser-a']!.pending, undefined);
    assert.equal(mocks.patch.mock.calls.at(-1)?.[1], commandId);
  });

  test('keeps account records isolated while switching subjects', async () => {
    mocks.patch.mockImplementation(async (value) => ({ value: { ...DEFAULT_BOOKMARK_PREFERENCES, ...value }, revision: '1', etag: '"1"' }));
    await handleBookmarkPreferencesRequest({ kind: 'known.bookmark.preferences.update', userGesture: true,
      bookmarkInsertPosition: 'top', foldersFirst: false });
    mocks.credential = { serverOrigin: 'https://known.example', subject: 'user-b' };
    await handleBookmarkPreferencesRequest({ kind: 'known.bookmark.preferences.update', userGesture: true,
      bookmarkInsertPosition: 'bottom', foldersFirst: true });
    const stored = values.get('known.bookmark.preferences.v1') as { records: Record<string, { value: unknown }> };
    assert.deepEqual(stored.records['https://known.example\u001faccount\u001fuser-a']?.value,
      { ...DEFAULT_BOOKMARK_PREFERENCES, bookmarkInsertPosition: 'top', foldersFirst: false });
    assert.deepEqual(stored.records['https://known.example\u001faccount\u001fuser-b']?.value,
      { ...DEFAULT_BOOKMARK_PREFERENCES, bookmarkInsertPosition: 'bottom', foldersFirst: true });
  });

  test('uses an independent device preference when signed out', async () => {
    mocks.credential = null;
    const result = await handleBookmarkPreferencesRequest({ kind: 'known.bookmark.preferences.update', userGesture: true,
      bookmarkInsertPosition: 'top', foldersFirst: false });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.scope, 'device');
    assert.equal(mocks.patch.mock.calls.length, 0);
    const stored = values.get('known.bookmark.preferences.v1') as { records: Record<string, { value: unknown }> };
    assert.deepEqual(stored.records['https://known.example\u001fdevice']?.value,
      { ...DEFAULT_BOOKMARK_PREFERENCES, bookmarkInsertPosition: 'top', foldersFirst: false });
    assert.deepEqual(await readEffectiveBookmarkPreferences(),
      { ...DEFAULT_BOOKMARK_PREFERENCES, bookmarkInsertPosition: 'top', foldersFirst: false });
  });
});


for (const operation of ['read', 'patch'] as const) {
  test(`local reads bypass an in-flight Product ${operation}`, async () => {
    let release!: (value: unknown) => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    mocks[operation].mockImplementation(() => {
      started(); return new Promise(resolve => { release = resolve; });
    });
    const remote = handleBookmarkPreferencesRequest(operation === 'read'
      ? { kind: 'known.bookmark.preferences.get' }
      : { kind: 'known.bookmark.preferences.update', userGesture: true,
        bookmarkInsertPosition: 'top', foldersFirst: false });
    await entered;
    const before = structuredClone(Object.fromEntries(values));
    try {
      const local = await handleBookmarkPreferencesRequest({ kind: 'known.bookmark.preferences.local' });
      assert.equal(local.ok, true);
      if (!local.ok) return;
      assert.equal(local.preferences.bookmarkInsertPosition, operation === 'read' ? 'bottom' : 'top');
      assert.equal(local.pending, operation === 'patch');
      assert.deepEqual(Object.fromEntries(values), before);
      assert.deepEqual(await readEffectiveBookmarkPreferences(), local.preferences);
    } finally {
      mocks[operation].mockResolvedValue({ value: { ...DEFAULT_BOOKMARK_PREFERENCES, bookmarkInsertPosition: 'top', foldersFirst: false }, revision: '1', etag: '\"1\"' });
      release({ value: { bookmarkInsertPosition: 'top', foldersFirst: false }, revision: '1', etag: '\"1\"' });
      await remote;
      await flushBookmarkPreferences();
    }
  });
}

test('a local cache miss returns defaults without persisting or contacting Product', async () => {
  const result = await handleBookmarkPreferencesRequest({ kind: 'known.bookmark.preferences.local' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.source, 'default');
  assert.equal(values.size, 0);
  assert.equal(mocks.read.mock.calls.length, 0);
  assert.equal(mocks.patch.mock.calls.length, 0);
});

for (const change of ['account', 'sign-out', 'relogin', 'origin'] as const) {
  test(`late preference reads reject an authority ${change} without writing another scope`, async () => {
    let started!: () => void;
    let release!: (value: unknown) => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    mocks.read.mockImplementationOnce(() => {
      started(); return new Promise(resolve => { release = resolve; });
    });
    const reading = handleBookmarkPreferencesRequest({ kind: 'known.bookmark.preferences.get' });
    await entered;
    await reading;
    const before = structuredClone(Object.fromEntries(values));
    if (change === 'account') mocks.credential = { ...mocks.credential!, subject: 'user-b' };
    if (change === 'sign-out') mocks.credential = null;
    if (change === 'relogin') mocks.generation += 2;
    if (change === 'origin') mocks.serverOrigin = 'https://another.example';
    mocks.read.mockResolvedValue({ value: { ...DEFAULT_BOOKMARK_PREFERENCES }, revision: '0', etag: '"0"' });
    release({ value: { bookmarkInsertPosition: 'top', foldersFirst: false }, revision: '9', etag: '"9"' });
    await flushBookmarkPreferences();
    assert.equal(mocks.patch.mock.calls.length, 0);
    const stored = values.get('known.bookmark.preferences.v1') as { records: Record<string, { revision: string }> };
    assert.equal(Object.values(stored.records).some(record => record.revision === '9'), false);
    assert.deepEqual(Object.keys(stored.records), Object.keys((before['known.bookmark.preferences.v1'] as typeof stored).records));
    mocks.read.mockResolvedValue({ value: { bookmarkInsertPosition: 'bottom', foldersFirst: true }, revision: '0', etag: '"0"' });
    assert.equal((await handleBookmarkPreferencesRequest({ kind: 'known.bookmark.preferences.get' })).ok, true);
  });
}

for (const patch of [{ bookmarkInsertPosition: 'top' as const }, { foldersFirst: true }]) {
  test(`partial update merges the unedited field after an in-flight refresh (${Object.keys(patch)[0]})`, async () => {
    let started!: () => void;
    let release!: (value: unknown) => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    mocks.read.mockImplementationOnce(() => {
      started(); return new Promise(resolve => { release = resolve; });
    });
    mocks.patch.mockImplementation(async value => ({ value: normalizeBookmarkPreferences({ bookmarkInsertPosition: 'top', foldersFirst: true, ...value }), revision: '8', etag: '"8"' }));
    const reading = handleBookmarkPreferencesRequest({ kind: 'known.bookmark.preferences.get' });
    await entered;
    const message = { kind: 'known.bookmark.preferences.update' as const, userGesture: true as const, ...patch };
    assert.equal(validBookmarkPreferencesRequest(message), true);
    const updating = handleBookmarkPreferencesRequest(message);
    const remote = Object.hasOwn(patch, 'bookmarkInsertPosition')
      ? { bookmarkInsertPosition: 'bottom' as const, foldersFirst: true }
      : { bookmarkInsertPosition: 'top' as const, foldersFirst: false };
    release({ value: remote, revision: '7', etag: '"7"' });
    await reading;
    await updating; await flushBookmarkPreferences();
    const result = await handleBookmarkPreferencesRequest({ kind: 'known.bookmark.preferences.local' });
    assert.equal(result.ok, true);
    const stored = values.get('known.bookmark.preferences.v1') as { records: Record<string, { value: unknown }> };
    assert.deepEqual(normalizeBookmarkPreferences(stored.records['https://known.example\u001faccount\u001fuser-a']!.value), normalizeBookmarkPreferences({ ...remote, ...patch }));
    if (result.ok && Object.hasOwn(patch, 'foldersFirst')) assert.equal(result.preferences.bookmarkInsertPosition, 'bottom');
    assert.deepEqual(mocks.patch.mock.calls[0]?.[0], patch);
    assert.equal(mocks.patch.mock.calls[0]?.[2], '"7"');
  });
}

test('partial preference messages reject empty, unknown, and invalid fields', () => {
  const base = { kind: 'known.bookmark.preferences.update', userGesture: true };
  for (const fields of [{}, { extra: true }, { foldersFirst: undefined }, { foldersFirst: null },
    { bookmarkInsertPosition: undefined }, { bookmarkInsertPosition: 'middle' },
    { bookmarkInsertPosition: 'top', foldersFirst: 'true' }, { foldersFirst: true, extra: true }]) {
    assert.equal(validBookmarkPreferencesRequest({ ...base, ...fields }), false);
  }
});

test('switching to manual fences dispatch while an earlier preference request still awaits the network', async () => {
  mocks.read.mockResolvedValue({ value: { ...DEFAULT_BOOKMARK_PREFERENCES, captureMode: 'automatic' }, revision: '1', etag: '"1"' });
  await handleBookmarkPreferencesRequest({ kind: 'known.bookmark.preferences.get' });
  await flushBookmarkPreferences();
  mocks.patch.mockImplementation(async patch => ({ value: { ...DEFAULT_BOOKMARK_PREFERENCES, ...patch }, revision: '1', etag: '"1"' }));
  await handleBookmarkPreferencesRequest({ kind: 'known.bookmark.preferences.update', userGesture: true, captureMode: 'automatic' });
  await flushBookmarkPreferences();
  let release!: () => void, started!: () => void;
  const entering = new Promise<void>(resolve => { started = resolve; });
  mocks.read.mockImplementationOnce(async () => { started(); await new Promise<void>(resolve => { release = resolve; });
    return { value: { ...DEFAULT_BOOKMARK_PREFERENCES, captureMode: 'automatic' }, revision: '1', etag: '"1"' }; });
  const prior = handleBookmarkPreferencesRequest({ kind: 'known.bookmark.preferences.get' }); await entering;
  const manual = handleBookmarkPreferencesRequest({ kind: 'known.bookmark.preferences.update', captureMode: 'manual', userGesture: true });
  const scope = { serverOrigin: mocks.serverOrigin, accountId: 'user-a', authorityGeneration: 1, collectionId: null };
  await vi.waitFor(async () => assert.equal((await readCaptureControl(scope)).manualOverride || (await readEffectiveBookmarkPreferences()).captureMode === 'manual', true));
  release(); await prior; await manual;
  assert.equal((await readEffectiveBookmarkPreferences()).captureMode, 'manual');
});

test('resolving a preference conflict preserves unrelated newer account fields', async () => {
  mocks.patch.mockRejectedValueOnce(new mocks.ProductError('precondition_failed', 412));
  mocks.read.mockResolvedValue({ value: { ...DEFAULT_BOOKMARK_PREFERENCES, subscriptionOnUnfollow: 'remove',
    subscriptionDefaultEditionLimit: 20 }, revision: '2', etag: '"2"' });
  await handleBookmarkPreferencesRequest({ kind: 'known.bookmark.preferences.update', userGesture: true, foldersFirst: false });
  await flushBookmarkPreferences();
  mocks.patch.mockImplementation(async patch => ({ value: { ...DEFAULT_BOOKMARK_PREFERENCES,
    subscriptionOnUnfollow: 'remove', subscriptionDefaultEditionLimit: 20, ...patch }, revision: '3', etag: '"3"' }));
  const result = await handleBookmarkPreferencesRequest({ kind: 'known.bookmark.preferences.resolve', userGesture: true, choice: 'local' });
  await flushBookmarkPreferences();
  assert.deepEqual(mocks.patch.mock.calls.at(-1)?.[0], { foldersFirst: false });
  assert.equal(result.ok && result.preferences.subscriptionOnUnfollow, 'remove');
  assert.equal(result.ok && result.preferences.subscriptionDefaultEditionLimit, 20);
});

test('local edits complete while a PATCH waits, and an older receipt rebases rather than erases a newer edit', async () => {
  let release!: (value: unknown) => void;
  mocks.patch.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  mocks.patch.mockImplementation(async patch => ({ value: { ...DEFAULT_BOOKMARK_PREFERENCES, ...patch }, revision: '2', etag: '"2"' }));
  try {
    const first = await handleBookmarkPreferencesRequest({ kind: 'known.bookmark.preferences.update', userGesture: true, bookmarkInsertPosition: 'top' });
    assert.equal(first.ok && first.pending, true);
    await vi.waitFor(() => assert.equal(typeof release, 'function'));
    const second = await handleBookmarkPreferencesRequest({ kind: 'known.bookmark.preferences.update', userGesture: true,
      bookmarkInsertPosition: 'bottom', foldersFirst: false });
    assert.equal(second.ok && second.pending, true);
    assert.equal(second.ok && second.preferences.bookmarkInsertPosition, 'bottom');
    assert.equal(second.ok && second.preferences.foldersFirst, false);
    release({ value: { ...DEFAULT_BOOKMARK_PREFERENCES, bookmarkInsertPosition: 'top' }, revision: '1', etag: '"1"' });
    await flushBookmarkPreferences();
    const effective = await readEffectiveBookmarkPreferences();
    assert.equal(effective.bookmarkInsertPosition, 'bottom'); assert.equal(effective.foldersFirst, false);
    assert.equal(mocks.patch.mock.calls[1]?.[2], '"1"');
  } finally { release?.({ value: DEFAULT_BOOKMARK_PREFERENCES, revision: '1', etag: '"1"' }); }
});

test('device choices survive sign-in, account changes, remote defaults and sign-out', async () => {
  mocks.credential = null;
  await handleBookmarkPreferencesRequest({ kind: 'known.bookmark.preferences.update', userGesture: true,
    bookmarkInsertPosition: 'top', captureMode: 'automatic' });
  mocks.credential = { serverOrigin: mocks.serverOrigin, subject: 'user-a' };
  await handleBookmarkPreferencesRequest({ kind: 'known.bookmark.preferences.get' }); await flushBookmarkPreferences();
  let effective = await readEffectiveBookmarkPreferences();
  assert.equal(effective.bookmarkInsertPosition, 'top'); assert.equal(effective.captureMode, 'automatic');
  mocks.credential = { serverOrigin: mocks.serverOrigin, subject: 'user-b' };
  await handleBookmarkPreferencesRequest({ kind: 'known.bookmark.preferences.get' }); await flushBookmarkPreferences();
  effective = await readEffectiveBookmarkPreferences();
  assert.equal(effective.bookmarkInsertPosition, 'top'); assert.equal(effective.captureMode, 'automatic');
  const before = await handleBookmarkPreferencesRequest({ kind: 'known.bookmark.preferences.local' });
  assert.equal(before.ok && before.accountDefaults?.bookmarkInsertPosition, 'bottom');
  await handleBookmarkPreferencesRequest({ kind: 'known.bookmark.preferences.resolve', userGesture: true, choice: 'server' });
  assert.equal((await readEffectiveBookmarkPreferences()).bookmarkInsertPosition, 'bottom');
  mocks.credential = null;
  assert.equal((await readEffectiveBookmarkPreferences()).bookmarkInsertPosition, 'bottom');
});

test('restoring browser preferences does not overwrite account defaults or create an account sync intent', async () => {
  await handleBookmarkPreferencesRequest({ kind: 'known.bookmark.preferences.get' }); await flushBookmarkPreferences();
  const key = 'https://known.example\u001faccount\u001fuser-a';
  const account = JSON.stringify((values.get('known.bookmark.preferences.v1') as { records: Record<string, unknown> }).records[key]);
  const calls = mocks.read.mock.calls.length;
  await restoreDeviceBookmarkPreferences({ bookmarkInsertPosition: 'top', captureMode: 'manual' });
  assert.equal((await readEffectiveBookmarkPreferences()).bookmarkInsertPosition, 'top');
  assert.equal(mocks.patch.mock.calls.length, 0); assert.equal(mocks.read.mock.calls.length, calls);
  assert.equal(JSON.stringify((values.get('known.bookmark.preferences.v1') as { records: Record<string, unknown> }).records[key]), account);
  await flushBookmarkPreferences();
  assert.equal((await readEffectiveBookmarkPreferences()).bookmarkInsertPosition, 'top');
});
