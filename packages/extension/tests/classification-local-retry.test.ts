import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MemoryStorageArea } from '../src/credential-store.js';
import { classificationErrorFeedback } from '../src/classification-error-feedback.js';

vi.mock('../src/sw/runtime.js', () => ({ syncState: {} }));
vi.mock('../src/sw/scope.js', () => ({ currentSyncScope: async () => { throw new Error('signed_out'); } }));
vi.mock('../src/bookmark-subscriptions/guards.js', () => ({ exclusionIds: async () => new Set(), isSubscriptionExcluded: async () => false }));
vi.mock('../src/folder-description-native.js', () => ({ readNativeFolderDescriptions: async () => new Map() }));
vi.mock('../src/classification-local-tags.js', () => ({ localClassificationTags: async () => [] }));
vi.mock('../src/classification-local-session.js', async original => ({ ...await original<object>(),
  localClassificationCredential: async () => ({ version: 3, generation: 'typesafe-session', presetId: 'typesafe',
    endpoint: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest', secret: 'fixture-only', disclosed: true }) }));

import { runLocalClassification } from '../src/sw/classification-local.js';
const folders = [{ id: '10', title: 'Development', parentId: '1', children: [] }, { id: '20', title: 'Reading', parentId: '1', children: [] }];
beforeEach(() => {
  vi.stubGlobal('chrome', { storage: { session: new MemoryStorageArea() }, bookmarks: {
    getTree: vi.fn(async () => [{ id: '0', title: '', children: [{ id: '1', title: 'Bookmarks bar', children: folders }] }]),
    get: async (id: string) => folders.filter(node => node.id === id),
  } });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const run = () => runLocalClassification({ commandId: crypto.randomUUID(), generation: 1, signal: new AbortController().signal,
  document: { source: 'extension', bookmark: { title: 'React', url: 'https://react.dev', description: null },
    requested: { folder: true, tags: false }, folderSelectionMode: 'require_candidate' } });

test('a TypeSafe retry sends native questions and accepts a valid candidate response', async () => {
  const transport = vi.fn<typeof fetch>(async () => Response.json({ model: 'jev-latest', answers: {
    folder: { type: 'choice', choice: 'f0', confidence: 1, probabilities: { f0: 1, f1: 0 } },
  } }));
  vi.stubGlobal('fetch', transport);
  const reply = await run();
  expect(reply).toMatchObject({ ok: true, nativeFolder: { nativeId: '10' } });
  const [url, init] = transport.mock.calls[0]!;
  expect(url).toBe('https://api.typesafe.ai/v1/systemone');
  const body = JSON.parse(String(init!.body));
  expect(body.input).toBeUndefined();
  expect(body.questions.folder.criteria).toEqual({ f0: expect.any(String), f1: expect.any(String) });
});

test.each([400, 200])('a responding TypeSafe service with an invalid request/result (HTTP %s) is not called unavailable', async status => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ model: 'jev-latest', answers: { private: 'raw-provider-details' } }, { status })));
  const reply = await run();
  expect(reply).toEqual({ ok: false, error: 'local_request_failed' });
  if (reply.ok) throw new Error('expected_failure');
  expect(classificationErrorFeedback(reply.error, true).text).toContain('unexpected format');
  expect(JSON.stringify(reply)).not.toContain('raw-provider-details');
});

test('a rate-limited response and a lost result retain their distinct failure codes', async () => {
  const transport = vi.fn(async () => new Response('{}', { status: 429, headers: { 'retry-after': '0' } }));
  vi.stubGlobal('fetch', transport);
  expect(await run()).toEqual({ ok: false, error: 'local_rate_limited' });
  expect(transport).toHaveBeenCalledTimes(2);
  transport.mockRejectedValueOnce(new Error('connection_lost'));
  expect(await run()).toEqual({ ok: false, error: 'local_result_unknown' });
});

test('a forced retry with one legal folder succeeds without a single-option TypeSafe request', async () => {
  vi.mocked(chrome.bookmarks.getTree).mockResolvedValue([{ id: '0', title: '', children: [{ id: '1', title: 'Bar', children: [folders[0]!] }] }]);
  const transport = vi.fn(); vi.stubGlobal('fetch', transport);
  expect(await run()).toMatchObject({ ok: true, nativeFolder: { nativeId: '10' } });
  expect(transport).not.toHaveBeenCalled();
});
