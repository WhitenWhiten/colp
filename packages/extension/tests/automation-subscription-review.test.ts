import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { automationDatabase } from '../src/automation/indexeddb-store.js';
import { collectionValue } from '../src/automation/rule-conditions.js';
import { createRuleListStore, RULE_LIST_KEY } from '../src/automation/rule-list-store.js';
import { entryDiff, parseRuleset, withinScope } from '../src/automation/ruleset-format.js';
import { collectionLookup, subscriptionRecordView } from '../src/automation/subscription-list.js';
import { createSubscriptionStore, subscriptionKeys } from '../src/automation/subscription-store.js';
import { memoryStateArea, NOW } from './automation-fixture.js';

vi.mock('../src/sw/runtime.js', () => ({ hasBookmarkPermission: async () => true }));
vi.mock('../src/bookmark-folder-policy.js', () => ({ assertBookmarkFolderAllowed: async () => undefined }));
vi.mock('../src/bookmark-subscriptions/guards.js', () => ({ isSubscriptionExcluded: async () => false, exclusionIds: async () => new Set() }));
import { browserPreSaveDecision, browserRuleStore, browserSubscriptionStore, listSources } from '../src/sw/automation-browser.js';
import { handleSubscriptionCommand } from '../src/sw/automation-subscriptions.js';

/** Doc 17 §8 Policy and Rollback, R10, RS-12, RS-13: what waits, what applies by itself, pinning, going back, and one version per save. */
type Over = { roles?: unknown[]; sites?: unknown[]; entries?: unknown[]; id?: string };
const doc = (version: string, over: Over = {}) => JSON.stringify({ format: 'colp.ruleset/v1', id: over.id ?? 'community', name: 'Community', version,
  roles: over.roles ?? [{ key: 'papers', description: 'Papers' }],
  sites: over.sites ?? [{ id: 'arxiv', name: 'arXiv', addresses: [{ host: 'arxiv.org', scope: 'domain', status: 'current' }] }],
  entries: over.entries ?? [{ id: 'e-arxiv', name: 'arXiv', site: 'arxiv', role: 'papers' }] });
const mirror = [{ id: 'arxiv', name: 'arXiv', addresses: [{ host: 'arxiv.org', scope: 'domain', status: 'current' }, { host: 'export-arxiv.example', scope: 'exact', status: 'current' }] }];
const URL_A = 'https://rules.example.org/community.json';
const parsed = (text: string) => { const result = parseRuleset(text); if (!result.ok) throw new Error('fixture'); return result.ruleset; };

async function subscribed(policy: 'review' | 'auto') {
  const area = memoryStateArea(), commits: string[][] = [];
  const commit = area.commit;
  area.commit = async (writes, deletes = []) => { commits.push([...Object.keys(writes), ...deletes.map((key) => `-${key}`)].sort()); await commit(writes, deletes); };
  let next = 0;
  const list = createRuleListStore(area, { id: () => `r-${++next}`, now: () => NOW });
  const store = createSubscriptionStore(area, list, { id: () => `s-${++next}` });
  const made = await store.create({ url: URL_A, origin: new URL(URL_A).origin, updatePolicy: policy, refreshIntervalHours: 24, bindings: { papers: '30' } }, NOW);
  if (!made.ok) throw new Error('not made');
  const id = made.record.id;
  await store.settle(id, { kind: 'fetched', text: doc('1'), etag: null }, NOW + 1);
  return { area, commits, list, store, id, fetched: (text: string, at = NOW + 2) => store.settle(id, { kind: 'fetched', text, etag: null }, at) };
}

describe('the scope Automatic may apply (R10)', () => {
  it('the same rule set with the same folder roles; entries, conditions and sites may change', () => {
    expect(withinScope(parsed(doc('1')), parsed(doc('2', { sites: mirror })))).toEqual({ ok: true, reasons: [] });
    expect(withinScope(parsed(doc('1')), parsed(doc('2', { roles: [{ key: 'papers', description: 'Papers' }, { key: 'code', description: 'Code' }] }))))
      .toEqual({ ok: false, reasons: ['roles'] });
    expect(withinScope(parsed(doc('1')), parsed(doc('2', { id: 'another' })))).toEqual({ ok: false, reasons: ['document'] });
  });

  it('diffs entries by id: added, removed, and changed by conditions or by their site’s addresses', () => {
    const before = parsed(doc('1', { entries: [{ id: 'e-arxiv', site: 'arxiv', role: 'papers' }, { id: 'e-old', name: 'Old', site: 'arxiv' }] }));
    const after = parsed(doc('2', { sites: mirror, roles: [{ key: 'papers', description: 'Papers' }, { key: 'code', description: 'Code' }],
      entries: [{ id: 'e-arxiv', site: 'arxiv', role: 'papers' }, { id: 'e-gh', name: 'GitHub', match: { kind: 'field', field: 'bookmark.url.host', op: 'eq', value: 'github.com' }, role: 'code' }] }));
    expect(entryDiff(before, after)).toEqual({ added: [{ id: 'e-gh', name: 'GitHub' }], removed: [{ id: 'e-old', name: 'Old' }], changed: [{ id: 'e-arxiv', name: 'arXiv' }],
      roles: { added: [{ key: 'code', description: 'Code' }], removed: [] } });
  });
});

describe('a new version', () => {
  it('under Automatic, one that changes only conditions and sites applies in one write, the one before kept as previous', async () => {
    const made = await subscribed('auto');
    made.commits.length = 0;
    expect(await made.fetched(doc('2', { sites: mirror }))).toMatchObject({ currentVersion: '2', previousVersion: '1', candidateVersion: null });
    const keys = subscriptionKeys(made.id);
    expect(made.commits).toEqual([[RULE_LIST_KEY, keys.record, keys.content('current'), keys.content('previous'), `-${keys.content('candidate')}`].sort()]);
  });

  it('with a new folder role waits for review under both policies, and the row says why (RS-12.3)', async () => {
    for (const policy of ['auto', 'review'] as const) {
      const made = await subscribed(policy);
      await made.fetched(doc('2', { roles: [{ key: 'papers', description: 'Papers' }, { key: 'code', description: 'Code' }] }));
      const source = (await made.store.source(made.id))!;
      expect(subscriptionRecordView(source)).toMatchObject({ currentVersion: '1', candidateVersion: '2', candidateWaits: policy === 'auto' ? 'roles' : 'review' });
    }
  });

  it('waits while pinned under Automatic, and unpinning applies it when the scope allows', async () => {
    const made = await subscribed('auto');
    await made.store.update(made.id, { pinned: true });
    await made.fetched(doc('2', { sites: mirror }));
    expect(subscriptionRecordView((await made.store.source(made.id))!)).toMatchObject({ currentVersion: '1', candidateVersion: '2', candidateWaits: 'pinned' });
    expect(await made.store.update(made.id, { pinned: false })).toMatchObject({ currentVersion: '2', previousVersion: '1', candidateVersion: null, pinned: false });
  });

  it('Apply makes the waiting version current and recompiles the rules naming its sites, in one write', async () => {
    const made = await subscribed('review');
    const sites = collectionLookup(await listSources(await made.list.load(), made.store));
    await made.list.saveRule({ draft: { name: 'Mirror', combinator: 'all', conditions: [{ kind: 'siteCollection', value: collectionValue(made.id, 'arxiv') }],
      action: { kind: 'keepHere' } } }, NOW, sites);
    await made.fetched(doc('2', { sites: mirror }));
    made.commits.length = 0;
    expect(await made.store.apply(made.id)).toMatchObject({ currentVersion: '2', previousVersion: '1', candidateVersion: null });
    expect(made.commits).toHaveLength(1);
    const rule = (await made.list.load()).entries.find((entry) => entry.kind === 'rule')!;
    expect(rule.kind === 'rule' && [rule.rule.compiledFrom.contentVersions[made.id], JSON.stringify(rule.rule.definition.match).includes('export-arxiv.example')])
      .toEqual(['2', true]);
    expect(await made.store.apply(made.id)).toBeNull();
  });
});

describe('Use previous version (RS-13.3)', () => {
  it('swaps current and previous and pins there; adjustments, the list position and a waiting version stay', async () => {
    const made = await subscribed('review');
    await made.store.adjust(made.id, { kind: 'exception', scope: 'host', value: 'docs.example.org' }, NOW);
    await made.store.adjust(made.id, { kind: 'entry', entryId: 'e-arxiv', enabled: false }, NOW);
    await made.fetched(doc('2', { sites: mirror }));
    await made.store.apply(made.id);
    await made.fetched(doc('3'), NOW + 3);
    const local = () => JSON.stringify(made.area.values.get(subscriptionKeys(made.id).local));
    const before = local();
    expect(await made.store.rollback(made.id)).toMatchObject({ currentVersion: '1', previousVersion: '2', candidateVersion: '3', pinned: true });
    expect(local()).toBe(before);
    expect((await made.list.load()).entries.map((entry) => entry.kind)).toEqual(['subscription']);
    // Again: back to version 2, still pinned.
    expect(await made.store.rollback(made.id)).toMatchObject({ currentVersion: '2', previousVersion: '1', pinned: true });
  });
});

describe('one version per save (RS-12.4)', () => {
  const served = { text: doc('1') };
  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('fetch', vi.fn(async () => new Response(served.text)));
    vi.stubGlobal('chrome', { storage: { local: { get: async () => ({}), set: async () => undefined } }, permissions: { contains: async () => true },
      bookmarks: { get: async (id: string) => [{ id, title: id === '30' ? 'Papers' : 'Folder', parentId: '1' }], getRecent: async () => [
        { id: 'b1', url: 'https://export-arxiv.example/abs/1', title: 'Mirrored' }, { id: 'b2', url: 'https://arxiv.org/abs/2', title: 'Paper' }] } });
  });
  afterEach(() => { automationDatabase().close(); vi.unstubAllGlobals(); });

  it('a decision taken while a version is applied reads the old one whole or the new one whole', async () => {
    served.text = doc('1');
    const reply = await handleSubscriptionCommand({ kind: 'known.automation.browser.subscribe', url: URL_A, bindings: { papers: '30' }, updatePolicy: 'review', refreshIntervalHours: 24 });
    if (!reply.ok || !('subscription' in reply)) throw new Error('not subscribed');
    const id = reply.subscription.id;
    // Above it, a rule of the Owner's that keeps pages from the collection's arXiv where they are saved.
    const sites = collectionLookup(await listSources(await browserRuleStore().load(), browserSubscriptionStore()));
    await browserRuleStore().saveRule({ draft: { name: 'Keep arXiv', combinator: 'all', conditions: [{ kind: 'siteCollection', value: collectionValue(id, 'arxiv') }],
      action: { kind: 'keepHere' } }, index: 0 }, NOW, sites);
    served.text = doc('2', { sites: mirror });
    expect(await handleSubscriptionCommand({ kind: 'known.automation.browser.subscription.refresh', id })).toMatchObject({ subscription: { candidateVersion: '2' } });
    const review = await handleSubscriptionCommand({ kind: 'known.automation.browser.subscription.review', id });
    expect(review).toMatchObject({ ok: true, review: { currentVersion: '1', candidateVersion: '2', scope: { ok: true }, diff: { changed: [{ id: 'e-arxiv' }] },
      sample: { size: 2, changed: 1, byFolder: [{ title: '', count: 1 }] } } });
    // The mirror: version 1 knows no such address (nothing decides); version 2 does, and the rule above, compiled from it, keeps the page.
    // A mixture — the list compiled from 1 with the content of 2 — would let the subscription's entry file it instead.
    const page = { url: 'https://export-arxiv.example/abs/1', title: 'Mirrored', parentNativeId: '1', explicit: false };
    // Decisions start one after another while the activation runs, so some read during its write.
    const applying = handleSubscriptionCommand({ kind: 'known.automation.browser.subscription.apply', id }), started: Promise<unknown>[] = [];
    for (let step = 0; step < 40; step += 1) { started.push(browserPreSaveDecision(page)); await new Promise((resolve) => setTimeout(resolve, 0)); }
    await applying;
    const decisions = await Promise.all(started);
    const version = (decision: Awaited<ReturnType<typeof browserPreSaveDecision>> | unknown) => decision === null ? 'v1'
      : decision && typeof decision === 'object' && 'automation' in decision && (decision as { automation: { outcome: string; rule: { name: string } } }).automation.outcome === 'kept'
        && (decision as { automation: { rule: { name: string } } }).automation.rule.name === 'Keep arXiv' ? 'v2' : 'mixed';
    const versions = decisions.map(version);
    expect(versions).not.toContain('mixed');
    expect(versions).toContain('v1');
    expect(version(await browserPreSaveDecision(page))).toBe('v2');
  });
});
