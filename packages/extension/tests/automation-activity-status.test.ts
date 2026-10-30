import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import type { ActivitySummary } from '../src/automation/activity-types.js';
import { ACTIVITY_STATUS_KEY, activityStatusDue, createActivityStatusStore, readActivitySummary } from '../src/automation/activity-status.js';
import { createAutomationDatabase } from '../src/automation/indexeddb-store.js';
import { IDBFactory } from 'fake-indexeddb';

import { item } from './automation-activity-fixture.js';
const summary: ActivitySummary = { unreadCount: 1, latest: item, revision: '2' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Known-Activity-Account-Id': 'owner-1' } });
const OWNER = '["https://colp.example","owner-1"]';
const NOW = Date.parse('2026-10-23T08:01:00.000Z');
function memoryArea() {
  const values = new Map<string, unknown>();
  return { async get(key: string) { return structuredClone(values.get(key)); }, async set(key: string, value: unknown) { values.set(key, structuredClone(value)); } };
}

describe('activity summary transport', () => {
  it('reads the bounded contract with cookie authority and host permission checking', async () => {
    const fetcher = vi.fn(async () => json(summary));
    expect(await readActivitySummary('https://colp.example/', 'owner-1', fetcher)).toEqual({ ok: true, summary });
    expect(fetcher).toHaveBeenCalledWith('https://colp.example/api/v1/me/activity/summary', expect.objectContaining({
      method: 'GET', credentials: 'include', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' }, signal: expect.any(AbortSignal) }));
    vi.stubGlobal('chrome', { permissions: { contains: async () => false } });
    try { await expect(readActivitySummary('https://colp.example', 'owner-1', fetcher)).rejects.toThrow('server_configuration_failed'); }
    finally { vi.unstubAllGlobals(); }
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('accepts an empty inbox and rejects malformed or oversized summaries', async () => {
    expect(await readActivitySummary('https://colp.example', 'owner-1', async () => json({ unreadCount: 0, latest: null, revision: '0' }))).toMatchObject({ ok: true });
    const bad = [{ ...summary, unreadCount: -1 }, { ...summary, revision: 2 }, { ...summary, latest: { ...item, agent: { name: 'Claude' } } },
      { ...summary, latest: { ...item, folders: Array(6).fill(item.folders[0]) } }, { ...summary, latest: { ...item, updatedAt: 'invalid' } },
      { ...summary, latest: { ...item, items: [{ ...item.items[0], title: 'x'.repeat(65_536) }] } }];
    for (const body of bad) expect(await readActivitySummary('https://colp.example', 'owner-1', async () => json(body))).toEqual({ ok: false, problem: 'invalid' });
  });

  it('accepts an approval request with its plan, and items from servers without plans', async () => {
    const approval = { ...item, kind: 'approval_requested', count: 0, folders: [], items: [], plan: { id: 'plan-1', summary: 'Move 3 items' } };
    for (const latest of [approval, { ...item, plan: null }, item]) {
      expect(await readActivitySummary('https://colp.example', 'owner-1', async () => json({ ...summary, latest }))).toMatchObject({ ok: true });
    }
    for (const latest of [{ ...approval, plan: { id: 'plan-1' } }, { ...approval, plan: 'plan-1' }]) {
      expect(await readActivitySummary('https://colp.example', 'owner-1', async () => json({ ...summary, latest }))).toEqual({ ok: false, problem: 'invalid' });
    }
  });

  it('keeps the unread count when a newer server reports a kind this build does not know', async () => {
    const newer = { ...summary, unreadCount: 4, latest: { ...item, kind: 'approval_granted' } };
    expect(await readActivitySummary('https://colp.example', 'owner-1', async () => json(newer)))
      .toEqual({ ok: true, summary: { ...newer, latest: null } });
    // Only the kind is forgiven: a malformed count or revision still fails.
    expect(await readActivitySummary('https://colp.example', 'owner-1', async () => json({ ...newer, unreadCount: -1 })))
      .toEqual({ ok: false, problem: 'invalid' });
  });

  it('maps unavailable, authentication, rate and connection failures', async () => {
    for (const [status, problem] of [[404, 'unavailable'], [401, 'signedOut'], [403, 'signedOut'], [429, 'rateLimited'], [503, 'rateLimited'], [500, 'server']] as const) {
      expect(await readActivitySummary('https://colp.example', 'owner-1', async () => json({}, status))).toEqual({ ok: false, problem });
    }
    expect(await readActivitySummary('https://colp.example', 'owner-1', async () => { throw new Error('offline'); })).toEqual({ ok: false, problem: 'offline' });
  });
});

describe('the account activity cache', () => {
  it('remembers 404 until a manual check and keeps failed reads separate from the last good copy', async () => {
    const cache = createActivityStatusStore(memoryArea(), OWNER);
    expect(activityStatusDue(await cache.read(), NOW)).toBe(true);
    await cache.apply({ ok: true, summary }, NOW);
    const failed = await cache.apply({ ok: false, problem: 'offline' }, NOW + 60_000);
    expect(failed).toMatchObject({ fetchedAt: NOW, latest: item, unreadCount: 1, problem: { kind: 'offline' } });
    expect(activityStatusDue(failed, NOW + 179_999)).toBe(false);
    expect(activityStatusDue(failed, NOW + 180_000)).toBe(true);
    const missing = await cache.apply({ ok: false, problem: 'unavailable' }, NOW + 180_000);
    expect(activityStatusDue(missing, NOW + 86_400_000)).toBe(false);
    expect(activityStatusDue(missing, NOW + 180_001, true)).toBe(true);
    await cache.retryAfterSignIn();
    expect(activityStatusDue(await cache.read(), NOW + 180_001)).toBe(true);
    expect(await cache.read()).toMatchObject({ latest: item, fetchedAt: NOW, problem: { kind: 'unavailable' } });
    expect(await cache.apply({ ok: true, summary: { unreadCount: 0, latest: item, revision: '3' } }, NOW + 180_001)).toMatchObject({ unreadCount: 0, problem: null });
  });

  it('isolates accounts and clears the matching activity record at sign-out', async () => {
    const db = createAutomationDatabase(new IDBFactory());
    try {
      await createActivityStatusStore(db.area(), OWNER).apply({ ok: true, summary }, NOW);
      const other = createActivityStatusStore(db.area(), 'other-owner');
      expect(await other.read()).toMatchObject({ fetchedAt: null, latest: null, unreadCount: 0 });
      await db.clearAccount('other-owner');
      expect(await db.area().get(ACTIVITY_STATUS_KEY)).toMatchObject({ ownerKey: OWNER });
      await db.clearAccount(OWNER);
      expect(await db.area().get(ACTIVITY_STATUS_KEY)).toBeUndefined();
    } finally { db.close(); }
  });
});

it('refuses mismatched or missing owner identity and erases authenticated data after sign-out', async () => {
  const cache = createActivityStatusStore(memoryArea(), OWNER);
  await cache.apply({ ok: true, summary }, NOW);
  for (const owner of [null, 'other-owner']) {
    const headers = new Headers();
    if (owner) headers.set('Known-Activity-Account-Id', owner);
    const result = await readActivitySummary('https://colp.example', 'owner-1', async () =>
      new Response(JSON.stringify(summary), { headers }));
    expect(result).toEqual({ ok: false, problem: 'signedOut' });
    expect(await cache.apply(result, NOW + 1)).toMatchObject({ latest: null, unreadCount: 0, fetchedAt: null });
  }
  await cache.apply({ ok: true, summary }, NOW);
  expect(await cache.apply({ ok: false, problem: 'signedOut' }, NOW + 1)).toMatchObject({ latest: null, unreadCount: 0, fetchedAt: null });
});

it('discards legacy caches whose account identity was not verified', async () => {
  const area = memoryArea();
  await area.set(ACTIVITY_STATUS_KEY, { ...summary, version: 1, ownerKey: OWNER, fetchedAt: NOW });
  expect(await createActivityStatusStore(area, OWNER).read()).toMatchObject({ latest: null, unreadCount: 0, fetchedAt: null });
});
