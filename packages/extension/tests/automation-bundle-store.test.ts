import { describe, expect, it } from 'vitest';
import { AUTOMATION_BUNDLE_KEY, bundleState, createBundleStore, refreshDue, type AutomationStateArea } from '../src/automation/bundle-store.js';
import { DAY, NOW, compiledRule, ruleBundle } from './automation-fixture.js';

function memoryArea(): AutomationStateArea & { readonly values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return { values, async get(key) { return structuredClone(values.get(key)); }, async set(key, value) { values.set(key, structuredClone(value)); } };
}
const owner = { serverOrigin: 'https://colp.example', accountId: 'owner-1' };

describe('installed rule bundle', () => {
  it('installs a valid bundle atomically and reports it active until it expires', async () => {
    const store = createBundleStore(memoryArea(), owner);
    const outcome = await store.install(ruleBundle([compiledRule()]), NOW);
    expect(outcome.kind).toBe('installed');
    expect(outcome.record).toMatchObject({ serverUuid: 'server-fixture', lastRefreshAt: NOW, problem: null });
    expect((await store.state(NOW)).state).toBe('active');
    expect(await store.state(NOW + 7 * DAY)).toEqual({ state: 'expired', expiredAt: NOW + 7 * DAY });
  });

  it('keeps the previous bundle when a corrupt, unsupported or expired one arrives', async () => {
    const store = createBundleStore(memoryArea(), owner);
    const first = ruleBundle([compiledRule()]);
    await store.install(first, NOW);
    const rejected = await store.install({ ...ruleBundle([compiledRule()], { settingsRevision: 2 }), digest: 'f'.repeat(64) }, NOW + 1);
    expect(rejected).toMatchObject({ kind: 'rejected', reason: 'digest' });
    expect((await store.read()).bundle?.digest).toBe(first.digest);
    expect((await store.read()).problem).toEqual({ kind: 'rejected', reason: 'digest', at: NOW + 1 });
    const expired = await store.install(ruleBundle([compiledRule()], { settingsRevision: 3, issuedAt: NOW - 8 * DAY }), NOW + 2);
    expect(expired).toMatchObject({ kind: 'rejected', reason: 'expired' });
    expect((await store.state(NOW + 3)).state).toBe('active');
  });

  it('refuses an older settings sequence even before its copy would expire', async () => {
    const store = createBundleStore(memoryArea(), owner);
    await store.install(ruleBundle([compiledRule()], { settingsRevision: 5, revision: '9' }), NOW);
    const older = await store.install(ruleBundle([compiledRule({ ruleId: 'rule-old' })], { settingsRevision: 4, revision: '10' }), NOW + 1);
    expect(older).toMatchObject({ kind: 'rejected', reason: 'stale' });
    expect((await store.read()).bundle?.settingsRevision).toBe(5);
  });

  it('never lifts a learned pause with a bundle that is not newer, across worker restarts', async () => {
    const area = memoryArea();
    const store = createBundleStore(area, owner);
    await store.install(ruleBundle([compiledRule()], { settingsRevision: 5 }), NOW);
    await store.install(ruleBundle([], { settingsRevision: 6, paused: true }), NOW + 10);
    expect(await store.state(NOW + 20)).toMatchObject({ state: 'paused', since: NOW + 10 });
    // A new store over the same storage is the worker after a restart.
    const restarted = createBundleStore(area, owner);
    expect(await restarted.install(ruleBundle([compiledRule()], { settingsRevision: 6 }), NOW + 30)).toMatchObject({ kind: 'rejected', reason: 'stale' });
    expect(await restarted.install(ruleBundle([compiledRule()], { settingsRevision: 5 }), NOW + 40)).toMatchObject({ kind: 'rejected', reason: 'stale' });
    expect((await restarted.state(NOW + 50)).state).toBe('paused');
    await restarted.install(ruleBundle([], { settingsRevision: 6, paused: true }), NOW + 60);
    expect((await restarted.read()).pausedSince).toBe(NOW + 10);
    // Resuming on the server is a newer settings sequence.
    expect(await restarted.install(ruleBundle([compiledRule()], { settingsRevision: 7 }), NOW + 70)).toMatchObject({ kind: 'installed' });
    expect((await restarted.read()).pausedSince).toBeNull();
  });

  it('records a failed refresh without touching the installed bundle', async () => {
    const store = createBundleStore(memoryArea(), owner);
    await store.install(ruleBundle([compiledRule()]), NOW);
    const record = await store.recordProblem('offline', NOW + 5);
    expect(record).toMatchObject({ lastRefreshAt: NOW, lastAttemptAt: NOW + 5, problem: { kind: 'offline', at: NOW + 5 } });
    expect(bundleState(record, NOW + 6).state).toBe('active');
  });

  it('retains a learned pause past expiry and restart until a newer settings revision resumes it', async () => {
    const area = memoryArea(), store = createBundleStore(area, owner);
    await store.install(ruleBundle([], { settingsRevision: 6, paused: true }), NOW);
    await store.recordProblem('offline', NOW + 8 * DAY);
    const restarted = createBundleStore(area, owner);
    expect(await restarted.state(NOW + 8 * DAY)).toMatchObject({ state: 'paused', since: NOW });
    expect(await restarted.install(ruleBundle([compiledRule()], { settingsRevision: 6, issuedAt: NOW + 8 * DAY }), NOW + 8 * DAY))
      .toMatchObject({ kind: 'rejected', reason: 'stale' });
    expect((await restarted.state(NOW + 8 * DAY)).state).toBe('paused');
    await restarted.install(ruleBundle([compiledRule()], { settingsRevision: 7, issuedAt: NOW + 8 * DAY }), NOW + 8 * DAY);
    expect((await restarted.state(NOW + 8 * DAY)).state).toBe('active');
  });

  it('backs off after failed refreshes, up to 15 minutes, and a good refresh resets the wait', async () => {
    const store = createBundleStore(memoryArea(), owner);
    expect(refreshDue(await store.read(), NOW)).toBe(true);
    let record = await store.install(ruleBundle([compiledRule()]), NOW).then(() => store.read());
    expect([refreshDue(record, NOW + 59_999), refreshDue(record, NOW + 60_000)]).toEqual([false, true]);
    for (let failure = 1; failure <= 8; failure += 1) record = await store.recordProblem('offline', NOW);
    expect(record.failures).toBe(8);
    // 2, 4, 8 minutes, then never more than 15: a pause still lands soon after the server is back.
    expect([refreshDue(record, NOW + 899_999), refreshDue(record, NOW + 900_000)]).toEqual([false, true]);
    record = await store.recordProblem('offline', NOW).then(() => store.recordProblem('offline', NOW));
    expect(refreshDue({ ...record, failures: 2 }, NOW + 239_999)).toBe(false);
    expect(refreshDue({ ...record, failures: 2 }, NOW + 240_000)).toBe(true);
    await store.install(ruleBundle([compiledRule()], { settingsRevision: 2 }), NOW + 900_000);
    expect(await store.read()).toMatchObject({ failures: 0, lastAttemptAt: NOW + 900_000 });
  });

  it('never hands one account another account’s rules', async () => {
    const area = memoryArea();
    await createBundleStore(area, owner).install(ruleBundle([compiledRule()]), NOW);
    const other = createBundleStore(area, { ...owner, accountId: 'owner-2' });
    expect((await other.read()).bundle).toBeNull();
    expect((await other.state(NOW)).state).toBe('none');
    expect(area.values.has(AUTOMATION_BUNDLE_KEY)).toBe(true);
  });

  it('serializes concurrent installs so the newest settings win', async () => {
    const store = createBundleStore(memoryArea(), owner);
    await Promise.all([
      store.install(ruleBundle([compiledRule()], { settingsRevision: 3 }), NOW),
      store.install(ruleBundle([compiledRule()], { settingsRevision: 2 }), NOW),
      store.install(ruleBundle([compiledRule()], { settingsRevision: 4 }), NOW),
    ]);
    expect((await store.read()).bundle?.settingsRevision).toBe(4);
  });
});

