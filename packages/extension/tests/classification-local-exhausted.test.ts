import { afterEach, expect, test, vi } from 'vitest';
import { previewLocalClassification } from '../src/classification-local-preview.js';
import type { LocalClassificationCredential } from '../src/classification-local-session.js';

afterEach(() => vi.unstubAllGlobals());

test('local exhausted alternatives never contact the user provider', async () => {
  const values: Record<string, unknown> = {};
  vi.stubGlobal('chrome', { storage: { session: {
    get: async (key: string) => ({ [key]: values[key] }),
    set: async (next: Record<string, unknown>) => { Object.assign(values, next); },
  } } });
  const credential: LocalClassificationCredential = { version: 3, generation: 'session', presetId: 'custom',
    endpoint: 'https://provider.example/classify', model: 'local-model', disclosed: true };
  const transport = vi.fn<typeof fetch>();
  const result = await previewLocalClassification({ credential, commandId: crypto.randomUUID(), signal: new AbortController().signal,
    assertCurrent: async () => undefined, transport,
    document: { source: 'extension', bookmark: { title: 'React', url: 'https://react.dev', description: null },
      requested: { folder: true, tags: false }, rejectedFolderIds: ['42'], folderSelectionMode: 'require_candidate' },
    taxonomy: { folders: [{ id: '42', parentId: null, title: 'Development', description: null }], tagUsage: [],
      title: 'Bookmarks', summary: null, revision: '1', collectionId: 'local' } });
  expect(result.folder).toMatchObject({ decision: 'later', folderId: null });
  expect(result.candidateCoverage.l1Included).toBe(0);
  expect(transport).not.toHaveBeenCalled();
});
