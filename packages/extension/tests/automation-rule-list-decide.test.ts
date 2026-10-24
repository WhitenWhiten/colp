import { describe, expect, it } from 'vitest';
import type { FolderLookup } from '../src/automation/browser-rules.js';
import { checkRuleDraft, type RuleAction, type RuleCondition } from '../src/automation/rule-conditions.js';
import { decideList } from '../src/automation/rule-list-decide.js';
import { flattenList, type FlatItem } from '../src/automation/rule-list-flatten.js';
import type { ListEntry, LocalRule, LocalSet, RuleListRecord } from '../src/automation/rule-list-store.js';
import { parseRuleset } from '../src/automation/ruleset-format.js';
import { subscriptionItems } from '../src/automation/subscription-list.js';
import type { SubscriptionRecord } from '../src/automation/subscription-store.js';
import { NOW } from './automation-fixture.js';

/** Doc 17 RS-06, RS-08.2, R8: the ordered list decides top to bottom, and the first match is the only one that counts. */
const folders: Record<string, { id: string; title: string; url?: string }> = {
  30: { id: '30', title: 'Papers' }, 31: { id: '31', title: 'Reading' }, 32: { id: '32', title: 'Code' }, 50: { id: '50', title: 'A bookmark', url: 'https://example.org/' } };
const lookup: FolderLookup = async (id) => folders[id] ?? null;
const page = (url: string, title = 'A paper', explicit = false) => ({ url, title, explicit });

function rule(id: string, conditions: RuleCondition[], action: RuleAction = { kind: 'file', folderNativeId: '30' }, enabled = true): LocalRule {
  const checked = checkRuleDraft({ name: id, combinator: 'all', conditions, action });
  if (!checked.ok) throw new Error('invalid draft');
  return { id, enabled, name: checked.name, combinator: 'all', conditions: checked.conditions, action, definition: checked.definition,
    compiledFrom: { contentVersions: {} }, createdAt: NOW, updatedAt: NOW };
}
const arxiv = (id = 'arxiv', folder = '30') => rule(id, [{ kind: 'siteIs', value: 'arxiv.org' }], { kind: 'file', folderNativeId: folder });
const titled = (id: string, word: string, folder = '31') => rule(id, [{ kind: 'titleContains', value: word }], { kind: 'file', folderNativeId: folder });

function set(id: string, rules: LocalRule[], over: Partial<LocalSet> = {}): ListEntry {
  return { kind: 'set', set: { id, name: `Set ${id}`, enabled: true, createdAt: NOW, updatedAt: NOW, origin: { kind: 'custom' }, roles: [], bindings: {}, rules, ...over } };
}
const list = (entries: ListEntry[], over: Partial<RuleListRecord> = {}): RuleListRecord => ({ version: 3, revision: 7, enabled: true, entries, ...over });
const individual = (...rules: LocalRule[]): ListEntry[] => rules.map((item) => ({ kind: 'rule', rule: item }));
const decide = (record: RuleListRecord, at: ReturnType<typeof page>, preview = false) =>
  decideList(flattenList(record).items, at, lookup, NOW, { preview });

describe('first match', () => {
  it('files a page by the upper of two rules that want different folders', async () => {
    const result = await decide(list(individual(arxiv(), titled('paper', 'paper'))), page('https://arxiv.org/abs/1'));
    expect(result.decision).toMatchObject({ outcome: 'placed', item: { id: 'arxiv', ref: { kind: 'rule', ruleId: 'arxiv' } },
      folder: { nativeId: '30', title: 'Papers' } });
    const swapped = await decide(list(individual(titled('paper', 'paper'), arxiv())), page('https://arxiv.org/abs/1'));
    expect(swapped.decision).toMatchObject({ outcome: 'placed', item: { id: 'paper' }, folder: { nativeId: '31' } });
    expect((await decide(list(individual(arxiv())), page('https://example.org/'))).decision).toBeNull();
  });

  it('skips what is switched off: a rule, a set, the whole list', async () => {
    const off = rule('off', [{ kind: 'siteIs', value: 'arxiv.org' }], { kind: 'file', folderNativeId: '32' }, false);
    expect((await decide(list([...individual(off, arxiv())]), page('https://arxiv.org/abs/1'))).decision).toMatchObject({ item: { id: 'arxiv' } });
    expect((await decide(list([set('s-1', [arxiv('in-set', '32')], { enabled: false }), ...individual(arxiv())]), page('https://arxiv.org/abs/1')))
      .decision).toMatchObject({ item: { id: 'arxiv' } });
    const stopped = flattenList(list(individual(arxiv()), { enabled: false }));
    expect(stopped).toMatchObject({ stopped: 'listOff', items: [] });
    expect(flattenList(list(individual(arxiv())), undefined, { accountPaused: true })).toMatchObject({ stopped: 'accountPaused', items: [] });
  });

  it('stops at a matching rule whose folder is unusable, and never asks the rules below (RS-06.3)', async () => {
    for (const folder of ['99', '50']) {
      const result = await decide(list(individual(arxiv('broken', folder), arxiv('good'))), page('https://arxiv.org/abs/1'));
      expect(result.decision).toEqual(expect.objectContaining({ outcome: 'blocked', reason: 'bindingUnavailable', folder: null }));
      expect(result.decision?.item.id).toBe('broken');
    }
  });

  it('keeps the page where it was saved when the matching rule says so', async () => {
    const keep = rule('keep', [{ kind: 'pathUnder', value: '/list' }], { kind: 'keepHere' });
    const result = await decide(list(individual(keep, arxiv())), page('https://arxiv.org/list/cs'));
    expect(result.decision).toMatchObject({ outcome: 'kept', reason: 'keepHere', item: { id: 'keep' }, folder: null });
    expect((await decide(list(individual(keep, arxiv())), page('https://arxiv.org/abs/1'))).decision).toMatchObject({ outcome: 'placed' });
  });

  it('leaves a folder the Owner picked where it is, naming the rule that would have moved it', async () => {
    const result = await decide(list(individual(titled('reading', 'nothing'), arxiv('broken', '99'))), page('https://arxiv.org/abs/1', 'A paper', true));
    expect(result.decision).toMatchObject({ outcome: 'kept', item: { id: 'broken' }, folder: null });
    expect(result.decision).not.toHaveProperty('reason');
    expect((await decide(list(individual(arxiv())), page('https://example.org/', 'x', true))).decision).toBeNull();
  });

  it('passes over a rule the page has nothing for, and says so (R8)', async () => {
    const site = rule('site', [{ kind: 'siteIs', value: 'example.org' }]);
    const notes = titled('notes', 'Notes');
    const result = await decide(list(individual(site, notes)), page('file:///home/notes.html', 'Notes'));
    expect(result).toMatchObject({ decision: { outcome: 'placed', item: { id: 'notes' } }, skipped: [{ id: 'site' }] });
  });

  it('files a set’s rule where the set binds its role, and blocks it while the role has no folder', async () => {
    const byRole = rule('role', [{ kind: 'siteEndsWith', value: 'github.com' }], { kind: 'file', role: 'code' });
    const imported = (bindings: Record<string, string>) => set('s-1', [byRole], { roles: [{ key: 'code', description: 'Code' }], bindings });
    expect((await decide(list([imported({ code: '32' })]), page('https://github.com/know-n/colp'))).decision).toMatchObject({ outcome: 'placed',
      item: { ref: { kind: 'setRule', ruleId: 'role', setId: 's-1' }, source: { id: 's-1', name: 'Set s-1' } }, folder: { nativeId: '32' } });
    expect((await decide(list([imported({}), ...individual(rule('later', [{ kind: 'siteEndsWith', value: 'github.com' }]))]),
      page('https://github.com/know-n/colp'))).decision).toMatchObject({ outcome: 'blocked', reason: 'bindingUnavailable', item: { id: 'role' } });
  });

  it('a rule placed above a set wins for the pages it matches (RS-03.3)', async () => {
    const exception = rule('mine', [{ kind: 'siteIs', value: 'arxiv.org' }], { kind: 'file', folderNativeId: '31' });
    const record = list([...individual(exception), set('s-1', [arxiv('in-set', '30')])]);
    expect((await decide(record, page('https://arxiv.org/abs/1'))).decision).toMatchObject({ item: { id: 'mine' }, folder: { nativeId: '31' } });
  });

  it('decides in the order it lists: a shuffled list evaluates as it reads (RS-01.3)', async () => {
    const rules = [arxiv('a', '30'), titled('b', 'paper', '31'), rule('c', [{ kind: 'pathUnder', value: '/abs' }], { kind: 'file', folderNativeId: '32' })];
    for (const order of [[0, 1, 2], [2, 0, 1], [1, 2, 0]]) {
      const record = list(individual(...order.map((index) => rules[index]!)));
      const flat = flattenList(record).items.map((item) => item.id);
      expect(flat).toEqual(order.map((index) => rules[index]!.id));
      const result = await decide(record, page('https://arxiv.org/abs/1', 'A paper'), true);
      expect([result.decision!.item.id, ...result.shadowed.map((item) => item.id)]).toEqual(flat);
    }
  });

  it('contributes nothing from a subscription with no version yet, and says which', () => {
    const flat = flattenList(list([{ kind: 'subscription', subscriptionId: 'sub-1', enabled: true }, { kind: 'subscription', subscriptionId: 'sub-2', enabled: false }]));
    expect(flat).toMatchObject({ items: [], skippedSources: [{ subscriptionId: 'sub-1', reason: 'notReady' }] });
  });

  it('applies a subscription’s exceptions to its own entries only (RS-05.3)', async () => {
    const entry = (id: string, folder: string): FlatItem => ({ ref: { kind: 'subscriptionEntry', subscriptionId: 'sub-1', entryId: id, contentVersion: '1' },
      id, name: id, source: { id: 'sub-1', name: 'Community' }, definition: arxiv().definition, action: { kind: 'file', folderNativeId: folder },
      exceptions: [{ scope: 'domain', value: 'arxiv.org' }] });
    const record = list([{ kind: 'subscription', subscriptionId: 'sub-1', enabled: true }, ...individual(arxiv('mine', '31'))]);
    const flat = flattenList(record, () => ({ name: 'Community', ready: true, contentVersion: '1', items: [entry('e-1', '30')] }));
    expect(flat.contentVersions).toEqual({ 'sub-1': '1' });
    const result = await decideList(flat.items, page('https://arxiv.org/abs/1'), lookup, NOW);
    expect(result.decision).toMatchObject({ item: { id: 'mine' }, folder: { nativeId: '31' } });
  });

  it('expands a subscription’s current version in its order, files by its bindings, and leaves its exceptions to the entries below (RS-05.3)', async () => {
    const parsed = parseRuleset(JSON.stringify({ format: 'colp.ruleset/v1', id: 'community', name: 'Community', version: '3',
      roles: [{ key: 'papers', description: 'Papers' }, { key: 'code', description: 'Code' }],
      sites: [{ id: 'arxiv', name: 'arXiv', addresses: [{ host: 'arxiv.org', scope: 'domain', status: 'current' }] }],
      entries: [{ id: 'e-off', site: 'arxiv', role: 'code' }, { id: 'e-arxiv', site: 'arxiv', role: 'papers' }, { id: 'e-data', site: 'arxiv' },
        { id: 'e-gh', match: { kind: 'field', field: 'bookmark.url.host', op: 'eq', value: 'github.com' }, role: 'code' }] }));
    if (!parsed.ok) throw new Error('fixture');
    const record = { id: 'sub-a', name: 'Community', state: 'ready' } as SubscriptionRecord;
    const source = (exceptions: { scope: 'host' | 'domain'; value: string }[]) => subscriptionItems({ record, current: parsed, fetchedAt: NOW,
      local: { disabledEntryIds: ['e-off'], exceptions: exceptions.map((item, index) => ({ id: `x-${index}`, createdAt: NOW, ...item })), bindings: { papers: '30' } } });
    const plain = source([]);
    expect(plain.items.map((item) => [item.id, item.action])).toEqual([['sub-a:e-arxiv', { kind: 'file', folderNativeId: '30' }],
      ['sub-a:e-gh', { kind: 'file', folderNativeId: null }]]);
    expect(plain.items[0]!.ref).toEqual({ kind: 'subscriptionEntry', subscriptionId: 'sub-a', entryId: 'e-arxiv', contentVersion: '3' });
    const entries = list([{ kind: 'subscription', subscriptionId: 'sub-a', enabled: true }, ...individual(arxiv('mine', '31'))]);
    const decided = async (items: ReturnType<typeof source>, url: string) =>
      (await decideList(flattenList(entries, () => items).items, page(url), lookup, NOW)).decision;
    expect(await decided(plain, 'https://export.arxiv.org/abs/1')).toMatchObject({ outcome: 'placed', item: { id: 'sub-a:e-arxiv' }, folder: { nativeId: '30' } });
    // Its role for code has no folder here: a match stops there, blocked (R8).
    expect(await decided(plain, 'https://github.com/x')).toMatchObject({ outcome: 'blocked', reason: 'bindingUnavailable', item: { id: 'sub-a:e-gh' } });
    const excepted = source([{ scope: 'domain', value: 'arxiv.org' }]);
    expect(await decided(excepted, 'https://arxiv.org/abs/1')).toMatchObject({ item: { id: 'mine' }, folder: { nativeId: '31' } });
    expect(await decided(excepted, 'https://export.arxiv.org/abs/1')).toBeNull();
    expect(await decided(source([{ scope: 'host', value: 'arxiv.org' }]), 'https://export.arxiv.org/abs/1')).toMatchObject({ item: { id: 'sub-a:e-arxiv' } });
  });

  it(`decides a list of 5,000 entries in well under a save's time once warm`, async () => {
    const many = Array.from({ length: 5_000 }, (_, index) => rule(`r-${index}`, [{ kind: 'siteIs', value: `site-${index}.example` }]));
    const record = list([...individual(...many.slice(0, 200)), ...Array.from({ length: 24 }, (_, index) => set(`s-${index}`, many.slice(200 + index * 200, 400 + index * 200)))]);
    const last = page('https://site-4999.example/x');
    await decide(record, last);
    const started = performance.now();
    const result = await decide(record, last);
    expect(performance.now() - started).toBeLessThan(200);
    expect(result.decision).toMatchObject({ item: { id: 'r-4999' } });
  });
});
