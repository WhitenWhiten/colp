import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, expect, test, vi } from 'vitest';
import { classifyLocalCapture } from '../src/sw/capture-local.js';
import { createCaptureStore } from '../src/capture/store.js';
import { MemoryStorageArea } from '../src/credential-store.js';
import { LOCAL_CLASSIFICATION_KEY, LOCAL_CLASSIFICATION_ENABLED } from '../src/classification-local-session.js';
import { task } from './fixtures/capture.js';
import { workspaceFolderTree } from './fixtures/workspace-folders.js';
import type { FolderTreeNode } from '../src/save-folder.js';

const move = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../src/sw/runtime.js', () => ({ syncState: {}, workCoordinator: {
  run: async (_lane: string, work: (context: unknown) => unknown) => work({ generation: 1, signal: new AbortController().signal }),
} }));
vi.mock('../src/sw/scope.js', () => ({ currentSyncScope: async () => { throw new Error('signed_out'); } }));
vi.mock('../src/sw/capture-native.js', () => ({ nativeCaptureLocation: async () => null }));
vi.mock('../src/sw/bookmark-preferences.js', () => ({ handleBookmarkPreferencesRequest: async () => ({
  ok: true, conflict: false, preferences: { captureMode: 'automatic', resumeClassificationWhenOnline: true },
}) }));
vi.mock('../src/capture/control.js', () => ({ readCaptureControl: async () => ({ generation: 0, paused: false }) }));
vi.mock('../src/bookmark-subscriptions/guards.js', () => ({
  exclusionIds: async () => new Set(), isSubscriptionExcluded: async () => false, personalBookmarks: { move },
}));
afterEach(() => { vi.unstubAllGlobals(); move.mockReset(); });

test.each([
  { permitted: true, movedIntoWorkspace: false },
  { permitted: false, movedIntoWorkspace: false },
  { permitted: true, movedIntoWorkspace: true },
])('offline classification: permission=$permitted, target moved into workspace=$movedIntoWorkspace', async ({ permitted, movedIntoWorkspace }) => {
  let requests = 0;
  const payloads: string[] = [];
  const recipes = { id: 'recipes', title: 'Recipes', parentId: 'bar' };
  const server = createServer(async (request, response) => {
    requests++;
    let body = '';
    for await (const chunk of request) body += String(chunk);
    payloads.push(body);
    if (movedIntoWorkspace) recipes.parentId = 'project';
    const payload = JSON.parse(body) as { questions: Record<string, { criteria: Record<string, string> }> };
    const answers = Object.fromEntries(Object.entries(payload.questions).map(([key, question]) => {
      const ids = Object.keys(question.criteria);
      const choice = ids.find(id => question.criteria[id]!.includes('Recipes'))!;
      return [key, { choice, confidence: 1, probabilities: Object.fromEntries(ids.map(id => [id, id === choice ? 1 : 0])) }];
    }));
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ model: 'local-model', answers }));
  });
  const ledger = createCaptureStore(new IDBFactory());
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing_loopback_port');
    const endpoint = `http://127.0.0.1:${address.port}/classify`, local = new MemoryStorageArea();
    const credential = { version: 3, generation: 'local-fixture', presetId: 'custom', endpoint, model: 'local-model', disclosed: true };
    await local.set({ [LOCAL_CLASSIFICATION_KEY]: credential, [LOCAL_CLASSIFICATION_ENABLED]: true });
    vi.stubGlobal('__KNOWN_EXTENSION_CLASSIFICATION_LOCAL__', true);
    vi.stubGlobal('navigator', { onLine: false });
    vi.stubGlobal('indexedDB', new IDBFactory());
    const bookmark = { id: 'saved', title: 'Pasta', url: task.url, parentId: 'inbox' };
    const tree: FolderTreeNode[] = [{ id: '0', title: '', children: [
      { id: 'bar', parentId: '0', title: 'Bookmarks bar', folderType: 'bookmarks-bar', children: [
        { id: 'inbox', parentId: 'bar', title: 'Inbox', children: [bookmark] }, recipes,
      ] },
      workspaceFolderTree()[0]!.children!.find(node => node.id === 'workspaces')!,
    ] }];
    const nodes = new Map<string, FolderTreeNode>();
    const visit = (node: FolderTreeNode) => { nodes.set(node.id, node); node.children?.forEach(visit); };
    tree.forEach(visit);
    vi.stubGlobal('chrome', {
      storage: { local, session: new MemoryStorageArea() }, permissions: { contains: async () => permitted }, bookmarks: {
        get: async (id: string) => nodes.has(id) ? [nodes.get(id)] : [],
        getTree: async () => tree,
      },
    });
    const capture = await ledger.claim({ ...task, scope: { ...task.scope, accountId: null, collectionId: null },
      createdAt: Date.now(), updatedAt: Date.now(), title: bookmark.title, targetNativeId: 'inbox', nativeId: 'saved',
      automaticIntent: true, save: 'local-saved', classification: 'waiting', sync: 'local-only', manualFence: 0, controlGeneration: 0,
      local: { commandId: null, state: 'waiting' } });
    const result = await classifyLocalCapture(capture, ledger);
    expect(result).toMatchObject(!permitted
      ? { save: 'local-saved', classification: 'manual', reason: 'local_key_required' }
      : movedIntoWorkspace ? { save: 'local-saved', classification: 'manual', reason: 'local_no_folder' }
        : { save: 'local-saved', classification: 'applied', reason: null, local: { folderNativeId: 'recipes' } });
    expect(requests).toBe(permitted ? 1 : 0);
    expect(payloads.join('')).not.toMatch(/Workspaces|Research project|Workspace papers|workspace\.example/u);
    if (permitted && !movedIntoWorkspace) expect(move).toHaveBeenCalledWith('saved', { parentId: 'recipes' });
    else expect(move).not.toHaveBeenCalled();
    expect((await local.get(LOCAL_CLASSIFICATION_KEY))[LOCAL_CLASSIFICATION_KEY]).toEqual(credential);
  } finally {
    await ledger.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
