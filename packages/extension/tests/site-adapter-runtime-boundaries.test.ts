import { bundledScriptDefinitions, sameScriptRegistration } from '../src/site-adapters/browser-registration.js';
import { afterEach, expect, test, vi } from 'vitest';
import { legacySite } from '../src/site-adapters/registry.js';
import { allowsSiteMessage, matchesSiteUrl, validateAdapterImplementation, validateSiteDefinitions } from '../src/site-adapters/registry-validation.js';
import { withReadDeadline } from '../src/site-adapters/read-errors.js';
import { readLimits } from '../src/site-adapters/read-policy.js';
import { createReadScheduler } from '../src/site-adapters/read-scheduler.js';
import { createBilibiliAdapter } from '../src/site-adapters/bilibili/adapter.js';
import { MemoryStorageArea } from '../src/credential-store.js';
import { envelope, video } from './fixtures/site-adapters/bilibili.js';
afterEach(() => vi.useRealTimers());
test('the host deadline settles a noncooperating read and ignores late completion', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  let complete!: (value: string) => void;
  const pending = withReadDeadline(() => new Promise<string>(resolve => { complete = resolve; }), { signal: new AbortController().signal, deadlineAt: 100 });
  const assertion = expect(pending).rejects.toThrow('timeout'); await vi.advanceTimersByTimeAsync(100); await assertion;
  complete('too late'); await Promise.resolve(); expect(vi.getTimerCount()).toBe(0);
});
test('cancellation interrupts noncooperating code and clears its deadline timer', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0); const controller = new AbortController();
  const pending = withReadDeadline(() => new Promise<never>(() => {}), { signal: controller.signal, deadlineAt: 1000 });
  const assertion = expect(pending).rejects.toThrow('cancelled'); controller.abort(); await assertion; expect(vi.getTimerCount()).toBe(0);
});
test('registry rejects duplicate identities and unsupported capabilities and verifies the actual implementation', () => {
  expect(() => validateSiteDefinitions([legacySite, { ...legacySite, adapterId: 'another-installation' }])).toThrow('invalidSiteRegistry');
  expect(() => validateSiteDefinitions([{ ...legacySite, capabilities: ['mountCaptureControl'] }])).toThrow('unsupportedHostCapability');
  expect(validateSiteDefinitions([{ ...legacySite, icon: { kind: 'favicon' } }])).toHaveLength(1);
  expect(validateSiteDefinitions([{ ...legacySite, icon: { kind: 'asset', path: 'icons/icon-32.png' } }])).toHaveLength(1);
  for (const icon of [{ kind: 'asset', path: '../icon.png' }, { kind: 'url', url: 'http://www.bilibili.com/favicon.ico' },
    { kind: 'data', dataUrl: 'data:text/html;base64,AAAA' }, { kind: 'favicon', extra: true }])
    expect(() => validateSiteDefinitions([{ ...legacySite, icon } as never])).toThrow('invalidSiteIcon');
  const adapter = createBilibiliAdapter(); validateAdapterImplementation(legacySite, adapter);
  expect(() => validateAdapterImplementation(legacySite, { ...adapter, readItemsPage: undefined })).toThrow('adapterCapabilityMismatch');
  expect(allowsSiteMessage({ ...legacySite, capabilities: [] }, { ...envelope, operation: 'item.result', resolutionId: 'read', result: { status: 'resolved', item: video } })).toBe(false);
});
test('sender matching honors exact granted paths and aliases without accepting another origin', () => {
  const site = { ...legacySite, matches: ['https://www.bilibili.com/video/*', 'https://space.bilibili.com/allowed/*'] };
  expect(matchesSiteUrl(site, 'https://www.bilibili.com/video/av1?x=1')).toBe(true);
  expect(matchesSiteUrl(site, 'https://space.bilibili.com/allowed/42')).toBe(true);
  for (const url of ['https://www.bilibili.com/account', 'https://space.bilibili.com/other', 'https://www.bilibili.com.evil.test/video/av1', 'https://user@www.bilibili.com/video/av1']) expect(matchesSiteUrl(site, url)).toBe(false);
});
test('an installation-specific pace survives scheduler reconstruction and cannot be configured outside host bounds', async () => {
  const policy = readLimits({ readPolicy: { spacingMs: 5000, commandMs: 10000 } }), area = new MemoryStorageArea(); let now = 0;
  const scheduler = () => createReadScheduler(area, 'policy', () => now, policy.spacingMs);
  await scheduler().acquire({ id: 'one', documentId: 'doc', deadlineAt: 10000 }); await scheduler().finish('one'); now = 4999;
  expect(await scheduler().acquire({ id: 'two', documentId: 'doc', deadlineAt: 15000 })).toMatchObject({ status: 'paused', retryAfterMs: 1 });
  expect(() => readLimits({ readPolicy: { commandMs: Infinity } })).toThrow('invalidReadPolicy');
});

test('a registered script ID does not hide stale origin grants or bundle paths after upgrade', () => {
  const desired = bundledScriptDefinitions(legacySite).find(s => s.world === 'ISOLATED')!;
  expect(sameScriptRegistration({ ...desired }, desired)).toBe(true);
  expect(sameScriptRegistration({ ...desired, matches: ['https://another.test/*'] }, desired)).toBe(false);
  expect(sameScriptRegistration({ ...desired, js: ['old.js'] }, desired)).toBe(false);
  expect(sameScriptRegistration({ ...desired, world: 'MAIN' }, desired)).toBe(false);
});

test('registration rejects unsupported collection models before starting a reader', () => {
  expect(() => validateSiteDefinitions([{ ...legacySite, collectionHierarchy: 'tree' as never }])).toThrow('unsupportedCollectionHierarchy');
  expect(() => validateSiteDefinitions([{ ...legacySite, membershipModel: 'orderedEntries' as never }])).toThrow('unsupportedMembershipModel');
  expect(() => validateSiteDefinitions([{ ...legacySite, capabilities: ['observeFavorites'], collectionSnapshot: 'pointInTime' }])).toThrow('unsupportedSnapshotCapability');
});
