import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { automationDatabase } from '../src/automation/indexeddb-store.js';
import { collectionValue } from '../src/automation/rule-conditions.js';
import { flattenList } from '../src/automation/rule-list-flatten.js';
import { createRuleListStore, RULE_LIST_KEY, type LocalRule, type RuleListRecord } from '../src/automation/rule-list-store.js';
import { parseRuleset } from '../src/automation/ruleset-format.js';
import { adjusted, collectionLookup, goneSettings, recompileCollections, subscriptionItems, type SubscriptionSource } from '../src/automation/subscription-list.js';
import { createSubscriptionStore, NO_ADJUSTMENTS, subscriptionKeys, type SubscriptionRecord } from '../src/automation/subscription-store.js';
import { configEntries, parseRulesConfig } from '../src/automation/rules-config-format.js';
import { memoryStateArea, NOW } from './automation-fixture.js';

vi.mock('../src/sw/runtime.js', () => ({ hasBookmarkPermission: async () => true }));
vi.mock('../src/bookmark-folder-policy.js', () => ({ assertBookmarkFolderAllowed: async () => undefined }));
vi.mock('../src/bookmark-subscriptions/guards.js', () => ({ isSubscriptionExcluded: async () => false, exclusionIds: async () => new Set() }));
import { browserListViews, browserPreSaveDecision } from '../src/sw/automation-browser.js';
import { handleSubscriptionCommand } from '../src/sw/automation-subscriptions.js';

/** Doc 17 §6.1, §8, RS-04.4/5, RS-05, RS-10: what a subscription gives the list, what the Owner changes here, and what activation leaves alone. */
const doc = (version: string, over: { sites?: unknown[]; entries?: unknown[] } = {}) => JSON.stringify({ format: 'colp.ruleset/v1', id: 'community', name: 'Community',
  version, roles: [{ key: 'papers', description: 'Papers' }],
  sites: over.sites ?? [{ id: 'arxiv', name: 'arXiv', addresses: [{ host: 'arxiv.org', scope: 'domain', status: 'current' },
    { host: 'xxx.lanl.gov', scope: 'exact', status: 'revoked', until: '2009-01-01' }] }],
  entries: over.entries ?? [{ id: 'e-arxiv', name: 'arXiv', site: 'arxiv', role: 'papers' }, { id: 'e-data', site: 'arxiv' }] });
const parsed = (text: string) => { const result = parseRuleset(text); if (!result.ok) throw new Error('fixture'); return result; };
const URL_A = 'https://rules.example.org/community.json';

function stores() {
  const area = memoryStateArea(), commits: string[][] = [];
  const commit = area.commit;
  area.commit = async (writes, deletes = []) => { commits.push([...Object.keys(writes), ...deletes.map((key) => `-${key}`)].sort()); await commit(writes, deletes); };
  let next = 0;
  const list = createRuleListStore(area, { id: () => `r-${++next}`, now: () => NOW });
  return { area, commits, list, subscriptions: createSubscriptionStore(area, list, { id: () => `s-${++next}` }) };
}
async function ready(made = stores()) {
  const created = await made.subscriptions.create({ url: URL_A, origin: new URL(URL_A).origin, updatePolicy: 'review', refreshIntervalHours: 24, bindings: { papers: '30' } }, NOW);
  if (!created.ok) throw new Error('not created');
  return { ...made, id: created.record.id };
}
const source = async (made: Awaited<ReturnType<typeof ready>>) => (await made.subscriptions.source(made.id))!;
const lookupOf = (sources: SubscriptionSource[]) => (id: string) => { const found = sources.find((item) => item.record.id === id); return found ? subscriptionItems(found) : undefined; };
const collectionRule = (id: string, subscriptionId: string, siteId: string, versions: Record<string, string>, definition: LocalRule['definition']): LocalRule => ({
  id, enabled: true, name: id, combinator: 'all', conditions: [{ kind: 'siteCollection', value: collectionValue(subscriptionId, siteId) }],
  action: { kind: 'file', folderNativeId: '31' }, definition, compiledFrom: { contentVersions: versions }, createdAt: NOW, updatedAt: NOW });

describe('activation leaves the Owner’s settings alone (RS-04.4, RS-05.1)', () => {
  it('changes the version only: the list position, bindings, switched-off entries and exceptions stay byte for byte', async () => {
    const made = await ready();
    await made.list.saveSet({ name: 'Mine' }, NOW);
    await made.subscriptions.adjust(made.id, { kind: 'exception', scope: 'domain', value: 'www.example.co.uk' }, NOW);
    await made.subscriptions.adjust(made.id, { kind: 'entry', entryId: 'e-arxiv', enabled: false }, NOW);
    const local = () => JSON.stringify(made.area.values.get(subscriptionKeys(made.id).local));
    const place = async () => (await made.list.load()).entries.map((entry) => entry.kind);
    const [before, order] = [local(), await place()];
    expect(JSON.parse(before)).toMatchObject({ disabledEntryIds: ['e-arxiv'], exceptions: [{ scope: 'domain', value: 'example.co.uk' }], bindings: { papers: '30' } });
    for (const [version, at] of [['1', NOW + 1], ['2', NOW + 2]] as const) {
      await made.subscriptions.settle(made.id, { kind: 'fetched', text: doc(version), etag: null }, at);
      expect([local(), await place()]).toEqual([before, order]);
    }
    expect(await made.subscriptions.get(made.id)).toMatchObject({ currentVersion: '1', candidateVersion: '2' });
  });
});

describe('what a subscription gives a save', () => {
  it('its current version’s filing entries in order; adjustments follow entry ids across renames, not new ids (RS-05.2)', () => {
    const record = { id: 's-1', name: 'Community', state: 'ready' } as SubscriptionRecord;
    const local = { ...NO_ADJUSTMENTS, disabledEntryIds: ['e-1'], bindings: { papers: '30' } };
    const named = (entries: unknown[]) => subscriptionItems({ record, current: parsed(doc('1', { entries })), fetchedAt: NOW, local }).items.map((item) => item.name);
    expect(named([{ id: 'e-1', name: 'Old name', site: 'arxiv', role: 'papers' }, { id: 'e-2', name: 'Other', site: 'arxiv', role: 'papers' }])).toEqual(['Other']);
    expect(named([{ id: 'e-1', name: 'Renamed upstream', site: 'arxiv', role: 'papers' }])).toEqual([]);
    expect(named([{ id: 'e-9', name: 'Old name', site: 'arxiv', role: 'papers' }])).toEqual(['Old name']);
    // Not ready: nothing, and flatten says so.
    const waiting = { record: { ...record, state: 'notReady' } as SubscriptionRecord, current: null, fetchedAt: null, local };
    expect(flattenList({ version: 2, revision: 1, enabled: true, entries: [{ kind: 'subscription', subscriptionId: 's-1', enabled: true }] }, lookupOf([waiting])))
      .toMatchObject({ items: [], skippedSources: [{ subscriptionId: 's-1', reason: 'notReady' }] });
  });

  it('counts and clears settings for entries no longer upstream (R4, RS-05.5), and refuses a suffix many sites share as an exception', () => {
    const current = parsed(doc('1'));
    const local = { ...NO_ADJUSTMENTS, disabledEntryIds: ['e-arxiv', 'e-gone', 'e-older'] };
    expect(goneSettings(local, current)).toBe(2);
    expect(adjusted(local, { kind: 'clearGone' }, current, () => 'x', NOW)).toMatchObject({ disabledEntryIds: ['e-arxiv'] });
    expect(adjusted(NO_ADJUSTMENTS, { kind: 'exception', scope: 'domain', value: 'github.io' }, current, () => 'x', NOW)).toBe('invalid');
    expect(adjusted(NO_ADJUSTMENTS, { kind: 'exception', scope: 'host', value: 'not a host' }, current, () => 'x', NOW)).toBe('invalid');
    expect(adjusted(NO_ADJUSTMENTS, { kind: 'exception', scope: 'host', value: 'Docs.Example.org' }, current, () => 'x', NOW))
      .toMatchObject({ exceptions: [{ id: 'x', scope: 'host', value: 'docs.example.org' }] });
  });
});

describe('site collections (RS-10)', () => {
  const v1 = parsed(doc('1')), v2 = parsed(doc('2', { sites: [{ id: 'arxiv', name: 'arXiv', addresses: [{ host: 'arxiv.org', scope: 'domain', status: 'current' },
    { host: 'arxiv-mirror.example', scope: 'exact', status: 'current' }] }] })), gone = parsed(doc('3', { sites: [], entries: [] }));
  const definitionFrom = (content: typeof v1) => {
    const checked = recompileCollections([{ kind: 'rule', rule: collectionRule('c', 's-1', 'arxiv', {}, v1.compiled[0]!.definition) }], 's-1', content)[0]!;
    return checked.kind === 'rule' ? checked.rule.definition : null;
  };

  it('a new version recompiles the rules naming its sites, where they stand and as they were (RS-10.4)', () => {
    const rule = { ...collectionRule('c', 's-1', 'arxiv', { 's-1': '1' }, definitionFrom(v1)!), enabled: false };
    const entries: RuleListRecord['entries'] = [{ kind: 'rule', rule: collectionRule('plain', 's-x', 'none', {}, v1.compiled[0]!.definition) },
      { kind: 'set', set: { id: 'set', name: 'Set', enabled: true, createdAt: NOW, updatedAt: NOW, origin: { kind: 'custom' }, roles: [], bindings: {}, rules: [rule] } }];
    const after = recompileCollections(entries, 's-1', v2);
    const moved = after[1]!.kind === 'set' ? after[1]!.set.rules[0]! : null;
    expect(after[0]).toEqual(entries[0]);
    expect(moved).toMatchObject({ id: 'c', enabled: false, action: { kind: 'file', folderNativeId: '31' }, conditions: rule.conditions,
      compiledFrom: { contentVersions: { 's-1': '2' } } });
    expect(JSON.stringify(moved!.definition.match)).toContain('arxiv-mirror.example');
    // A site gone upstream leaves the rule as it was, compiled from version 2 — so with version 3 current it needs attention.
    const left = recompileCollections(after, 's-1', gone);
    expect(left[1]).toEqual(after[1]);
    const record = { id: 's-1', name: 'Community', state: 'ready' } as SubscriptionRecord;
    const list: RuleListRecord = { version: 2, revision: 1, enabled: true, entries: left };
    const at = (current: typeof v1 | null) => flattenList({ ...list, entries: left.map((entry) => entry.kind === 'set'
      ? { kind: 'set', set: { ...entry.set, rules: entry.set.rules.map((item) => ({ ...item, enabled: true })) } } : entry) },
    lookupOf(current ? [{ record, current, fetchedAt: NOW, local: NO_ADJUSTMENTS }] : []));
    expect(at(gone).needsAttention).toEqual(['plain', 'c']);
    expect(at(v2)).toMatchObject({ needsAttention: ['plain'], items: [{ id: 'c' }] });
    // Removed: every rule naming its sites needs attention (§8 Remove).
    expect(at(null).needsAttention).toEqual(['plain', 'c']);
  });

  it('a rule from a configuration file waits for its subscription’s first version, which compiles it', async () => {
    const made = await ready();
    const file = { format: 'known-rules-config/v1', exportedAt: NOW, folders: [{ nativeId: '31', title: 'Reading', path: ['Reading'] }], list: { enabled: true, entries: [
      { kind: 'rule', rule: { id: 'c', enabled: true, name: 'arXiv papers', combinator: 'all', conditions: [{ kind: 'siteCollection', value: collectionValue(made.id, 'arxiv') }],
        action: { kind: 'file', folderNativeId: '31' } } }] } };
    const entries = configEntries(parseRulesConfig(file), { 31: '41' }, () => 'c-1', NOW);
    if ('error' in entries) throw new Error(entries.error);
    await made.list.importEntries(entries.entries, false);
    const flat = async () => flattenList(await made.list.load(), lookupOf([await source(made)]));
    expect(await flat()).toMatchObject({ items: [], needsAttention: ['c-1'] });
    await made.subscriptions.settle(made.id, { kind: 'fetched', text: doc('1'), etag: null }, NOW + 1);
    expect((await flat()).items.map((item) => item.id)).toEqual([`${made.id}:e-arxiv`, 'c-1']);
    const stored = (await made.list.load()).entries[1]!;
    expect(stored.kind === 'rule' && stored.rule.compiledFrom).toEqual({ contentVersions: { [made.id]: '1' } });
  });

  it('a rule names sites of one subscription only, and saves only while that site is there', async () => {
    const made = await ready();
    await made.subscriptions.settle(made.id, { kind: 'fetched', text: doc('1'), etag: null }, NOW + 1);
    const sites = collectionLookup(new Map([[made.id, await source(made)]]));
    const save = (values: string[]) => made.list.saveRule({ draft: { name: '', combinator: 'any', action: { kind: 'file', folderNativeId: '31' },
      conditions: values.map((value) => ({ kind: 'siteCollection' as const, value })) } }, NOW, sites);
    expect(await save([collectionValue(made.id, 'arxiv')])).toMatchObject({ ok: true, rule: { name: 'arXiv', compiledFrom: { contentVersions: { [made.id]: '1' } } } });
    expect(await save([collectionValue(made.id, 'nowhere')])).toMatchObject({ ok: false, problems: [{ field: 'condition', index: 0, code: 'collection' }] });
    expect(await save([collectionValue(made.id, 'arxiv'), collectionValue('other', 'arxiv')])).toMatchObject({ ok: false,
      problems: [{ field: 'condition', index: 1, code: 'oneCollection' }] });
  });

  it('reads a collection inside the write lane, so a version activated meanwhile cannot leave the rule compiled from the one before', async () => {
    const made = await ready();
    await made.subscriptions.settle(made.id, { kind: 'fetched', text: doc('1'), etag: null }, NOW + 1);
    const draft = { name: '', combinator: 'any' as const, action: { kind: 'file' as const, folderNativeId: '31' },
      conditions: [{ kind: 'siteCollection' as const, value: collectionValue(made.id, 'arxiv') }] };
    // A lookup taken before the activation says version 1; read in the lane, the list's own subscriptions say version 2.
    const before = collectionLookup(new Map([[made.id, await source(made)]]));
    const inLane = { read: async (list: RuleListRecord) => collectionLookup(new Map((await Promise.all(list.entries.flatMap((entry) =>
      entry.kind === 'subscription' ? [made.subscriptions.source(entry.subscriptionId)] : []))).flatMap((found) => found ? [[found.record.id, found] as const] : []))) };
    await made.subscriptions.settle(made.id, { kind: 'fetched', text: doc('2'), etag: null }, NOW + 2);
    await made.subscriptions.apply(made.id);
    expect(await made.list.saveRule({ draft }, NOW + 3, before)).toMatchObject({ ok: true, rule: { compiledFrom: { contentVersions: { [made.id]: '1' } } } });
    expect(await made.list.saveRule({ draft }, NOW + 3, inLane)).toMatchObject({ ok: true, rule: { compiledFrom: { contentVersions: { [made.id]: '2' } } } });
  });
});

describe('Copy to my rules from a subscription (RS-05.4)', () => {
  it('puts the entry above the subscription as a rule of the Owner’s and switches it off there, in one write', async () => {
    const made = await ready();
    await made.list.saveRule({ draft: { name: 'First', combinator: 'all', conditions: [{ kind: 'siteIs', value: 'example.org' }], action: { kind: 'keepHere' } } }, NOW);
    await made.subscriptions.settle(made.id, { kind: 'fetched', text: doc('1'), etag: null }, NOW + 1);
    made.commits.length = 0;
    const copied = await made.subscriptions.copyEntry(made.id, 'e-arxiv', true, NOW + 2);
    expect(copied).toMatchObject({ ok: true, rule: { name: 'arXiv', action: { kind: 'file', folderNativeId: '30' }, conditions: [{ kind: 'siteEndsWith', value: 'arxiv.org' }],
      origin: { kind: 'copiedFrom', subscriptionId: made.id, entryId: 'e-arxiv', contentVersion: '1' } } });
    expect(made.commits).toEqual([[RULE_LIST_KEY, subscriptionKeys(made.id).local].sort()]);
    const list = await made.list.load();
    expect(list.entries.map((entry) => entry.kind === 'rule' ? entry.rule.name : entry.kind)).toEqual(['arXiv', 'subscription', 'First']);
    expect((await made.subscriptions.adjustments(made.id)).disabledEntryIds).toEqual(['e-arxiv']);
    await made.subscriptions.adjust(made.id, { kind: 'bindings', bindings: { papers: null } }, NOW);
    expect(await made.subscriptions.copyEntry(made.id, 'e-arxiv', false, NOW)).toEqual({ ok: false, error: 'unbound' });
    expect(await made.subscriptions.copyEntry(made.id, 'e-data', false, NOW)).toEqual({ ok: false, error: 'notFound' });
  });
});

describe('in the worker', () => {
  const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(doc('1')));
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
    vi.stubGlobal('indexedDB', new IDBFactory());
    fetchSpy.mockClear();
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('chrome', { storage: { local: { get: async () => ({}), set: async () => undefined } },
      permissions: { contains: async () => true },
      bookmarks: { get: async (id: string) => [{ id, title: id === '30' ? 'Papers' : 'Reading', parentId: '1' }], getRecent: async () => [] } });
  });
  afterEach(() => { automationDatabase().close(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('files a save by a subscription’s entry from stored content only, and never fetches for it (RS-04.5)', async () => {
    const made = await handleSubscriptionCommand({ kind: 'known.automation.browser.subscribe', url: URL_A, bindings: { papers: '30' }, updatePolicy: 'review',
      refreshIntervalHours: 24 });
    expect(made).toMatchObject({ ok: true, subscription: { state: 'ready', currentVersion: '1' } });
    fetchSpy.mockClear();
    const decision = await browserPreSaveDecision({ url: 'https://arxiv.org/abs/1', title: 'A paper', parentNativeId: '1', explicit: false });
    expect(decision).toMatchObject({ targetNativeId: '30', automation: { outcome: 'placed', sourceName: 'Community',
      entry: { kind: 'subscriptionEntry', entryId: 'e-arxiv', contentVersion: '1' } } });
    expect(fetchSpy).not.toHaveBeenCalled();
    const { list } = await browserListViews();
    expect(list.entries[0]).toMatchObject({ kind: 'subscription', subscription: { name: 'Community', state: 'ready', currentVersion: '1' }, detail: {
      entries: [{ id: 'e-arxiv', name: 'arXiv', enabled: true, role: 'Papers', folder: { nativeId: '30', title: 'Papers' }, needsFolder: false,
        match: { conditions: [{ kind: 'siteCollection', value: 'arXiv' }] } }, { id: 'e-data', role: null }],
      roles: [{ key: 'papers', folder: { nativeId: '30' } }], sites: [{ id: 'arxiv', addresses: [{ status: 'current' }, { host: 'xxx.lanl.gov', status: 'revoked' }] }] } });
  });
});
