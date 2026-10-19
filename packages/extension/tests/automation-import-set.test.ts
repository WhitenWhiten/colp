import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validBrowserRuleCommand } from '../src/automation/messages.js';

/** Doc 17 RS-02, RS-07: a rule-set file checked, added as a set with its roles bound here, rebound later, and written back out. */
const f = vi.hoisted(() => ({
  nodes: new Map<string, { id: string; title: string; parentId: string; url?: string }>(),
  recent: [] as { id: string; title: string; url?: string }[],
}));
vi.mock('../src/sw/runtime.js', () => ({ hasBookmarkPermission: async () => true }));
vi.mock('../src/bookmark-folder-policy.js', () => ({ assertBookmarkFolderAllowed: async () => undefined }));
vi.mock('../src/bookmark-subscriptions/guards.js', () => ({ isSubscriptionExcluded: async (id: string) => id === 'managed' }));

import { browserListViews, browserRuleStore } from '../src/sw/automation-browser.js';
import { handleRulesetCommand } from '../src/sw/automation-ruleset.js';

const file = JSON.stringify({ format: 'colp.ruleset/v1', id: 'community-tech', name: 'Community technology sites', version: '2026.10.18-1',
  publisher: { name: 'Example Collective' }, license: 'CC-BY-4.0',
  roles: [{ key: 'papers', description: 'Academic papers' }, { key: 'code', description: 'Source code' }],
  sites: [{ id: 'arxiv', name: 'arXiv', addresses: [{ host: 'arxiv.org', scope: 'domain', status: 'current' }] }],
  entries: [{ id: 'e-arxiv', name: 'arXiv', site: 'arxiv', role: 'papers' },
    { id: 'e-gh', name: 'GitHub repositories', match: { kind: 'field', field: 'bookmark.url.host', op: 'eq', value: 'github.com' }, role: 'code' },
    { id: 'e-data', site: 'arxiv' }] });
const create = vi.fn();

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  f.nodes.clear();
  for (const [id, title, parentId] of [['1', 'Bookmarks bar', '0'], ['30', 'Papers', '1'], ['32', 'Code', '1'], ['managed', 'Subscribed', '1']]) {
    f.nodes.set(id!, { id: id!, title: title!, parentId: parentId! });
  }
  f.nodes.set('b1', { id: 'b1', title: 'A bookmark', parentId: '1', url: 'https://example.org/' });
  f.recent = [{ id: 'r1', title: 'A paper', url: 'https://arxiv.org/abs/1' }, { id: 'r2', title: 'Another', url: 'https://export.arxiv.org/abs/2' },
    { id: 'r3', title: 'Code', url: 'https://github.com/know-n' }, { id: 'r4', title: 'Elsewhere', url: 'https://example.org/' }, { id: 'folder', title: 'A folder' }];
  create.mockReset();
  vi.stubGlobal('chrome', { storage: { local: { get: async () => ({}), set: async () => undefined } }, bookmarks: { create,
    get: async (id: string) => { const node = f.nodes.get(id); if (!node) throw new Error('Can’t find bookmark for id.'); return [node]; },
    getRecent: async (count: number) => f.recent.slice(0, count) } });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('importing a rule set', () => {
  it('checks the file and says what it adds and how many recent bookmarks its rules would file, by role', async () => {
    expect(validBrowserRuleCommand({ kind: 'known.automation.browser.import.check', text: file })).toBe(true);
    expect(await handleRulesetCommand({ kind: 'known.automation.browser.import.check', text: file })).toEqual({ ok: true, ruleset: {
      id: 'community-tech', name: 'Community technology sites', version: '2026.10.18-1', publisher: 'Example Collective', license: 'CC-BY-4.0',
      roles: [{ key: 'papers', description: 'Academic papers', rules: 1 }, { key: 'code', description: 'Source code', rules: 1 }],
      rules: 2, matchingOnly: 1, inactive: 0, sample: { size: 4, limit: 2_000, matched: 3, byRole: [{ role: 'papers', count: 2 }, { role: 'code', count: 1 }] } } });
    expect(await browserRuleStore().load()).toMatchObject({ revision: 0, entries: [] });
  });

  it('answers a refused file with its problems, and adds nothing', async () => {
    const bad = file.replace('"op":"eq"', '"op":"near"');
    expect(await handleRulesetCommand({ kind: 'known.automation.browser.import', text: bad, bindings: {} }))
      .toEqual({ ok: false, error: 'invalid', rulesetProblems: [{ pointer: '/entries/1/match', code: 'invalidMatch' }] });
    expect((await browserRuleStore().load()).entries).toEqual([]);
  });

  it('adds the set at the end with the roles bound to folders chosen here, one left waiting, and creates no folder (RS-07.5)', async () => {
    expect(await handleRulesetCommand({ kind: 'known.automation.browser.import', text: file, bindings: { papers: 'managed' } }))
      .toEqual({ ok: false, error: 'folderGone' });
    expect(await handleRulesetCommand({ kind: 'known.automation.browser.import', text: file, bindings: { papers: 'b1' } }))
      .toEqual({ ok: false, error: 'folderGone' });
    const added = await handleRulesetCommand({ kind: 'known.automation.browser.import', text: file, bindings: { papers: '30', code: null } });
    expect(added).toMatchObject({ ok: true, set: { name: 'Community technology sites', bindings: { papers: '30' } } });
    const { list } = await browserListViews();
    expect(list.entries).toMatchObject([{ kind: 'set', set: { origin: { kind: 'import', sourceName: 'Community technology sites', sourceVersion: '2026.10.18-1',
      publisher: 'Example Collective' }, roles: [{ key: 'papers', folder: { nativeId: '30', title: 'Papers' } }, { key: 'code', folder: null }],
      rules: [{ name: 'arXiv', role: 'Academic papers', needsFolder: false, folderMissing: false, folder: { title: 'Papers' } },
        { name: 'GitHub repositories', role: 'Source code', needsFolder: true, folderMissing: false, folder: null }] } }]);
    // Bound later, the waiting role files.
    const set = list.entries[0]!.kind === 'set' ? list.entries[0]!.set : null;
    expect(validBrowserRuleCommand({ kind: 'known.automation.browser.set.bind', id: set!.id, bindings: { code: '32' } })).toBe(true);
    expect(await handleRulesetCommand({ kind: 'known.automation.browser.set.bind', id: set!.id, bindings: { code: '32' } })).toMatchObject({ ok: true });
    const after = (await browserListViews()).list.entries[0];
    expect(after?.kind === 'set' && after.set.rules.map((rule) => [rule.needsFolder, rule.folder?.title])).toEqual([[false, 'Papers'], [false, 'Code']]);
    expect(create).not.toHaveBeenCalled();
  });

  it('writes a set back out as a rule-set file', async () => {
    await handleRulesetCommand({ kind: 'known.automation.browser.import', text: file, bindings: { papers: '30' } });
    const [entry] = (await browserRuleStore().load()).entries;
    const out = await handleRulesetCommand({ kind: 'known.automation.browser.set.export', id: entry!.kind === 'set' ? entry!.set.id : '' });
    if (!out.ok || !('config' in out)) throw new Error('no export');
    expect(out.config.filename).toBe('community-technology-sites.colp-ruleset.json');
    expect(JSON.parse(out.config.content)).toMatchObject({ format: 'colp.ruleset/v1', roles: [{ key: 'papers' }, { key: 'code' }],
      entries: [{ name: 'arXiv', role: 'papers' }, { name: 'GitHub repositories', role: 'code' }] });
    expect(await handleRulesetCommand({ kind: 'known.automation.browser.set.export', id: 'gone' })).toEqual({ ok: false, error: 'notFound' });
  });
});
