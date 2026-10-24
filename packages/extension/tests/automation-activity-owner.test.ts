import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryStorageArea } from '../src/credential-store.js';
import { item } from './automation-activity-fixture.js';

vi.mock('../src/sw/runtime.js', () => ({
  hasBookmarkPermission: async () => false, extensionOrigin: () => 'chrome-extension://extension',
  store: { loadCredential: async () => ({ subject: 'account-a', serverOrigin: 'https://colp.example' }), loadBinding: async () => null },
  syncState: {},
}));
vi.mock('../src/sw/scope.js', () => ({ currentSyncScope: async () => null, loadConfig: async () => ({ serverOrigin: 'https://colp.example' }),
  pushSessionAuthority: async () => { throw new Error('offline'); } }));
vi.mock('../src/sw/capture-native.js', () => ({ currentCaptureScope: async () => null }));
vi.mock('../src/sw/reconcile-alarm.js', () => ({ ensurePeriodicAlarm: async () => undefined }));

import { automationArea, automationStateView, refreshAutomation } from '../src/sw/automation.js';
import { ACTIVITY_STATUS_KEY } from '../src/automation/activity-status.js';

afterEach(() => vi.unstubAllGlobals());
it('must not retain cookie account B private activity under extension account A after B signs out', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('chrome', { storage: { local: new MemoryStorageArea() }, i18n: { getMessage: () => '' },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} } });
  const privateItem = { ...item, items: [{ ...item.items[0], title: 'Private bookmark belonging to account B' }] };
  let browserSignedOut = false;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Known-Activity-Account-Id': 'account-b' } });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    if (browserSignedOut) return json({ error: { code: 'authentication_required' } }, 401);
    if (path === '/api/v1/me') return json({ accountId: 'account-b' });
    if (path === '/api/v1/me/activity/summary') return json({ unreadCount: 1, latest: privateItem, revision: '2' });
    return json({}, 404);
  }));
  await refreshAutomation({ manual: true });
  const cached = await automationArea().get(ACTIVITY_STATUS_KEY) as { ownerKey: string };
  expect(cached.ownerKey).toBe(JSON.stringify(['https://colp.example', 'account-a']));
  browserSignedOut = true;
  await refreshAutomation({ manual: true });
  const view = await automationStateView();
  expect(view.server?.activity?.latest?.items.map(member => member.title) ?? []).not.toContain('Private bookmark belonging to account B');
});
