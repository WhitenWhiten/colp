import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { automationDatabase } from '../src/automation/indexeddb-store.js';
import { RISK_SESSION_EXCEPTIONS_KEY } from '../src/risk/risk-settings.js';
import type { RiskEntry } from '../src/risk/risklist-format.js';
import { handleRiskCommand } from '../src/sw/risk.js';
import { ALERT_WINDOW_MS, applyBrowsing, handleCommitted, installRiskBrowsing, RISK_RECENT_ALERTS_KEY, shouldAlert } from '../src/sw/risk-browse.js';
import { NOW } from './automation-fixture.js';

/** Doc 17 §9 While browsing, RS-16.3, RS-16.4, RS-17.4, R11, R12: a badge per tab for a listed page, once per domain in 10 minutes unless the kind changes. */
const MINUTE = 60_000, DAY = 86_400_000;
const flag = (scope: RiskEntry['scope'], value: string, over: Partial<RiskEntry> = {}): RiskEntry =>
  ({ scope, value, kind: 'phishing', since: '2026-10-01T00:00:00Z', expires: null, evidenceUrl: null, ...over });
const doc = (id: string, entries: RiskEntry[]) => JSON.stringify({ format: 'colp.risklist/v1', id, name: `List ${id}`, version: '1', entries });

const served = new Map<string, string>();
let session: Record<string, unknown>, granted: boolean, badges: { tabId: number; text: string | null }[];
const listeners = new Set<(details: chrome.webNavigation.CommitDetails) => void>();
const removedTab: ((tabId: number) => void)[] = [];
const bookmarks = new Proxy({}, { get: () => { throw new Error('the browsing path touched chrome.bookmarks'); } });
const sendMessage = vi.fn();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
  vi.stubGlobal('indexedDB', new IDBFactory());
  served.clear(); session = {}; granted = true; badges = []; listeners.clear(); removedTab.length = 0; sendMessage.mockClear();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => { const body = served.get(String(input)); return body ? new Response(body) : new Response('', { status: 404 }); }));
  vi.stubGlobal('chrome', {
    storage: { local: { get: async () => ({}), set: async () => undefined },
      session: { get: async (key: string) => key in session ? { [key]: structuredClone(session[key]) } : {}, set: async (items: Record<string, unknown>) => { Object.assign(session, structuredClone(items)); } } },
    permissions: { contains: async ({ origins, permissions }: { origins?: string[]; permissions?: string[] }) => origins ? true : permissions ? granted : false,
      onRemoved: { addListener: vi.fn() } },
    action: { setBadgeText: vi.fn(async (details: { tabId: number; text: string | null }) => { badges.push(details); }), setBadgeBackgroundColor: vi.fn(async () => undefined) },
    webNavigation: { onCommitted: { addListener: (listener: never) => listeners.add(listener), removeListener: (listener: never) => listeners.delete(listener),
      hasListener: (listener: never) => listeners.has(listener) } },
    tabs: { onRemoved: { addListener: (listener: (tabId: number) => void) => removedTab.push(listener) } },
    runtime: { sendMessage },
    bookmarks,
  });
});
afterEach(() => { automationDatabase().close(); vi.useRealTimers(); vi.unstubAllGlobals(); });

async function subscribe(id: string, entries: RiskEntry[]) {
  served.set(`https://lists.example.org/${id}.json`, doc(id, entries));
  const reply = await handleRiskCommand({ kind: 'known.risk.subscribe', url: `https://lists.example.org/${id}.json`, refreshIntervalHours: 6 });
  if (!reply.ok || reply.list?.state !== 'ready') throw new Error('not subscribed');
}
const commit = (tabId: number, url: string, frameId = 0) => handleCommitted({ tabId, frameId, url, timeStamp: Date.now() }, Date.now());
const shown = (tabId: number) => badges.filter((item) => item.tabId === tabId).at(-1)?.text ?? null;

describe('R12 dedupe', () => {
  it('alerts once per tab and domain within 10 minutes, again after, and again when the kind changes', () => {
    const first = { domain: 'login-example-support.com', kind: 'phishing', at: NOW };
    expect(shouldAlert(undefined, first, NOW)).toBe(true);
    expect(shouldAlert(first, first, NOW + ALERT_WINDOW_MS - 1)).toBe(false);
    expect(shouldAlert(first, first, NOW + ALERT_WINDOW_MS)).toBe(true);
    expect(shouldAlert(first, { ...first, kind: 'malware' }, NOW + MINUTE)).toBe(true);
    expect(shouldAlert(first, { ...first, domain: 'other.example' }, NOW + MINUTE)).toBe(true);
  });
});

describe('alerts while browsing', () => {
  beforeEach(async () => {
    await subscribe('a', [flag('domain', 'login-example-support.com'), flag('host', 'old.example.com', { expires: '2026-10-01T00:00:00Z' })]);
    expect(await handleRiskCommand({ kind: 'known.risk.mode', mode: 'onSaveAndBrowse' })).toEqual({ ok: true });
  });

  it('puts ! on the tab for a listed page, not again in 10 minutes on the same domain, again after (RS-17.4)', async () => {
    expect(await commit(7, 'https://login-example-support.com/a')).toBe(true);
    expect(shown(7)).toBe('!');
    vi.setSystemTime(NOW + 4 * MINUTE);
    expect(await commit(7, 'https://www.login-example-support.com/b')).toBe(false);
    expect(shown(7)).toBeNull();
    // Another tab is its own.
    expect(await commit(8, 'https://login-example-support.com/a')).toBe(true);
    vi.setSystemTime(NOW + 11 * MINUTE);
    expect(await commit(7, 'https://login-example-support.com/c')).toBe(true);
    expect(session[RISK_RECENT_ALERTS_KEY]).toEqual({ 7: { domain: 'login-example-support.com', kind: 'phishing', at: NOW + 11 * MINUTE },
      8: { domain: 'login-example-support.com', kind: 'phishing', at: NOW + 4 * MINUTE } });
  });

  it('alerts again in the window when what the lists call the page changes', async () => {
    await subscribe('b', [flag('host', 'pay.login-example-support.com', { kind: 'malware' })]);
    expect(await commit(7, 'https://login-example-support.com/')).toBe(true);
    vi.setSystemTime(NOW + MINUTE);
    expect(await commit(7, 'https://pay.login-example-support.com/')).toBe(true);
    expect(session[RISK_RECENT_ALERTS_KEY]).toMatchObject({ 7: { kind: 'malware,phishing' } });
  });

  it('sets no badge for an unlisted page, a frame, an expired entry, an exception or a list out of date (R11)', async () => {
    expect(await commit(7, 'https://example.org/')).toBe(false);
    expect(await commit(7, 'https://login-example-support.com/', 3)).toBe(false);
    expect(await commit(7, 'https://old.example.com/')).toBe(false);
    session[RISK_SESSION_EXCEPTIONS_KEY] = [{ id: 'x1', scope: 'domain', value: 'login-example-support.com', createdAt: NOW }];
    expect(await commit(7, 'https://login-example-support.com/')).toBe(false);
    delete session[RISK_SESSION_EXCEPTIONS_KEY];
    vi.setSystemTime(NOW + 31 * DAY);
    expect(await commit(7, 'https://login-example-support.com/')).toBe(false);
    expect(badges.every((item) => item.text === null)).toBe(true);
  });

  it('calls no bookmark API, no automation command and no classifier (RS-16.4)', async () => {
    expect(await commit(7, 'https://login-example-support.com/')).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();
    const source = readFileSync(resolve(import.meta.dirname, '../src/sw/risk-browse.ts'), 'utf8');
    const imports = [...source.matchAll(/^import .* from '([^']+)';$/gmu)].map((match) => match[1]);
    expect(imports).toEqual(['@know-n/colp/automation', '../automation/public-suffix.js', '../badge-colors.js', '../risk/risk-check.js', '../risk/risk-settings.js', './risk.js']);
    expect(source).not.toMatch(/chrome\.bookmarks|declarativeNetRequest|classif/u);
  });
});

describe('the mode switch', () => {
  it('needs tabs and webNavigation: without them the mode stays where it was (RS-16.3)', async () => {
    granted = false;
    expect(await handleRiskCommand({ kind: 'known.risk.mode', mode: 'onSaveAndBrowse' })).toEqual({ ok: false, error: 'permission' });
    expect(await handleRiskCommand({ kind: 'known.risk.state' })).toMatchObject({ ok: true, state: { mode: 'off' } });
  });

  it('listens while browsing, and switching away removes the listener and clears the badges', async () => {
    installRiskBrowsing();
    await subscribe('a', [flag('domain', 'login-example-support.com')]);
    await vi.waitFor(() => expect(listeners.size).toBe(0));
    await handleRiskCommand({ kind: 'known.risk.mode', mode: 'onSaveAndBrowse' });
    expect(listeners.size).toBe(1);
    const [listener] = listeners;
    listener!({ tabId: 7, frameId: 0, url: 'https://login-example-support.com/', timeStamp: NOW });
    listener!({ tabId: 9, frameId: 0, url: 'https://login-example-support.com/', timeStamp: NOW });
    await vi.waitFor(() => expect([shown(7), shown(9)]).toEqual(['!', '!']));
    // A closed tab is forgotten.
    removedTab.forEach((gone) => gone(9));
    await vi.waitFor(() => expect(Object.keys(session[RISK_RECENT_ALERTS_KEY] as object)).toEqual(['7']));
    await handleRiskCommand({ kind: 'known.risk.mode', mode: 'onSave' });
    expect(listeners.size).toBe(0);
    expect(shown(7)).toBeNull();
    expect(session[RISK_RECENT_ALERTS_KEY]).toEqual({});
    await applyBrowsing('off');
    expect(listeners.size).toBe(0);
  });
});
