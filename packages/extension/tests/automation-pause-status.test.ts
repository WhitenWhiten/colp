import { describe, expect, it } from 'vitest';
import { createBundleStore, type AutomationStateArea } from '../src/automation/bundle-store.js';
import { automationsPaused, createPauseStatusStore, readPauseStatus } from '../src/automation/pause-status.js';
import { NOW, ruleBundle } from './automation-fixture.js';
import type { PauseState } from '@know-n/colp/automation';

const owner = { serverOrigin: 'https://colp.example', accountId: 'owner' };
const pause = (paused: boolean, revision: string): PauseState => ({ paused, revision, pausedAt: paused ? new Date(NOW).toISOString() : null,
  pausedBy: paused ? 'owner' : null, heldJobs: 0 });
function fixture() {
  const data = new Map<string, unknown>();
  const area: AutomationStateArea = { get: async key => data.get(key), set: async (key, value) => { data.set(key, structuredClone(value)); } };
  return { area, pauses: createPauseStatusStore(area, owner), bundles: createBundleStore(area, owner) };
}

describe('independent account pause authority', () => {
  it('binds the response to the account and sends only web cookie authority', async () => {
    for (const accountId of ['owner', 'other', null]) {
      const result = await readPauseStatus(owner, async (url, init) => {
        expect(String(url)).toBe('https://colp.example/api/v1/me/automations/pause');
        expect(init).toMatchObject({ credentials: 'include', redirect: 'error', cache: 'no-store' });
        expect(new Headers(init?.headers).has('Authorization')).toBe(false);
        return new Response(JSON.stringify(pause(true, '2')), { headers: accountId ? { 'Known-Automation-Account-Id': accountId } : {} });
      });
      expect(result).toMatchObject(accountId === 'owner' ? { ok: true, pause: { paused: true } } : { ok: false, problem: 'signedOut' });
    }
  });

  it('keeps a learned pause across expiry, offline and stale or contradictory responses', async () => {
    const { pauses, bundles } = fixture();
    await bundles.install(ruleBundle([], { paused: false }), NOW);
    await pauses.apply({ ok: true, pause: pause(true, '9007199254740993') }, NOW);
    for (const result of [{ ok: false as const, problem: 'offline' as const },
      { ok: true as const, pause: pause(false, '9007199254740992') },
      { ok: true as const, pause: pause(false, '9007199254740993') }]) {
      await pauses.apply(result, NOW + 1);
      expect(automationsPaused(await bundles.read(), await pauses.read(), NOW + 86_400_000)).toBe(true);
    }
    await pauses.apply({ ok: true, pause: pause(false, '9007199254740994') }, NOW + 2);
    expect(automationsPaused(await bundles.read(), await pauses.read(), NOW + 86_400_000)).toBe(false);
  });

  it('uses separate revision sequences and a later read to lift a bundle pause', async () => {
    const { area, pauses, bundles } = fixture();
    await pauses.apply({ ok: true, pause: pause(false, '9999') }, NOW);
    await bundles.install(ruleBundle([], { paused: true, settingsRevision: 2 }), NOW + 10);
    expect(automationsPaused(await bundles.read(), await pauses.read(), NOW + 20)).toBe(true);
    await pauses.apply({ ok: true, pause: pause(false, '9999') }, NOW + 30);
    expect(automationsPaused(await bundles.read(), await pauses.read(), NOW + 40)).toBe(false);
    const other = createPauseStatusStore(area, { ...owner, accountId: 'other' });
    expect((await other.read()).pause).toBeNull();
  });
});
