import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FolderLookup } from '../src/automation/browser-rules.js';
import { checkRuleDraft, type RuleAction, type RuleCondition } from '../src/automation/rule-conditions.js';
import { flattenList } from '../src/automation/rule-list-flatten.js';
import type { LocalRule, RuleListRecord } from '../src/automation/rule-list-store.js';
import { planRun, RUN_LIMIT, topFolders, type RunTreeNode } from '../src/automation/run-once.js';
import type { RuleDraft } from '../src/automation/rule-conditions.js';
import { NOW } from './automation-fixture.js';

/** Doc 17 §6.4, R16, RS-14: Run once plans over one folder, moves on a second step, and Undo moves back only what is still where it left it. */
interface Node { id: string; title: string; url?: string; parentId: string; children?: string[] }
const tree = vi.hoisted(() => ({ nodes: new Map<string, Node>(), excluded: new Set<string>(), unsupported: new Set<string>() }));
vi.mock('../src/sw/runtime.js', () => ({ hasBookmarkPermission: async () => true }));
vi.mock('../src/bookmark-folder-policy.js', () => ({
  assertBookmarkFolderAllowed: async (id: string) => { if (tree.unsupported.has(id)) throw new Error('bookmark_folder_unavailable'); } }));
vi.mock('../src/bookmark-subscriptions/guards.js', () => ({
  exclusionIds: async () => new Set(tree.excluded),
  isSubscriptionExcluded: async (id: string) => {
    for (let at: string | undefined = id; at; at = tree.nodes.get(at)?.parentId) if (tree.excluded.has(at)) return true;
    return false;
  },
  personalBookmarks: { move: (id: string, destination: { parentId: string; index?: number }) => chrome.bookmarks.move(id, destination) },
}));

import { handleRunCommand, RUN_PREVIEW_KEY } from '../src/sw/automation-run.js';
import { browserRuleStore, handleBrowserRuleCommand } from '../src/sw/automation-browser.js';
import { automationDatabase } from '../src/automation/indexeddb-store.js';

// ---- the planner, over a supplied tree ----
const folders: Record<string, { id: string; title: string }> = { 30: { id: '30', title: 'Papers' }, 31: { id: '31', title: 'Reading' }, 40: { id: '40', title: 'Managed' } };
const lookup: FolderLookup = async (id) => folders[id] ?? null;
function rule(id: string, conditions: RuleCondition[], action: RuleAction = { kind: 'file', folderNativeId: '30' }): LocalRule {
  const checked = checkRuleDraft({ name: id, combinator: 'all', conditions, action });
  if (!checked.ok) throw new Error('invalid draft');
  return { id, enabled: true, name: checked.name, combinator: 'all', conditions: checked.conditions, action, definition: checked.definition,
    compiledFrom: { contentVersions: {} }, createdAt: NOW, updatedAt: NOW };
}
const list = (...rules: LocalRule[]): RuleListRecord => ({ version: 2, revision: 3, enabled: true, entries: rules.map((item) => ({ kind: 'rule', rule: item })) });
const mark = (id: string, url: string, parentId: string, title = id): RunTreeNode => ({ id, title, url, parentId });
const folder = (id: string, children: RunTreeNode[], parentId = '1'): RunTreeNode => ({ id, title: `Folder ${id}`, parentId, children });
const ports = { lookup, destinationAllowed: async (id: string) => id !== '40' };

describe('planning a run', () => {
  const rules = flattenList(list(rule('arxiv', [{ kind: 'siteIs', value: 'arxiv.org' }]), rule('keep', [{ kind: 'siteIs', value: 'keep.example' }], { kind: 'keepHere' }),
    rule('gone', [{ kind: 'siteIs', value: 'gone.example' }], { kind: 'file', folderNativeId: '99' }),
    rule('managed', [{ kind: 'siteIs', value: 'managed.example' }], { kind: 'file', folderNativeId: '40' })));

  it('lists only bookmarks that would move, and counts the rest by why they stay', async () => {
    const root = folder('20', [mark('b1', 'https://arxiv.org/abs/1', '20'), mark('b2', 'https://keep.example/', '20'), mark('b3', 'https://example.org/', '20'),
      mark('b4', 'javascript:void(0)', '20'), mark('b5', 'https://gone.example/', '20'), mark('b6', 'https://managed.example/', '20'),
      folder('30', [mark('b7', 'https://arxiv.org/abs/7', '30')], '20')]);
    const plan = await planRun(root, rules, new Set(), ports, NOW);
    expect(plan).toMatchObject({ counted: 7, tooMany: false, unchanged: 1, kept: 1, unmatched: 2, excludedFolders: 0,
      moves: [{ nativeId: 'b1', fromParentId: '20', toParentId: '30', toTitle: 'Papers', entry: { listRevision: 3, kind: 'rule', ruleId: 'arxiv' } }],
      blocked: [{ nativeId: 'b5', reason: 'bindingUnavailable' }, { nativeId: 'b6', reason: 'bindingUnavailable' }] });
    expect(topFolders(plan.moves)).toEqual([{ nativeId: '30', title: 'Papers', count: 1 }]);
  });

  it('does not enter excluded subtrees', async () => {
    const root = folder('20', [mark('b1', 'https://arxiv.org/abs/1', '20'), folder('sub', [mark('b2', 'https://arxiv.org/abs/2', 'sub')], '20')]);
    const plan = await planRun(root, rules, new Set(['sub']), ports, NOW);
    expect([plan.counted, plan.excludedFolders, plan.moves.map((move) => move.nativeId)]).toEqual([1, 1, ['b1']]);
  });

  it(`plans nothing over ${RUN_LIMIT.toLocaleString('en')} bookmarks and says so`, async () => {
    const many = Array.from({ length: RUN_LIMIT + 1 }, (_, index) => mark(`m${index}`, `https://arxiv.org/abs/${index}`, '20'));
    const plan = await planRun(folder('20', many), rules, new Set(), ports, NOW);
    expect([plan.tooMany, plan.counted, plan.moves.length]).toEqual([true, RUN_LIMIT, 0]);
    expect((await planRun(folder('20', many.slice(0, RUN_LIMIT)), flattenList(list()), new Set(), ports, NOW)).tooMany).toBe(false);
  });
});

// ---- the worker: preview, apply, undo over an in-memory bookmark tree ----
function add(node: Node): void {
  tree.nodes.set(node.id, node);
  const parent = tree.nodes.get(node.parentId);
  if (parent) parent.children = [...parent.children ?? [], node.id];
}
const view = (id: string) => {
  const node = tree.nodes.get(id)!;
  const index = tree.nodes.get(node.parentId)?.children?.indexOf(id) ?? 0;
  return { id, title: node.title, parentId: node.parentId, index, ...(node.url ? { url: node.url } : {}) };
};
const sub = (id: string): unknown => {
  const node = tree.nodes.get(id)!;
  return { ...view(id), ...(node.children ? { children: node.children.map(sub) } : {}) };
};
function move(id: string, destination: { parentId: string; index?: number }) {
  const node = tree.nodes.get(id)!;
  const from = tree.nodes.get(node.parentId)!;
  from.children = from.children!.filter((child) => child !== id);
  const to = tree.nodes.get(destination.parentId);
  if (!to?.children) throw new Error('Can’t find parent bookmark');
  const at = destination.index ?? to.children.length;
  if (at > to.children.length) throw new Error('Index out of bounds');
  to.children.splice(at, 0, id); node.parentId = destination.parentId;
  return view(id);
}
const parent = (id: string) => tree.nodes.get(id)!.parentId;
const draft = (folderNativeId: string): RuleDraft => ({ name: 'Papers from arXiv', combinator: 'all', conditions: [{ kind: 'siteIs', value: 'arxiv.org' }],
  action: { kind: 'file', folderNativeId } });

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
  vi.stubGlobal('indexedDB', new IDBFactory());
  tree.nodes.clear(); tree.excluded.clear(); tree.unsupported.clear();
  tree.nodes.set('0', { id: '0', title: '', parentId: '', children: [] });
  add({ id: '1', title: 'Bookmarks bar', parentId: '0', children: [] });
  add({ id: '20', title: 'Inbox', parentId: '1', children: [] });
  add({ id: '30', title: 'Papers', parentId: '1', children: [] });
  add({ id: 'p0', title: 'Old', url: 'https://example.org/old', parentId: '30' });
  for (const [id, url] of [['b1', 'https://arxiv.org/abs/1'], ['b2', 'https://example.org/'], ['b3', 'https://arxiv.org/abs/3'], ['b4', 'https://arxiv.org/abs/4']]) {
    add({ id: id!, title: id!, url: url!, parentId: '20' });
  }
  vi.stubGlobal('chrome', { storage: { local: { get: async () => ({}), set: async () => undefined } }, bookmarks: {
    get: async (id: string) => { if (!tree.nodes.has(id)) throw new Error('Can’t find bookmark for id.'); return [view(id)]; },
    getChildren: async (id: string) => tree.nodes.get(id)!.children!.map(view),
    getSubTree: async (id: string) => [sub(id)], move: async (id: string, destination: { parentId: string; index?: number }) => move(id, destination) } });
  await handleBrowserRuleCommand({ kind: 'known.automation.browser.save', draft: draft('30') });
});
afterEach(async () => { vi.restoreAllMocks(); automationDatabase().close?.(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const preview = async (scopeNativeId = '20') => {
  const reply = await handleRunCommand({ kind: 'known.automation.browser.runPreview', scopeNativeId });
  if (!reply.ok || !('run' in reply)) throw new Error(JSON.stringify(reply));
  return reply.run;
};

describe('a run', () => {
  it('previews a folder, moves what it listed on apply, and moves it back on undo, at its old place', async () => {
    const run = await preview();
    expect(run).toMatchObject({ scope: { nativeId: '20', title: 'Inbox' }, counted: 4, moves: 3, unmatched: 1, tooMany: false,
      topFolders: [{ nativeId: '30', title: 'Papers', count: 3 }], examples: [{ title: 'b1', to: 'Papers' }, { title: 'b3' }, { title: 'b4' }] });
    // A preview moves nothing.
    expect(['b1', 'b3', 'b4'].map(parent)).toEqual(['20', '20', '20']);
    const applied = await handleRunCommand({ kind: 'known.automation.browser.runApply', previewId: run.previewId });
    expect(applied).toMatchObject({ ok: true, result: { moved: 3, skipped: 0, missing: 0 } });
    expect(tree.nodes.get('30')!.children).toEqual(['p0', 'b1', 'b3', 'b4']);
    // The preview is used up.
    expect(await handleRunCommand({ kind: 'known.automation.browser.runApply', previewId: run.previewId })).toEqual({ ok: false, error: 'expired' });
    if (!applied.ok || !('result' in applied)) throw new Error('no result');
    expect(await handleRunCommand({ kind: 'known.automation.browser.runUndo', runId: applied.result.runId })).toMatchObject({ ok: true,
      result: { moved: 3, skipped: 0, missing: 0 } });
    expect(tree.nodes.get('20')!.children).toEqual(['b1', 'b2', 'b3', 'b4']);
    expect(tree.nodes.get('30')!.children).toEqual(['p0']);
  });

  it('refuses to apply once the list has changed, or the preview has expired', async () => {
    const run = await preview();
    await handleBrowserRuleCommand({ kind: 'known.automation.browser.save', draft: { ...draft('20'), name: 'Another' } });
    expect(await handleRunCommand({ kind: 'known.automation.browser.runApply', previewId: run.previewId })).toEqual({ ok: false, error: 'changed' });
    expect(parent('b1')).toBe('20');
    const again = await preview();
    vi.setSystemTime(NOW + 15 * 60_000 + 1);
    expect(await handleRunCommand({ kind: 'known.automation.browser.runApply', previewId: again.previewId })).toEqual({ ok: false, error: 'expired' });
  });

  it('leaves alone a bookmark moved meanwhile, and on undo one that changed since', async () => {
    const run = await preview();
    move('b3', { parentId: '1' });
    const applied = await handleRunCommand({ kind: 'known.automation.browser.runApply', previewId: run.previewId });
    expect(applied).toMatchObject({ ok: true, result: { moved: 2, skipped: 1 } });
    expect([parent('b1'), parent('b3'), parent('b4')]).toEqual(['30', '1', '30']);
    if (!applied.ok || !('result' in applied)) throw new Error('no result');
    move('b4', { parentId: '1' });
    expect(await handleRunCommand({ kind: 'known.automation.browser.runUndo', runId: applied.result.runId })).toMatchObject({ ok: true,
      result: { moved: 1, skipped: 1, missing: 0 } });
    expect([parent('b1'), parent('b4')]).toEqual(['20', '1']);
    // Nothing is left to move back.
    expect(await handleRunCommand({ kind: 'known.automation.browser.runUndo', runId: applied.result.runId })).toMatchObject({ result: { moved: 0, skipped: 0 } });
  });

  it('does not enter a subscription’s folder, nor run in one', async () => {
    add({ id: 'managed', title: 'Subscribed', parentId: '20', children: [] });
    add({ id: 'b9', title: 'b9', url: 'https://arxiv.org/abs/9', parentId: 'managed' });
    tree.excluded.add('managed');
    const run = await preview();
    expect([run.counted, run.moves, run.excludedFolders]).toEqual([4, 3, 1]);
    expect(await handleRunCommand({ kind: 'known.automation.browser.runPreview', scopeNativeId: 'managed' })).toEqual({ ok: false, error: 'excluded' });
    expect(await handleRunCommand({ kind: 'known.automation.browser.runPreview', scopeNativeId: 'b1' })).toEqual({ ok: false, error: 'notFound' });
    await handleBrowserRuleCommand({ kind: 'known.automation.browser.list.enable', enabled: false });
    expect(await handleRunCommand({ kind: 'known.automation.browser.runPreview', scopeNativeId: '20' })).toEqual({ ok: false, error: 'listOff' });
  });

  it('keeps one preview at a time and lists its runs for Options', async () => {
    const { browserRunViews } = await import('../src/sw/automation-run.js');
    const first = await preview(), second = await preview();
    expect(await handleRunCommand({ kind: 'known.automation.browser.runApply', previewId: first.previewId })).toEqual({ ok: false, error: 'expired' });
    expect((await automationDatabase().area().get(RUN_PREVIEW_KEY) as { previewId: string }).previewId).toBe(second.previewId);
    await handleRunCommand({ kind: 'known.automation.browser.runApply', previewId: second.previewId });
    expect(await browserRunViews()).toMatchObject([{ scopeTitle: 'Inbox', state: 'done', moved: 3, skipped: 0, undone: 0, canUndo: true }]);
    expect((await browserRuleStore().load()).revision).toBe(1);
  });
});


describe('durable run recovery and user edits', () => {
  function failItemWrite(state: string) {
    const database = automationDatabase(), original = database.area();
    return vi.spyOn(database, 'area').mockReturnValue({ ...original, async set(key, value) {
      if (key.startsWith('known.automation.browserRunItem.v1:') && (value as { state?: string }).state === state)
        throw new Error('worker interrupted');
      return original.set(key, value);
    } });
  }
  it('writes the intent before moving and can undo after losing the completion write', async () => {
    const run = await preview(), failure = failItemWrite('moved');
    await expect(handleRunCommand({ kind: 'known.automation.browser.runApply', previewId: run.previewId })).rejects.toThrow('worker interrupted');
    expect(parent('b1')).toBe('30');
    failure.mockRestore(); automationDatabase().close();
    const { browserRunViews } = await import('../src/sw/automation-run.js');
    const [interrupted] = await browserRunViews();
    expect(interrupted).toMatchObject({ state: 'interrupted', canUndo: true });
    expect(await handleRunCommand({ kind: 'known.automation.browser.runUndo', runId: interrupted!.runId })).toMatchObject({ result: { moved: 1 } });
    expect(parent('b1')).toBe('20');
    expect(tree.nodes.get('20')!.children).toEqual(['b1', 'b2', 'b3', 'b4']);
  });
  it('does not move when persisting the intent fails', async () => {
    const run = await preview(); failItemWrite('moving');
    await expect(handleRunCommand({ kind: 'known.automation.browser.runApply', previewId: run.previewId })).rejects.toThrow();
    expect(['b1', 'b3', 'b4'].map(parent)).toEqual(['20', '20', '20']);
  });
  it('recovers an interrupted Undo without repeating a completed native move', async () => {
    const run = await preview();
    const applied = await handleRunCommand({ kind: 'known.automation.browser.runApply', previewId: run.previewId });
    if (!applied.ok || !('result' in applied)) throw new Error('no result');
    const failure = failItemWrite('undone');
    await expect(handleRunCommand({ kind: 'known.automation.browser.runUndo', runId: applied.result.runId })).rejects.toThrow();
    expect(parent('b4')).toBe('20');
    failure.mockRestore(); automationDatabase().close();
    const moves = vi.spyOn(chrome.bookmarks, 'move');
    await handleRunCommand({ kind: 'known.automation.browser.runUndo', runId: applied.result.runId });
    expect(moves.mock.calls.map(([id]) => id)).toEqual(['b3', 'b1']);
    expect(tree.nodes.get('20')!.children).toEqual(['b1', 'b2', 'b3', 'b4']);
  });
  it('keeps URL and title edits made after preview', async () => {
    const run = await preview();
    tree.nodes.get('b1')!.url = 'https://unrelated.example/changed';
    tree.nodes.get('b3')!.title = 'Edited by me';
    expect(await handleRunCommand({ kind: 'known.automation.browser.runApply', previewId: run.previewId }))
      .toMatchObject({ result: { moved: 1, skipped: 2 } });
    expect([parent('b1'), parent('b3')]).toEqual(['20', '20']);
  });
  it('keeps a bookmark manually reordered within its destination', async () => {
    const run = await preview();
    const applied = await handleRunCommand({ kind: 'known.automation.browser.runApply', previewId: run.previewId });
    if (!applied.ok || !('result' in applied)) throw new Error('no result');
    move('b1', { parentId: '30', index: 0 });
    await handleRunCommand({ kind: 'known.automation.browser.runUndo', runId: applied.result.runId });
    expect(parent('b1')).toBe('30');
    expect(tree.nodes.get('30')!.children![0]).toBe('b1');
  });
});
