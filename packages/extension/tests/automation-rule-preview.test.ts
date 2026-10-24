import { describe, expect, it } from 'vitest';
import type { FolderLookup } from '../src/automation/browser-rules.js';
import { validBrowserRuleCommand } from '../src/automation/messages.js';
import { checkRuleDraft, type RuleAction, type RuleCondition } from '../src/automation/rule-conditions.js';
import { flattenList, type FlatItem } from '../src/automation/rule-list-flatten.js';
import type { ListEntry, LocalRule, RuleListRecord } from '../src/automation/rule-list-store.js';
import { broadItem, previewList } from '../src/automation/rule-preview.js';
import { movedInSample } from '../src/automation/rule-preview-pane.js';
import { NOW } from './automation-fixture.js';

/** Doc 17 RS-08: a page tried against the whole list names its winner, what it passed over and what it hides; nothing is written. */
const folders: Record<string, { id: string; title: string }> = { 30: { id: '30', title: 'Papers' }, 31: { id: '31', title: 'Reading' }, 32: { id: '32', title: 'Code' } };
const lookup: FolderLookup = async (id) => folders[id] ?? null;

function rule(id: string, conditions: RuleCondition[], action: RuleAction = { kind: 'file', folderNativeId: '30' }): LocalRule {
  const checked = checkRuleDraft({ name: id, combinator: 'all', conditions, action });
  if (!checked.ok) throw new Error('invalid draft');
  return { id, enabled: true, name: checked.name, combinator: 'all', conditions: checked.conditions, action, definition: checked.definition,
    compiledFrom: { contentVersions: {} }, createdAt: NOW, updatedAt: NOW };
}
const list = (entries: ListEntry[], over: Partial<RuleListRecord> = {}): RuleListRecord => ({ version: 3, revision: 7, enabled: true, entries, ...over });
const one = (item: LocalRule): ListEntry => ({ kind: 'rule', rule: item });
const research = (...rules: LocalRule[]): ListEntry => ({ kind: 'set', set: { id: 's-1', name: 'Research', enabled: true, createdAt: NOW, updatedAt: NOW,
  origin: { kind: 'custom' }, roles: [], bindings: {}, rules } });
const subscribed = (id: string, conditions: RuleCondition[], folder: string): FlatItem => ({
  ref: { kind: 'subscriptionEntry', subscriptionId: 'sub-1', entryId: id, contentVersion: '2026.10.1' }, id, name: id,
  source: { id: 'sub-1', name: 'Community list' }, definition: rule(id, conditions).definition, action: { kind: 'file', folderNativeId: folder }, exceptions: [] });
const community = (items: FlatItem[]) => () => ({ name: 'Community list', ready: true, contentVersion: '2026.10.1', items });

describe('a page against the whole list (RS-08.2)', () => {
  it('names the winner with its set, the entries passed over, and every later match as shadowed', async () => {
    const record = list([one(rule('local-file', [{ kind: 'siteIs', value: 'example.org' }])),
      research(rule('papers', [{ kind: 'titleContains', value: 'paper' }], { kind: 'file', folderNativeId: '31' })),
      one(rule('arxiv', [{ kind: 'siteIs', value: 'arxiv.org' }])), { kind: 'subscription', subscriptionId: 'sub-1', enabled: true }]);
    const flat = flattenList(record, community([subscribed('e-1', [{ kind: 'siteEndsWith', value: 'arxiv.org' }], '32')]));
    const preview = await previewList(flat, null, { page: { url: 'https://arxiv.org/abs/1', title: 'A paper' } }, lookup, NOW);
    expect(preview).toMatchObject({ listRevision: 7, contentVersions: { 'sub-1': '2026.10.1' }, stopped: null, page: {
      outcome: 'placed', folder: { nativeId: '31', title: 'Reading' }, broad: false,
      winner: { id: 'papers', name: 'papers', kind: 'setRule', setId: 's-1', sourceName: 'Research' },
      shadowed: [{ id: 'arxiv', kind: 'rule', sourceName: null },
        { id: 'e-1', kind: 'subscriptionEntry', subscriptionId: 'sub-1', contentVersion: '2026.10.1', sourceName: 'Community list' }] } });
    expect(preview.page!.skipped).toEqual([]);
    // A page with no host passes over the site rules before the title rule decides.
    const file = await previewList(flat, null, { page: { url: 'file:///home/paper.html', title: 'A paper' } }, lookup, NOW);
    expect(file.page).toMatchObject({ winner: { id: 'papers' }, skipped: [{ id: 'local-file', kind: 'rule' }], shadowed: [] });
  });

  it('says when nothing matches, and what a switched-off list would do', async () => {
    const record = list([one(rule('arxiv', [{ kind: 'siteIs', value: 'arxiv.org' }]))], { enabled: false });
    const none = await previewList(flattenList({ ...record, enabled: true }), 'listOff', { page: { url: 'https://example.org/', title: 'x' } }, lookup, NOW);
    expect(none).toMatchObject({ stopped: 'listOff', page: { outcome: 'none', winner: null, folder: null, shadowed: [], skipped: [] } });
    const kept = await previewList(flattenList(list([one(rule('keep', [{ kind: 'siteIs', value: 'arxiv.org' }], { kind: 'keepHere' }))])), null,
      { page: { url: 'https://arxiv.org/abs/1', title: '' } }, lookup, NOW);
    expect(kept.page).toMatchObject({ outcome: 'kept', reason: 'keepHere', winner: { id: 'keep' }, folder: null });
    const gone = await previewList(flattenList(list([one(rule('gone', [{ kind: 'siteIs', value: 'arxiv.org' }], { kind: 'file', folderNativeId: '99' }))])), null,
      { page: { url: 'https://arxiv.org/abs/1', title: '' } }, lookup, NOW);
    expect(gone.page).toMatchObject({ outcome: 'blocked', reason: 'bindingUnavailable', winner: { id: 'gone' } });
  });
});

describe('broad winners (RS-08.5)', () => {
  const broad = rule('all-io', [{ kind: 'siteEndsWith', value: 'io' }]);
  const later = [rule('user-site', [{ kind: 'siteIs', value: 'user.github.io' }], { kind: 'file', folderNativeId: '32' }),
    rule('docs', [{ kind: 'titleContains', value: 'docs' }], { kind: 'file', folderNativeId: '31' })];
  const sample = [{ url: 'https://user.github.io/', title: 'Home', nativeId: 'b1' }, { url: 'https://other.io/docs', title: 'The docs', nativeId: 'b2' },
    { url: 'https://example.org/docs', title: 'More docs', nativeId: 'b3' }];

  it('labels a Site or its subdomains on a public suffix, and only that', () => {
    const flat = flattenList(list([one(broad), one(rule('arxiv', [{ kind: 'siteEndsWith', value: 'arxiv.org' }])), one(rule('github', [{ kind: 'siteEndsWith', value: 'github.io' }]))]));
    expect(flat.items.map(broadItem)).toEqual([true, false, true]);
  });

  it('counts the different later entries it shadows across the sample and the page', async () => {
    const flat = flattenList(list([one(broad), ...later.map(one)]));
    const page = await previewList(flat, null, { page: { url: 'https://colp.io/', title: 'Home' }, sample }, lookup, NOW);
    expect(page.page).toMatchObject({ winner: { id: 'all-io' }, broad: true, broadShadows: 2, shadowed: [] });
    const across = await previewList(flat, null, { sample }, lookup, NOW);
    expect(across.sample).toEqual({ size: 3, broad: [expect.objectContaining({ id: 'all-io', shadows: 2 })], rows: [
      { nativeId: 'b1', title: 'Home', url: 'https://user.github.io/', outcome: 'placed', winnerId: 'all-io', winnerName: 'all-io', folder: 'Papers' },
      { nativeId: 'b2', title: 'The docs', url: 'https://other.io/docs', outcome: 'placed', winnerId: 'all-io', winnerName: 'all-io', folder: 'Papers' },
      { nativeId: 'b3', title: 'More docs', url: 'https://example.org/docs', outcome: 'placed', winnerId: 'docs', winnerName: 'docs', folder: 'Reading' }] });
  });
});

describe('after a change (RS-08.3)', () => {
  it('names the recent bookmarks whose folder or outcome is no longer the same', async () => {
    const arxiv = rule('arxiv', [{ kind: 'siteIs', value: 'arxiv.org' }]), papers = rule('papers', [{ kind: 'titleContains', value: 'paper' }], { kind: 'file', folderNativeId: '31' });
    const sample = [{ url: 'https://arxiv.org/abs/1', title: 'A paper', nativeId: 'b1' }, { url: 'https://arxiv.org/list', title: 'Listing', nativeId: 'b2' },
      { url: 'https://example.org/paper', title: 'Another paper', nativeId: 'b3' }];
    const before = (await previewList(flattenList(list([one(arxiv), one(papers)])), null, { sample }, lookup, NOW)).sample!.rows;
    const after = (await previewList(flattenList(list([one(papers), one(arxiv)])), null, { sample }, lookup, NOW)).sample!.rows;
    expect(movedInSample(before, after).map(({ row, was }) => [row.nativeId, was.folder, row.folder])).toEqual([['b1', 'Papers', 'Reading']]);
  });
});

describe('the command', () => {
  it('takes a link and a title, a bookmark, or the sample, and nothing else', () => {
    const preview = 'known.automation.browser.preview';
    expect(validBrowserRuleCommand({ kind: preview, url: 'https://arxiv.org/abs/1', title: '' })).toBe(true);
    expect(validBrowserRuleCommand({ kind: preview, nativeId: '57' })).toBe(true);
    expect(validBrowserRuleCommand({ kind: preview, sample: true })).toBe(true);
    expect(validBrowserRuleCommand({ kind: preview, url: 'https://arxiv.org/abs/1' })).toBe(false);
    expect(validBrowserRuleCommand({ kind: preview, url: '', title: '' })).toBe(false);
    expect(validBrowserRuleCommand({ kind: preview, nativeId: '../1' })).toBe(false);
    expect(validBrowserRuleCommand({ kind: preview, sample: false })).toBe(false);
    expect(validBrowserRuleCommand({ kind: preview, url: 'https://arxiv.org/', title: '', write: true })).toBe(false);
  });
});
