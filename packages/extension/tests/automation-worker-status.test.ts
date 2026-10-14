import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBundleStore } from '../src/automation/bundle-store.js';
import { MemoryStorageArea } from '../src/credential-store.js';
import { NOW, compiledRule, ruleBundle, serverRule, serverRun } from './automation-fixture.js';

/** AW-54 in the worker: the server's status is read on the existing refresh, with the web sign-in, and shown with its age. */
const f = vi.hoisted(() => ({ fetch: undefined as unknown as ReturnType<typeof vi.fn>, badge: { text: '', color: '', title: '' } }));
vi.mock('../src/sw/runtime.js', () => ({
  hasBookmarkPermission: async () => false, extensionOrigin: () => 'chrome-extension://extension',
  store: { loadCredential: async () => ({ subject: 'owner', serverOrigin: 'https://colp.example' }), loadBinding: async () => null },
  syncState: {},
}));
vi.mock('../src/sw/scope.js', () => ({ currentSyncScope: async () => null, loadConfig: async () => ({ serverOrigin: 'https://colp.example' }),
  // Sync's own authority is unavailable: the server status does not depend on it.
  pushSessionAuthority: async () => { throw new Error('offline'); } }));
vi.mock('../src/sw/capture-native.js', () => ({ currentCaptureScope: async () => null }));
vi.mock('../src/sw/reconcile-alarm.js', () => ({ ensurePeriodicAlarm: async () => undefined }));

import { automationArea, automationStateView, handleAutomationRequest, refreshAutomation } from '../src/sw/automation.js';
import { BADGE_ACCENT, BADGE_MUTED } from '../src/badge-colors.js';
import { presentSaveFeedback } from '../src/save-feedback.js';

const owner = { serverOrigin: 'https://colp.example', accountId: 'owner' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
let answers: Record<string, () => Response>;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
  vi.stubGlobal('indexedDB', new IDBFactory());
  f.badge = { text: '', color: '', title: 'Know-N — save this page' };
  vi.stubGlobal('chrome', { storage: { local: new MemoryStorageArea() }, i18n: { getMessage: (key: string) => (key === 'actionTitle' ? 'Know-N — save this page' : '') },
    action: { setBadgeText: async ({ text }: { text: string }) => { f.badge.text = text; },
      setBadgeBackgroundColor: async ({ color }: { color: string }) => { f.badge.color = color; },
      setTitle: async ({ title }: { title: string }) => { f.badge.title = title; } } });
  answers = {
    '/api/v1/me/automations/rules': () => json({ items: [serverRule({ name: 'arXiv papers', state: 'degraded' }),
      serverRule({ id: 'rule-digest', name: 'Weekly digest', intake: false })], nextCursor: null }),
    '/api/v1/me/automations/runs': () => json({ items: [serverRun({ id: 'run-1', status: 'waiting', held: true }),
      serverRun({ id: 'run-2', ruleId: 'rule-digest', kind: 'batch', unread: true, outputCount: 1 }), serverRun({ id: 'run-3', ruleId: 'rule-gone' })], nextCursor: null }),
  };
  f.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const answer = answers[new URL(String(input)).pathname];
    if (!answer) throw new TypeError('offline');
    return answer();
  });
  vi.stubGlobal('fetch', f.fetch);
  await createBundleStore(automationArea(), owner).install(ruleBundle([compiledRule()], { revision: 'b-1' }), NOW);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('the server’s status in the worker', () => {
  it('reads it on a refresh with the web sign-in, even when Sync can’t reach the server', async () => {
    await refreshAutomation({ manual: true });
    expect(f.fetch.mock.calls.map(([url, init]) => [String(url), (init as RequestInit).credentials])).toEqual([
      ['https://colp.example/api/v1/me/automations/rules?limit=100', 'include'], ['https://colp.example/api/v1/me/automations/runs?limit=20', 'include']]);
    const { server, problem } = await automationStateView();
    // The bundle refresh failed on its own (no Sync authority); the server's status still came through.
    expect(problem).toBe('signedOut');
    expect(server).toEqual({ fetchedAt: NOW, problem: null,
      rules: [{ id: 'rule-arxiv', name: 'arXiv papers', state: 'degraded', inBrowser: true, waiting: null, held: null, approvals: null, cost: null },
        { id: 'rule-digest', name: 'Weekly digest', state: 'active', inBrowser: false, waiting: null, held: null, approvals: null, cost: null }],
      runs: [
        { id: 'run-1', ruleName: 'arXiv papers', kind: 'intake', status: 'waiting', held: true, explanation: null, at: NOW, unread: false, outputCount: 0,
          url: 'https://colp.example/automations/runs/run-1' },
        expect.objectContaining({ id: 'run-2', ruleName: 'Weekly digest', kind: 'batch', unread: true, outputCount: 1 }),
        expect.objectContaining({ id: 'run-3', ruleName: null })] });
  });

  it('keeps the last answer and its age when the server can’t be read, and waits before asking again', async () => {
    await refreshAutomation({ manual: true });
    vi.setSystemTime(NOW + 120_000);
    answers['/api/v1/me/automations/runs'] = () => json({ error: { code: 'unauthorized' } }, 401);
    await refreshAutomation({ manual: true });
    expect((await automationStateView()).server).toMatchObject({ fetchedAt: NOW, problem: 'signedOut', runs: [{ id: 'run-1' }, { id: 'run-2' }, { id: 'run-3' }] });
    // The alarm's pass right after a failure does not read again.
    f.fetch.mockClear();
    vi.setSystemTime(NOW + 150_000);
    await refreshAutomation();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it('still knows which rules file bookmarks here while a pause keeps them out of the bundle', async () => {
    await createBundleStore(automationArea(), owner).install(ruleBundle([], { revision: 'b-2', settingsRevision: 2, paused: true }), NOW);
    await refreshAutomation({ manual: true });
    const { state, rules, server } = await automationStateView();
    expect([state, rules]).toEqual(['paused', []]);
    expect(server?.rules.map((rule) => [rule.id, rule.inBrowser])).toEqual([['rule-arxiv', true], ['rule-digest', false]]);
  });

  it('shows nothing for a server without automations, and stops asking it', async () => {
    answers['/api/v1/me/automations/rules'] = () => json({ error: { code: 'not_found' } }, 404);
    await refreshAutomation({ manual: true });
    expect((await automationStateView()).server).toBeNull();
  });
});

describe('the toolbar badge (AW-60)', () => {
  const digestOnly = (unread: boolean) => () => json({ items: [serverRun({ id: 'digest-1', ruleId: 'rule-digest', kind: 'batch', unread, outputCount: 1 }),
    serverRun({ id: 'intake-1', unread: false, outputCount: 0 })], nextCursor: null });

  it('shows the server’s unread results, and clears once the server says they were read on the web', async () => {
    answers['/api/v1/me/automations/runs'] = digestOnly(true);
    await refreshAutomation({ manual: true });
    expect(f.badge).toEqual({ text: '1', color: BADGE_ACCENT, title: '1 new digest.' });
    expect(await handleAutomationRequest({ kind: 'known.automation.digest' })).toEqual({ ok: true, digest: {
      count: 1, digests: true, url: 'https://colp.example/automations/runs/digest-1', ruleName: 'Weekly digest', fetchedAt: NOW, stale: false } });
    // Read on the web: the next read model has it read, and the badge goes with it. "Check now" runs
    // after the background pass the popup's request started, not folded into it.
    vi.setSystemTime(NOW + 60_000);
    answers['/api/v1/me/automations/runs'] = digestOnly(false);
    await refreshAutomation({ manual: true });
    expect(f.badge).toEqual({ text: '', color: BADGE_ACCENT, title: 'Know-N — save this page' });
    // Only the two status reads ever went out: nothing was marked read from here.
    expect(new Set(f.fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)))
      .toEqual(new Set(['/api/v1/me/automations/rules', '/api/v1/me/automations/runs']));
  });

  it('turns muted with the time of the last answer while the server can’t be read', async () => {
    answers['/api/v1/me/automations/runs'] = digestOnly(true);
    await refreshAutomation({ manual: true });
    vi.setSystemTime(NOW + 60_000);
    delete answers['/api/v1/me/automations/rules'];
    await refreshAutomation({ manual: true });
    expect([f.badge.text, f.badge.color]).toEqual(['1', BADGE_MUTED]);
    expect(f.badge.title).toMatch(/^1 new digest as of .+\. Your server couldn’t be reached since\.$/u);
  });

  it('leaves a save problem on the badge, and takes it back when that clears', async () => {
    await presentSaveFeedback({ code: 'permission_required', entry: 'page', now: NOW });
    answers['/api/v1/me/automations/runs'] = digestOnly(true);
    await refreshAutomation({ manual: true });
    expect(f.badge.text).toBe('!');
    await presentSaveFeedback({ code: 'saved', entry: 'page', now: NOW });
    expect(f.badge).toMatchObject({ text: '1', color: BADGE_ACCENT });
  });
});
