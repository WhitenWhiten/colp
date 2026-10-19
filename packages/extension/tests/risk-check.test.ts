import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { automationDatabase } from '../src/automation/indexeddb-store.js';
import { checkRisk, OUT_OF_DATE_AFTER_MS, STALE_AFTER_MS, type RiskSource } from '../src/risk/risk-check.js';
import { buildRiskIndex } from '../src/risk/risk-index.js';
import { validRiskCommand } from '../src/risk/risk-messages.js';
import { RISK_SESSION_EXCEPTIONS_KEY, RISK_SETTINGS_KEY } from '../src/risk/risk-settings.js';
import { createRiskStore, RISK_LISTS_KEY, riskKeys } from '../src/risk/risk-store.js';
import type { RiskEntry } from '../src/risk/risklist-format.js';
import { handleRiskCommand, refreshDueRiskLists } from '../src/sw/risk.js';
import { memoryStateArea, NOW } from './automation-fixture.js';

/** Doc 17 §4.4, §9, R11, RS-16.2, RS-17, RS-18: what the subscribed risk lists say about an address, read from stored indexes alone. */
const DAY = 86_400_000, HOUR = 3_600_000;
const flag = (scope: RiskEntry['scope'], value: string, over: Partial<RiskEntry> = {}): RiskEntry =>
  ({ scope, value, kind: 'phishing', since: '2026-10-01T00:00:00Z', expires: null, evidenceUrl: null, ...over });
const source = (id: string, entries: RiskEntry[], lastSuccessAt: number | null = NOW): RiskSource =>
  ({ id, name: `List ${id}`, index: buildRiskIndex({ entries }), lastSuccessAt });
const hits = (url: string, sources: RiskSource[], now = NOW) => checkRisk(url, sources, { now }).map((match) => `${match.listId}:${match.scope}:${match.value}`);
const doc = (version: string, entries: RiskEntry[] = [flag('domain', 'login-example-support.com')], over: Record<string, unknown> = {}) =>
  JSON.stringify({ format: 'colp.risklist/v1', id: 'example-phishing', name: 'Example phishing list', version,
    publisher: { name: 'Example', url: 'https://example.org', feedbackUrl: 'https://example.org/report' }, entries, ...over });

describe('scope is kept (RS-18.5)', () => {
  const list = source('a', [flag('host', 'login.example-bank.com'), flag('domain', 'login-example-support.com'),
    flag('urlPrefix', 'https://pages.example.dev/u123/', { kind: 'scam' })]);

  it('a host entry flags that host only, never its parent or a sibling', () => {
    expect(hits('https://login.example-bank.com/signin?x=1', [list])).toEqual(['a:host:login.example-bank.com']);
    for (const url of ['https://example-bank.com/', 'https://www.example-bank.com/', 'https://a.login.example-bank.com/']) expect(hits(url, [list])).toEqual([]);
  });

  it('a domain entry flags the domain and every host under it', () => {
    expect(hits('https://login-example-support.com/', [list])).toEqual(['a:domain:login-example-support.com']);
    expect(hits('http://a.b.LOGIN-example-support.com:8080/x', [list])).toEqual(['a:domain:login-example-support.com']);
    expect(hits('https://login-example-support.co/', [list])).toEqual([]);
  });

  it('a URL prefix flags the addresses under it, never the whole host', () => {
    expect(hits('https://pages.example.dev/u123/', [list])).toEqual(['a:urlPrefix:https://pages.example.dev/u123/']);
    expect(hits('https://pages.example.dev/u123/offer?id=4#top', [list])).toEqual(['a:urlPrefix:https://pages.example.dev/u123/']);
    for (const url of ['https://pages.example.dev/', 'https://pages.example.dev/u1234/', 'http://pages.example.dev/u123/', 'https://x.pages.example.dev/u123/']) {
      expect(hits(url, [list])).toEqual([]);
    }
  });

  it('an address on no list gets no answer at all, and only web pages are checked', () => {
    expect(checkRisk('https://example.org/', [list], { now: NOW })).toEqual([]);
    expect(checkRisk('chrome://settings', [list], { now: NOW })).toEqual([]);
    expect(checkRisk('not a url', [list], { now: NOW })).toEqual([]);
  });
});

describe('several lists, expiry and freshness (RS-18.3, RS-18.4, R11)', () => {
  it('lists every match with its own list, side by side, with nothing merged', () => {
    const first = source('a', [flag('domain', 'login-example-support.com')]);
    const second = source('b', [flag('host', 'www.login-example-support.com', { kind: 'malware', evidenceUrl: 'https://b.example/r/9' })]);
    const matches = checkRisk('https://www.login-example-support.com/', [first, second], { now: NOW });
    expect(matches).toEqual([
      { listId: 'a', listName: 'List a', scope: 'domain', value: 'login-example-support.com', kind: 'phishing', since: '2026-10-01T00:00:00Z', expires: null,
        evidenceUrl: null, expired: false, freshness: 'fresh' },
      { listId: 'b', listName: 'List b', scope: 'host', value: 'www.login-example-support.com', kind: 'malware', since: '2026-10-01T00:00:00Z', expires: null,
        evidenceUrl: 'https://b.example/r/9', expired: false, freshness: 'fresh' }]);
  });

  it('says an entry past its expiry is expired, never current', () => {
    const list = source('a', [flag('host', 'old.example.com', { expires: '2026-10-01T00:00:00Z' }), flag('host', 'new.example.com', { expires: '2026-12-01T00:00:00Z' })]);
    expect(checkRisk('https://old.example.com/', [list], { now: NOW })).toMatchObject([{ expired: true }]);
    expect(checkRisk('https://new.example.com/', [list], { now: NOW })).toMatchObject([{ expired: false }]);
  });

  it('is fresh up to 7 days after the last successful refresh, stale after, out of date after 30', () => {
    const at = (lastSuccessAt: number | null) => checkRisk('https://x.example.com/', [source('a', [flag('host', 'x.example.com')], lastSuccessAt)], { now: NOW })[0]?.freshness;
    expect(at(NOW - STALE_AFTER_MS)).toBe('fresh');
    expect(at(NOW - STALE_AFTER_MS - 1)).toBe('stale');
    expect(at(NOW - OUT_OF_DATE_AFTER_MS)).toBe('stale');
    expect(at(NOW - OUT_OF_DATE_AFTER_MS - 1)).toBe('outOfDate');
    expect(at(null)).toBe('outOfDate');
  });

  it('an exception silences its host, or its domain and the hosts under it, and nothing else (RS-17.3)', () => {
    const list = source('a', [flag('domain', 'login-example-support.com'), flag('host', 'login.example-bank.com')]);
    const check = (url: string, exceptions: { scope: 'host' | 'domain'; value: string }[]) => checkRisk(url, [list], { now: NOW, exceptions }).length;
    expect(check('https://www.login-example-support.com/', [{ scope: 'host', value: 'login-example-support.com' }])).toBe(1);
    expect(check('https://login-example-support.com/', [{ scope: 'host', value: 'login-example-support.com' }])).toBe(0);
    expect(check('https://www.login-example-support.com/', [{ scope: 'domain', value: 'login-example-support.com' }])).toBe(0);
    expect(check('https://login.example-bank.com/', [{ scope: 'domain', value: 'login-example-support.com' }])).toBe(1);
  });
});

describe('the store keeps one version of each list', () => {
  const fetched = (text: string, etag: string | null = null) => ({ kind: 'fetched', text, etag } as const);
  async function subscribed() {
    const area = memoryStateArea(), store = createRiskStore(area, { id: () => 'l1' });
    const made = await store.create({ url: 'https://lists.example.org/phish.json', origin: 'https://lists.example.org', refreshIntervalHours: 6 }, NOW);
    if (!made.ok) throw new Error('not subscribed');
    return { area, store };
  }

  it('builds the index when a version arrives, and keeps it through a failed or broken refresh (§4.4)', async () => {
    const { area, store } = await subscribed();
    expect(await store.sources()).toEqual([]);
    expect(await store.settle('l1', fetched(doc('1'), '"1"'), NOW)).toMatchObject({ state: 'ready', currentVersion: '1', name: 'Example phishing list',
      documentId: 'example-phishing', etag: '"1"', lastSuccessAt: NOW, publisher: { feedbackUrl: 'https://example.org/report' } });
    expect((await store.content('l1'))?.index.domains).toHaveProperty('login-example-support.com');
    for (const [outcome, code] of [[{ kind: 'failed', code: 'network' } as const, 'network'], [fetched('{'), 'invalid'],
      [fetched(doc('2', [], { format: 'colp.risklist/v2' })), 'unsupported'], [fetched(doc('1', [flag('host', 'other.example.com')])), 'invalid']] as const) {
      expect(await store.settle('l1', outcome, NOW + HOUR)).toMatchObject({ currentVersion: '1', lastSuccessAt: NOW, lastFailure: { code } });
    }
    expect(hits('https://a.login-example-support.com/', await store.sources(), NOW + HOUR)).toEqual(['l1:domain:login-example-support.com']);
    // A new version replaces the one slot: there is nothing to go back to.
    await store.settle('l1', fetched(doc('2', [flag('host', 'other.example.com')])), NOW + 2 * HOUR);
    expect(hits('https://a.login-example-support.com/', await store.sources(), NOW + 2 * HOUR)).toEqual([]);
    expect(hits('https://other.example.com/', await store.sources(), NOW + 2 * HOUR)).toEqual(['l1:host:other.example.com']);
    expect([...area.values.keys()].sort()).toEqual([riskKeys('l1').content, RISK_LISTS_KEY, riskKeys('l1').record]);
    expect(await store.remove('l1')).toBe(true);
    expect([...area.values.keys()]).toEqual([RISK_LISTS_KEY]);
    expect(await store.sources()).toEqual([]);
  });

  it('refuses a second subscription to the same address', async () => {
    const { store } = await subscribed();
    expect(await store.create({ url: 'https://lists.example.org/phish.json', origin: 'https://lists.example.org', refreshIntervalHours: 6 }, NOW))
      .toEqual({ ok: false, error: 'duplicate' });
  });
});

describe('the worker', () => {
  const served = new Map<string, () => Response>();
  const fetchSpy = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => served.get(String(input))?.() ?? new Response('gone', { status: 404 }));
  let session: Record<string, unknown> = {};
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
    vi.stubGlobal('indexedDB', new IDBFactory());
    served.clear(); fetchSpy.mockClear(); session = {};
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('chrome', { storage: { local: { get: async () => ({}), set: async () => undefined },
      session: { get: async (key: string) => key in session ? { [key]: session[key] } : {} } },
    permissions: { contains: async ({ origins }: { origins: string[] }) => origins.every((origin) => origin.startsWith('https://lists.example.org/')) } });
  });
  afterEach(() => { automationDatabase().close(); vi.useRealTimers(); vi.unstubAllGlobals(); });
  const subscribe = async () => {
    served.set('https://lists.example.org/phish.json', () => new Response(doc('1'), { headers: { ETag: '"1"' } }));
    const reply = await handleRiskCommand({ kind: 'known.risk.subscribe', url: 'https://lists.example.org/phish.json', refreshIntervalHours: 6 });
    if (!reply.ok || !reply.list) throw new Error('not subscribed');
    return reply.list;
  };
  const mode = (value: string, exceptions: unknown[] = []) => automationDatabase().area().set(RISK_SETTINGS_KEY, { mode: value, exceptions });
  const check = (url: string) => handleRiskCommand({ kind: 'known.risk.check', url });

  it('checks from stored indexes only: no request leaves for a check (RS-16.2)', async () => {
    expect(await subscribe()).toMatchObject({ state: 'ready', currentVersion: '1', freshness: 'fresh' });
    await mode('onSave');
    fetchSpy.mockClear();
    expect(await check('https://www.login-example-support.com/a')).toMatchObject({ ok: true, check: { mode: 'onSave',
      matches: [{ listName: 'Example phishing list', scope: 'domain', value: 'login-example-support.com', freshness: 'fresh' }] } });
    expect(await check('https://example.org/')).toEqual({ ok: true, check: { mode: 'onSave', matches: [], site: null } });
    // A week and a day without a successful refresh: the match says the list is stale (R11).
    vi.setSystemTime(NOW + 8 * DAY);
    expect(await check('https://login-example-support.com/')).toMatchObject({ ok: true, check: { matches: [{ freshness: 'stale' }] } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('says nothing while alerts are off, and leaves out this session’s and saved exceptions', async () => {
    await subscribe();
    expect(await check('https://login-example-support.com/')).toEqual({ ok: true, check: { mode: 'off', matches: [], site: null } });
    await mode('onSaveAndBrowse', [{ id: 'x1', scope: 'host', value: 'www.login-example-support.com', createdAt: NOW }]);
    expect(await check('https://www.login-example-support.com/')).toMatchObject({ check: { matches: [] } });
    expect(await check('https://login-example-support.com/')).toMatchObject({ check: { matches: [{ value: 'login-example-support.com' }] } });
    session[RISK_SESSION_EXCEPTIONS_KEY] = [{ id: 'x2', scope: 'domain', value: 'login-example-support.com', createdAt: NOW }];
    expect(await check('https://login-example-support.com/')).toMatchObject({ check: { matches: [] } });
  });

  it('fetches through the 4 MB cap, refreshes on the hourly tick when due and alerts are on, and removes', async () => {
    const list = await subscribe();
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', credentials: 'omit' });
    served.set('https://lists.example.org/phish.json', () => new Response(null, { status: 304 }));
    // Off, nothing is fetched by itself.
    vi.setSystemTime(NOW + 6 * HOUR);
    expect(await refreshDueRiskLists()).toEqual([]);
    await mode('onSave');
    vi.setSystemTime(NOW + 5 * HOUR);
    expect(await refreshDueRiskLists()).toEqual([]);
    vi.setSystemTime(NOW + 6 * HOUR);
    expect(await refreshDueRiskLists()).toEqual([list.id]);
    expect(fetchSpy.mock.calls[1]?.[1]).toMatchObject({ headers: { 'If-None-Match': '"1"' } });
    served.set('https://lists.example.org/phish.json', () => new Response(`${doc('2')}${' '.repeat(3 * 1024 * 1024)}`));
    expect(await handleRiskCommand({ kind: 'known.risk.refresh', id: list.id })).toMatchObject({ ok: true, list: { currentVersion: '2', lastFailure: null } });
    expect(await handleRiskCommand({ kind: 'known.risk.remove', id: list.id })).toEqual({ ok: true });
    expect(await handleRiskCommand({ kind: 'known.risk.refresh', id: list.id })).toEqual({ ok: false, error: 'notFound' });
    expect(await handleRiskCommand({ kind: 'known.risk.subscribe', url: 'http://lists.example.org/a.json', refreshIntervalHours: 6 }))
      .toEqual({ ok: false, error: 'unsupported' });
  });

  it('accepts only the commands it knows, closed', () => {
    expect(validRiskCommand({ kind: 'known.risk.check', url: 'https://a.example/' })).toBe(true);
    expect(validRiskCommand({ kind: 'known.risk.check', url: 'https://a.example/', extra: 1 })).toBe(false);
    expect(validRiskCommand({ kind: 'known.risk.subscribe', url: 'https://a.example/l.json', refreshIntervalHours: 5 })).toBe(false);
    expect(validRiskCommand({ kind: 'known.risk.remove', id: '../x' })).toBe(false);
  });
});
