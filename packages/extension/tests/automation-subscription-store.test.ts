import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRuleListStore, LIST_LIMITS, RULE_LIST_KEY, type RuleListRecord } from '../src/automation/rule-list-store.js';
import { createSubscriptionStore, parseSubscriptionRecord, REFRESH_PER_TICK, subscriptionKeys, type SubscribeInput,
  type SubscriptionRecord } from '../src/automation/subscription-store.js';
import { automationDatabase } from '../src/automation/indexeddb-store.js';
import { validBrowserRuleCommand } from '../src/automation/messages.js';
import { memoryStateArea, NOW } from './automation-fixture.js';

vi.mock('../src/sw/runtime.js', () => ({ hasBookmarkPermission: async () => true }));
import { handleSubscriptionCommand, installRuleSubscriptions, refreshDueSubscriptions, RULE_SUBSCRIPTION_ALARM,
  ruleSubscriptionStore } from '../src/sw/automation-subscriptions.js';

/** Doc 17 §4.2, §8, RS-04, RS-13: subscriptions kept here, the versions they fetch, and the hourly alarm that takes those due. */
const HOUR = 60 * 60 * 1000;
const doc = (version: string, over: Record<string, unknown> = {}) => JSON.stringify({ format: 'colp.ruleset/v1', id: 'community-tech',
  name: 'Community technology sites', version, publisher: { name: 'Example Collective', url: 'https://example.org', feedbackUrl: null }, license: 'CC-BY-4.0',
  roles: [{ key: 'papers', description: 'Academic papers' }],
  sites: [{ id: 'arxiv', name: 'arXiv', addresses: [{ host: 'arxiv.org', scope: 'domain', status: 'current' }] }],
  entries: [{ id: 'e-arxiv', name: 'arXiv', site: 'arxiv', role: 'papers' }], ...over });
const input = (url = 'https://rules.example.org/community.json'): SubscribeInput =>
  ({ url, origin: new URL(url).origin, updatePolicy: 'review', refreshIntervalHours: 24, bindings: { papers: '30' } });

function stores() {
  const area = memoryStateArea(), commits: string[][] = [];
  const commit = area.commit;
  area.commit = async (writes, deletes = []) => { commits.push([...Object.keys(writes), ...deletes.map((key) => `-${key}`)].sort()); await commit(writes, deletes); };
  let next = 0;
  const list = createRuleListStore(area, { id: () => `r-${++next}`, now: () => NOW });
  return { area, commits, list, subscriptions: createSubscriptionStore(area, list, { id: () => `s-${++next}` }) };
}
const listed = (list: RuleListRecord) => list.entries.map((entry) => entry.kind === 'subscription' ? `sub:${entry.subscriptionId}` : entry.kind);

describe('subscribing', () => {
  it('adds a record that is not ready, its folders, and its place at the end of the list, in one write', async () => {
    const { area, commits, list, subscriptions } = stores();
    const made = await subscriptions.create(input(), NOW);
    expect(made).toMatchObject({ ok: true, record: { id: 's-1', state: 'notReady', name: 'rules.example.org', currentVersion: null, paused: false, pinned: false,
      updatePolicy: 'review', refreshIntervalHours: 24, lastAttemptAt: null } });
    const keys = subscriptionKeys('s-1');
    expect(commits).toEqual([[RULE_LIST_KEY, keys.local, keys.record].sort()]);
    expect(listed(await list.load())).toEqual(['sub:s-1']);
    expect(area.values.get(keys.local)).toEqual({ disabledEntryIds: [], exceptions: [], bindings: { papers: '30' } });
    expect(await subscriptions.create(input(), NOW)).toEqual({ ok: false, error: 'duplicate' });
  });

  it('keeps up to 20, and says so past that', async () => {
    const { subscriptions } = stores();
    for (let n = 0; n < LIST_LIMITS.subscriptions; n += 1) expect((await subscriptions.create(input(`https://rules.example.org/${n}.json`), NOW)).ok).toBe(true);
    expect(await subscriptions.create(input('https://rules.example.org/one-more.json'), NOW)).toEqual({ ok: false, error: 'limit' });
  });

  it('reads back only records this build wrote', () => {
    const record: SubscriptionRecord = { id: 's-1', url: 'https://rules.example.org/a.json', origin: 'https://rules.example.org', documentId: null, name: 'a',
      publisher: null, updatePolicy: 'review', refreshIntervalHours: 24, paused: false, pinned: false, state: 'notReady', currentVersion: null, previousVersion: null,
      candidateVersion: null, lastAttemptAt: null, lastSuccessAt: null, etag: null, lastFailure: null, createdAt: NOW };
    expect(parseSubscriptionRecord(record)).toEqual(record);
    expect(parseSubscriptionRecord({ ...record, token: 'secret' })).toBeNull();
    expect(parseSubscriptionRecord({ ...record, refreshIntervalHours: 1 })).toBeNull();
    expect(parseSubscriptionRecord({ ...record, state: 'ready' })).toBeNull();
  });
});

describe('what a fetch leaves', () => {
  it('a failed first fetch keeps it not ready with the failure; the first file that checks becomes current with the list, in one write', async () => {
    const { commits, list, subscriptions } = stores();
    await subscriptions.create(input(), NOW);
    expect(await subscriptions.settle('s-1', { kind: 'failed', code: 'http', status: 503 }, NOW + 1)).toMatchObject({ state: 'notReady',
      lastAttemptAt: NOW + 1, lastSuccessAt: null, lastFailure: { code: 'http', status: 503, at: NOW + 1 } });
    const before = (await list.load()).revision;
    commits.length = 0;
    const ready = await subscriptions.settle('s-1', { kind: 'fetched', text: doc('1'), etag: '"1"' }, NOW + 2);
    expect(ready).toMatchObject({ state: 'ready', currentVersion: '1', candidateVersion: null, documentId: 'community-tech', name: 'Community technology sites',
      publisher: { name: 'Example Collective', url: 'https://example.org', feedbackUrl: null }, lastSuccessAt: NOW + 2, lastFailure: null, etag: '"1"' });
    const keys = subscriptionKeys('s-1');
    expect(commits).toEqual([[RULE_LIST_KEY, keys.content('current'), keys.record, `-${keys.content('previous')}`, `-${keys.content('candidate')}`].sort()]);
    expect((await list.load()).revision).toBe(before + 1);
    expect(await subscriptions.content('s-1', 'current')).toMatchObject({ version: '1', fetchedAt: NOW + 2, document: { id: 'community-tech', version: '1' } });
  });

  it('a later version waits as the candidate; a failure or a broken file leaves the current one in force (RS-13.1)', async () => {
    const { subscriptions } = stores();
    await subscriptions.create(input(), NOW);
    await subscriptions.settle('s-1', { kind: 'fetched', text: doc('1'), etag: '"1"' }, NOW + 1);
    const current = await subscriptions.content('s-1', 'current');
    expect(await subscriptions.settle('s-1', { kind: 'fetched', text: doc('2', { name: 'Renamed' }), etag: '"2"' }, NOW + 2))
      .toMatchObject({ currentVersion: '1', candidateVersion: '2', name: 'Community technology sites', etag: '"2"' });
    expect(await subscriptions.content('s-1', 'candidate')).toMatchObject({ version: '2' });
    for (const outcome of [{ kind: 'failed', code: 'network' }, { kind: 'fetched', text: '{"format":"colp.ruleset/v1"', etag: '"3"' },
      { kind: 'fetched', text: doc('9', { format: 'colp.ruleset/v2' }), etag: '"4"' }, { kind: 'fetched', text: doc('1', { license: 'MIT' }), etag: '"5"' }] as const) {
      await subscriptions.settle('s-1', outcome, NOW + 3);
      expect(await subscriptions.content('s-1', 'current')).toEqual(current);
    }
    expect(await subscriptions.get('s-1')).toMatchObject({ currentVersion: '1', candidateVersion: '2', etag: '"2"', lastSuccessAt: NOW + 2,
      lastFailure: { code: 'invalid', at: NOW + 3 } });
    // A later format is told apart from a broken file.
    expect(await subscriptions.settle('s-1', { kind: 'fetched', text: doc('9', { format: 'colp.ruleset/v2' }), etag: null }, NOW + 4))
      .toMatchObject({ lastFailure: { code: 'unsupported' } });
  });

  it('the same file again, or a 304, is a success that changes nothing else', async () => {
    const { subscriptions } = stores();
    await subscriptions.create(input(), NOW);
    await subscriptions.settle('s-1', { kind: 'fetched', text: doc('1'), etag: '"1"' }, NOW + 1);
    await subscriptions.settle('s-1', { kind: 'failed', code: 'network' }, NOW + 2);
    expect(await subscriptions.settle('s-1', { kind: 'notModified' }, NOW + 3)).toMatchObject({ currentVersion: '1', candidateVersion: null,
      lastAttemptAt: NOW + 3, lastSuccessAt: NOW + 3, lastFailure: null });
    expect(await subscriptions.settle('s-1', { kind: 'fetched', text: doc('1'), etag: '"1b"' }, NOW + 4)).toMatchObject({ currentVersion: '1',
      candidateVersion: null, etag: '"1b"' });
  });

  it('remove takes its keys and its place in one write, and a fetch that lands afterwards writes nothing', async () => {
    const { area, commits, list, subscriptions } = stores();
    await subscriptions.create(input(), NOW);
    await subscriptions.settle('s-1', { kind: 'fetched', text: doc('1'), etag: null }, NOW + 1);
    commits.length = 0;
    expect(await subscriptions.remove('s-1')).toMatchObject({ ok: true });
    const keys = subscriptionKeys('s-1');
    expect(commits).toEqual([[RULE_LIST_KEY, ...[keys.record, keys.local, keys.content('current'), keys.content('previous'), keys.content('candidate')]
      .map((key) => `-${key}`)].sort()]);
    expect(listed(await list.load())).toEqual([]);
    expect([...area.values.keys()]).toEqual([RULE_LIST_KEY]);
    expect(await subscriptions.settle('s-1', { kind: 'fetched', text: doc('2'), etag: null }, NOW + 2)).toBeNull();
    expect([...area.values.keys()]).toEqual([RULE_LIST_KEY]);
    expect(await subscriptions.remove('s-1')).toEqual({ ok: false, error: 'notFound' });
  });
});

describe('which subscriptions the alarm takes', () => {
  it('those not paused whose interval has passed since the last attempt, oldest attempt first, three at most', async () => {
    const { area, subscriptions } = stores();
    const at = async (n: number, lastAttemptAt: number | null, over: Partial<SubscriptionRecord> = {}) => {
      const made = await subscriptions.create(input(`https://rules.example.org/${n}.json`), NOW);
      if (!made.ok) throw new Error('not made');
      area.values.set(subscriptionKeys(made.record.id).record, { ...made.record, lastAttemptAt, ...over });
      return made.record.id;
    };
    const fresh = await at(1, NOW - 23 * HOUR);
    const due = await at(2, NOW - 24 * HOUR);
    const never = await at(3, null);
    const paused = await at(4, NOW - 200 * HOUR, { paused: true });
    const weekly = await at(5, NOW - 100 * HOUR, { refreshIntervalHours: 168 });
    const sixHourly = await at(6, NOW - 7 * HOUR, { refreshIntervalHours: 6 });
    const oldest = await at(7, NOW - 48 * HOUR);
    const all = (await subscriptions.due(NOW, Infinity)).map((record) => record.id);
    expect(all).toEqual([never, oldest, due, sixHourly]);
    for (const left of [fresh, paused, weekly]) expect(all).not.toContain(left);
    expect((await subscriptions.due(NOW)).map((record) => record.id)).toEqual([never, oldest, due].slice(0, REFRESH_PER_TICK));
  });
});

describe('the commands Options can send', () => {
  it('are closed: known settings only, an interval of 6, 24 or 168 hours, and folders by id', () => {
    const id = 's-1', url = 'https://rules.example.org/a.json';
    for (const command of [{ kind: 'known.automation.browser.subscription.check', url },
      { kind: 'known.automation.browser.subscribe', url, bindings: { papers: '30', code: null }, updatePolicy: 'auto', refreshIntervalHours: 168 },
      { kind: 'known.automation.browser.subscription.update', id, paused: true }, { kind: 'known.automation.browser.subscription.update', id, refreshIntervalHours: 6, updatePolicy: 'review' },
      { kind: 'known.automation.browser.subscription.update', id, pinned: true }, { kind: 'known.automation.browser.subscription.review', id },
      { kind: 'known.automation.browser.subscription.apply', id }, { kind: 'known.automation.browser.subscription.rollback', id },
      { kind: 'known.automation.browser.subscription.refresh', id }, { kind: 'known.automation.browser.subscription.remove', id }]) {
      expect(validBrowserRuleCommand(command)).toBe(true);
    }
    for (const command of [{ kind: 'known.automation.browser.subscription.check', url: '' },
      { kind: 'known.automation.browser.subscribe', url, bindings: {}, updatePolicy: 'review', refreshIntervalHours: 12 },
      { kind: 'known.automation.browser.subscribe', url, bindings: { 'no spaces': '30' }, updatePolicy: 'review', refreshIntervalHours: 24 },
      { kind: 'known.automation.browser.subscribe', url, bindings: {}, updatePolicy: 'review', refreshIntervalHours: 24, headers: { Authorization: 'x' } },
      { kind: 'known.automation.browser.subscription.update', id }, { kind: 'known.automation.browser.subscription.update', id, pinned: 'yes' },
      { kind: 'known.automation.browser.subscription.apply', id, version: '2' },
      { kind: 'known.automation.browser.subscription.refresh', id: '../x' }]) {
      expect(validBrowserRuleCommand(command)).toBe(false);
    }
  });
});

describe('the worker', () => {
  const served = new Map<string, () => Response>();
  const fetchSpy = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => served.get(String(input))?.() ?? new Response('gone', { status: 404 }));
  const alarms = new Map<string, { periodInMinutes: number }>();
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
    vi.stubGlobal('indexedDB', new IDBFactory());
    served.clear(); fetchSpy.mockClear(); alarms.clear();
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('chrome', { storage: { local: { get: async () => ({}), set: async () => undefined } },
      permissions: { contains: async ({ origins }: { origins: string[] }) => origins.every((origin) => origin.startsWith('https://rules.example.org/')) },
      alarms: { get: async (name: string) => alarms.has(name) ? { name } : undefined, create: (name: string, info: { periodInMinutes: number }) => { alarms.set(name, info); } },
      bookmarks: { get: async (id: string) => [{ id, title: 'Papers', parentId: '1' }] } });
  });
  afterEach(() => { automationDatabase().close(); vi.useRealTimers(); vi.unstubAllGlobals(); });
  const subscribe = (url: string) => handleSubscriptionCommand({ kind: 'known.automation.browser.subscribe', url, bindings: { papers: null },
    updatePolicy: 'review', refreshIntervalHours: 24 });

  it('registers one hourly alarm, and leaves it alone on the next start', async () => {
    installRuleSubscriptions();
    await vi.waitFor(() => expect(alarms.get(RULE_SUBSCRIPTION_ALARM)).toEqual({ periodInMinutes: 60 }));
    alarms.set(RULE_SUBSCRIPTION_ALARM, { periodInMinutes: 60 });
    installRuleSubscriptions();
    await Promise.resolve();
    expect(alarms.size).toBe(1);
  });

  it('subscribes with a failed first fetch as not ready, then Refresh now makes it ready', async () => {
    served.set('https://rules.example.org/a.json', () => new Response('busy', { status: 503 }));
    const first = await subscribe('https://rules.example.org/a.json#ignored');
    expect(first).toMatchObject({ ok: true, subscription: { state: 'notReady', url: 'https://rules.example.org/a.json', lastFailure: { code: 'http', status: 503 } } });
    if (!first.ok || !('subscription' in first)) throw new Error('not subscribed');
    served.set('https://rules.example.org/a.json', () => new Response(doc('1'), { headers: { ETag: '"1"' } }));
    expect(await handleSubscriptionCommand({ kind: 'known.automation.browser.subscription.refresh', id: first.subscription.id })).toMatchObject({ ok: true,
      subscription: { state: 'ready', currentVersion: '1', license: 'CC-BY-4.0', fetchedAt: NOW, lastFailure: null } });
    // Without the origin granted nothing is fetched, and the row can say why.
    const elsewhere = await subscribe('https://other.example.net/b.json');
    expect(elsewhere).toMatchObject({ ok: true, subscription: { state: 'notReady', lastFailure: { code: 'permission' } } });
    expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual(['https://rules.example.org/a.json', 'https://rules.example.org/a.json']);
    expect(await subscribe('http://rules.example.org/c.json')).toEqual({ ok: false, error: 'unsupported' });
  });

  it('the alarm refreshes only those due, and every request is a bare GET of a subscribed address (RS-15.5)', async () => {
    for (const name of ['a', 'b', 'c']) served.set(`https://rules.example.org/${name}.json`, () => new Response(doc('1'), { headers: { ETag: '"1"' } }));
    const ids: string[] = [];
    for (const name of ['a', 'b', 'c']) {
      const reply = await subscribe(`https://rules.example.org/${name}.json`);
      if (!reply.ok || !('subscription' in reply)) throw new Error('not subscribed');
      ids.push(reply.subscription.id);
    }
    await handleSubscriptionCommand({ kind: 'known.automation.browser.subscription.update', id: ids[2]!, paused: true });
    fetchSpy.mockClear();
    vi.setSystemTime(NOW + 23 * HOUR);
    expect(await refreshDueSubscriptions()).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    // b was tried again an hour later, so only a is due a day after the first fetch; c is paused.
    const store = ruleSubscriptionStore();
    await store.settle(ids[1]!, { kind: 'notModified' }, NOW + HOUR);
    served.set('https://rules.example.org/a.json', () => new Response(null, { status: 304 }));
    vi.setSystemTime(NOW + 24 * HOUR);
    expect(await refreshDueSubscriptions()).toEqual([ids[0]]);
    expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual(['https://rules.example.org/a.json']);
    for (const [, init] of fetchSpy.mock.calls) {
      expect(init).toMatchObject({ method: 'GET', credentials: 'omit', headers: { 'If-None-Match': '"1"' } });
      expect(init).not.toHaveProperty('body');
    }
    expect(await store.get(ids[0]!)).toMatchObject({ lastAttemptAt: NOW + 24 * HOUR, lastSuccessAt: NOW + 24 * HOUR, currentVersion: '1' });
  });
});
