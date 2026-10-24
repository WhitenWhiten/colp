import 'fake-indexeddb/auto';
import { afterEach, expect, test, vi } from 'vitest';
import { Script } from 'node:vm';
import { MemoryStorageArea } from '../src/credential-store.js';
import { inspectCommunityPackage } from '../src/site-adapters/community-package.js';
import { communityWrapper } from '../src/site-adapters/community-wrapper.js';
import { communityStore, communityWorldId, type CommunityInstallation } from '../src/site-adapters/community-state.js';
import { communityRegistration, communityRegistrationMatches } from '../src/site-adapters/community-registration.js';
import { createCommunityRuntime } from '../src/site-adapters/community-runtime.js';
import { assertCommunityArchive } from '../src/site-adapters/community-authority.js';
import { siteLedger } from '../src/site-adapters/source-runtime.js';
import { SOURCE_STORES } from '../src/site-adapters/source-db.js';
import type { SourceContext } from '../src/site-adapters/ledger-types.js';

function packageText(version = '1.0.0', script = 'globalThis.mustNotExecute = true;') {
  return JSON.stringify({ manifest: { apiVersion: 'known.site-adapter/v1', adapterId: 'community.test', version, siteKey: 'bilibili', identityVersion: 1,
    matches: ['https://www.bilibili.com/*'], execution: { mode: 'userScript', entry: 'adapter.js', runAt: 'document_start' }, capabilities: ['observeFavorites'] },
  provenance: { maintainer: 'Fixture author (unverified)', sourceUrl: 'https://example.test/source', revision: 'local' }, script });
}
afterEach(async () => { await siteLedger.db.close(); vi.unstubAllGlobals(); });
async function fixture() {
  const local = new MemoryStorageArea(), session = new MemoryStorageArea(), scripts = new Map<string, chrome.userScripts.Script>(), worlds = new Map<string, any>();
  let available = true;
  vi.stubGlobal('navigator', { userAgent: 'Chrome/149.0.7827.0' });
  const frame = { url: 'https://www.bilibili.com/video/av1', documentId: 'doc', documentLifecycle: 'active' };
  const source: SourceContext = { connectionId: 'connection', documentId: 'doc', tabId: 1, leaseId: 'bundled-lease', routeEpoch: 0, installationGeneration: 7, sourceSessionGeneration: 3 };
  const enqueue = vi.fn(async () => ({ status: 'accepted' }));
  vi.stubGlobal('chrome', { storage: { local, session }, runtime: { id: 'extension', getManifest: () => ({ version: '0.1.2' }) }, permissions: { contains: async () => true },
    tabs: { query: async () => [] }, bookmarks: { get: async (id: string) => [{ id, title: id === 'root' ? 'Root' : 'Bar', parentId: id === 'root' ? '1' : '0', dateAdded: 1 }] }, webNavigation: { getFrame: async () => frame }, userScripts: {
      getScripts: vi.fn(async () => { if (!available) throw new Error('toggle off'); return [...scripts.values()].map(v => structuredClone(v)); }),
      register: vi.fn(async (values: chrome.userScripts.Script[]) => { for (const value of values) scripts.set(value.id, structuredClone(value)); }),
      unregister: vi.fn(async (filter: { ids: string[] }) => { for (const id of filter.ids) scripts.delete(id); }),
      configureWorld: vi.fn(async (value: { worldId: string }) => { worlds.set(value.worldId, value); }),
      resetWorldConfiguration: vi.fn(async (id: string) => { worlds.delete(id); }), getWorldConfigurations: async () => [...worlds.values()],
      execute: vi.fn(async () => []),
    } });
  const runtime = createCommunityRuntime({ ready: async () => {}, source: async () => ({ context: source, expiresAt: Date.now() + 60000 }), enqueue, wake() {} });
  await siteLedger.db.transaction(SOURCE_STORES, 'readwrite', async tx => { for (const name of SOURCE_STORES) tx.objectStore(name).clear(); });
  const call = (r: unknown): Promise<any> => runtime.management(r);
  const install = async (text = packageText()) => { const preview = await call({ kind: 'known.community.preview', text });
    return call({ kind: 'known.community.install', digest: preview.preview.digest, acknowledgeRisk: true }); };
  const sender = { id: 'extension', url: frame.url, origin: 'https://www.bilibili.com', documentId: 'doc', frameId: 0, documentLifecycle: 'active', tab: { id: 1, incognito: false } };
  const row = async () => (await communityStore.read())[0]!;
  const enable = async () => { await call({ kind: 'known.community.enable', installationId: (await row()).id, enabled: true }); return row(); };
  const hello = (r: CommunityInstallation) => ({ kind: 'known.community.bootstrap', installationId: r.id, generation: r.generation, credential: r.credential });
  const boot = async (r = undefined as CommunityInstallation | undefined): Promise<any> => runtime.message(hello(r ?? await row()), sender);
  const hint = (r: CommunityInstallation, lease: any, added = ['101']) => ({ kind: 'known.community.hint', installationId: r.id, generation: r.generation,
    leaseId: lease.leaseId, capability: lease.capability, requestId: crypto.randomUUID(), hint: { interactionId: 'event', itemId: 'video:av:1', added, removed: [], code: 0 } });
  return { local, scripts, worlds, frame, source, enqueue, runtime, call, install, row, enable, sender, boot, hello, hint, toggle: (v: boolean) => { available = v; } };
}
test('package inspection is inert and hashes exact bytes; unsupported authority and provenance fields fail closed', () => {
  const text = packageText(), p = inspectCommunityPackage(text);
  expect((globalThis as any).mustNotExecute).toBeUndefined(); expect(p.digest).not.toBe(inspectCommunityPackage(text + '\n').digest);
  expect(() => inspectCommunityPackage('\ufeff' + text)).toThrow('packageInvalid');
  expect(() => inspectCommunityPackage(text.replace('Fixture author', '\ud800'))).toThrow('packageInvalidEncoding');
  const value = JSON.parse(text);
  for (const manifest of [{ ...value.manifest, official: true }, { ...value.manifest, bundledProbeIds: ['probe'] },
    { ...value.manifest, capabilities: ['mountCaptureControl'] }, { ...value.manifest, identityVersion: 2 },
    { ...value.manifest, matches: ['https://*/*'] }, { ...value.manifest, execution: { ...value.manifest.execution, mode: 'bundled' } }])
    expect(() => inspectCommunityPackage(JSON.stringify({ ...value, manifest }))).toThrow('packageUnsupported');
  expect(() => inspectCommunityPackage(JSON.stringify({ ...value, provenance: { ...value.provenance, revision: 'main' } }))).toThrow('packageUnsupported');
  expect(() => inspectCommunityPackage(JSON.stringify({ ...value, provenance: { ...value.provenance, sourceUrl: 'https://x.test/?secret=bad' } }))).toThrow('packageUnsupported');
  expect(() => inspectCommunityPackage(' '.repeat(512 * 1024 + 1))).toThrow('packageTooLarge');
  const wrapper = communityWrapper({ id: 'i', generation: 1, credential: 'private-world-credential', script: p.package.script }); new Script(wrapper);
  expect(wrapper).not.toMatch(/window\.postMessage|chrome\.(storage|bookmarks)|new Function|eval\(/);
});
test('reviewed bytes persist disabled before registration; named worlds and authored bytes cannot be widened or mutated', async () => {
  const f = await fixture(); const installed = await f.install(); expect(installed.installations[0].enabled).toBe(false); expect(f.scripts.size).toBe(0);
  const row = await f.enable(), registered = [...f.scripts.values()][0]!;
  expect(registered).toMatchObject({ world: 'USER_SCRIPT', worldId: communityWorldId(row), allFrames: false, matches: ['https://www.bilibili.com/*'] });
  expect(communityRegistrationMatches(row, [registered])).toBe(true);
  expect(communityRegistrationMatches(row, [{ ...registered, matches: ['https://*/*'] }])).toBe(false);
  expect(communityRegistrationMatches(row, [{ ...registered, js: [...registered.js!, { code: 'unreviewed()' }] }])).toBe(false);
  row.approved.package.script = 'tampered()'; expect(() => communityRegistration(row)).toThrow('communityPackageChanged');
  expect(JSON.stringify(installed)).not.toContain(row.credential); expect(f.enqueue).not.toHaveBeenCalled();
});
test('bootstrap validates actual sender and private installation credential; inspector reports never enqueue source work', async () => {
  const f = await fixture(); await f.install(); const row = await f.enable(), lease = await f.boot();
  expect(lease).toMatchObject({ status: 'ready', mode: 'inspector' });
  await expect(f.runtime.message({ ...f.hello(row), credential: 'forged' }, f.sender)).rejects.toThrow('communityCredentialRejected');
  for (const sender of [{ ...f.sender, frameId: 1 }, { ...f.sender, documentLifecycle: 'prerender' }, { ...f.sender, origin: 'https://attacker.test' }, { ...f.sender, tab: { id: 1, incognito: true } }])
    expect(await f.runtime.message(f.hello(row), sender)).toMatchObject({ status: 'rejected', reason: 'sender' });
  expect(await f.runtime.message({ ...f.hello(row), worldId: communityWorldId(row) }, f.sender)).toMatchObject({ status: 'rejected', reason: 'invalid' });
  expect(await f.runtime.message(f.hint(row, lease), f.sender)).toEqual({ status: 'inspected', writes: false, models: false }); expect(f.enqueue).not.toHaveBeenCalled();
  expect(JSON.stringify(await f.call({ kind: 'known.community.status' }))).not.toContain(lease.capability);
  f.frame.url = 'https://www.bilibili.com/video/av2'; await expect(f.runtime.message(f.hint(row, lease), f.sender)).rejects.toThrow('communityLeaseRejected');
});
test('disable, byte update, rollback and extension update rotate credentials and never inherit archive authority', async () => {
  const f = await fixture(); await f.install(); const old = await f.enable(), lease = await f.boot();
  await f.call({ kind: 'known.community.enable', installationId: old.id, enabled: false });
  await expect(f.runtime.message(f.hint(old, lease), f.sender)).rejects.toThrow('communityRevoked');
  const enabled = await f.enable(); expect(enabled.credential).not.toBe(old.credential);
  await f.install(packageText('2.0.0', 'globalThis.versionTwo=true;')); const updated = await f.row(); expect(updated.enabled).toBe(false); expect(updated.archive).toBeNull();
  expect(updated.previous[0]?.digest).toBe(old.approved.digest); await expect(f.boot(old)).rejects.toThrow('communityRevoked');
  await expect(f.call({ kind: 'known.community.rollback', installationId: old.id, digest: old.approved.digest, acknowledgeRisk: true })).rejects.toThrow('communityPreviewExpired');
  await f.call({ kind: 'known.community.reviewVersion', installationId: old.id, digest: old.approved.digest });
  await f.call({ kind: 'known.community.rollback', installationId: old.id, digest: old.approved.digest, acknowledgeRisk: true });
  const rollback = await f.enable();
  vi.spyOn(chrome.runtime, 'getManifest').mockReturnValue({ version: '0.1.3' });
  await expect(f.boot(rollback)).rejects.toThrow('communityRevoked'); // Before the update event can re-register anything.
  await f.runtime.reconcile(true); const after = await f.row();
  expect(after.enabled).toBe(true); expect(after.archive).toBeNull(); expect(after.generation).toBeGreaterThan(rollback.generation); expect(after.credential).not.toBe(rollback.credential);
  expect(communityRegistrationMatches(after, [...f.scripts.values()])).toBe(true);
});
test('toggle revocation works even while the API object remains defined; bounded rate survives worker reconstruction', async () => {
  const f = await fixture(); await f.install(); const old = await f.enable(), lease = await f.boot();
  f.toggle(false); await expect(f.runtime.message(f.hint(old, lease), f.sender)).rejects.toThrow('communityToggleRequired');
  expect((await f.row()).enabled).toBe(false); expect((await f.row()).generation).toBeGreaterThan(old.generation);
  f.toggle(true); await expect(f.runtime.message(f.hint(old, lease), f.sender)).rejects.toThrow('communityRevoked');
  const row = await f.enable(), fresh = await f.boot();
  for (let i = 0; i < 14; i++) await f.runtime.message(f.hint(row, fresh), f.sender);
  // The first bootstrap before revocation is retained in the same persisted minute budget.
  await expect(f.runtime.message(f.hint(row, fresh), f.sender)).rejects.toThrow('communityRateLimited');
});
test('archive hints require exact reviewed source/root/collection scope and a still-current policy at native authorization', async () => {
  const f = await fixture(); await f.install(); const row = await f.enable();
  await siteLedger.db.transaction(['meta', 'authorities'], 'readwrite', async tx => {
    tx.objectStore('meta').put({ root: { nativeId: 'root' }, collectionIds: ['101'], live: true, state: 'active' }, 'archiveConfig:connection');
    tx.objectStore('meta').put({ enabled: true, liveArchive: true, policy: { revision: 4 } }, 'policy:connection');
    tx.objectStore('authorities').put({ enabled: true, connectionId: 'connection', accountId: '42', installationGeneration: 7, sourceSessionGeneration: 3 }, 'bundled.bilibili');
  });
  const p = await f.call({ kind: 'known.community.scopePreview', installationId: row.id });
  await expect(f.call({ kind: 'known.community.scopeApprove', installationId: row.id, digest: 'different' })).rejects.toThrow('communityScopeStale');
  await f.call({ kind: 'known.community.scopeApprove', installationId: row.id, digest: p.preview.digest });
  const lease = await f.boot(), current = await f.row();
  expect(await f.runtime.message(f.hint(current, lease), f.sender)).toEqual({ status: 'accepted' }); expect(f.enqueue).toHaveBeenCalledTimes(1);
  const origin = (f.enqueue.mock.calls[0] as unknown as [SourceContext])[0].communityOrigin!;
  await assertCommunityArchive(origin, { connectionId: 'connection', collectionIds: ['101'], rootNativeId: 'root' });
  await expect(assertCommunityArchive(origin, { connectionId: 'connection', collectionIds: ['102'], rootNativeId: 'root' })).rejects.toThrow('communityArchiveRevoked');
  await expect(assertCommunityArchive(origin, { connectionId: 'connection', collectionIds: ['101'], rootNativeId: 'other' })).rejects.toThrow('communityArchiveRevoked');
  await siteLedger.db.transaction(['meta'], 'readwrite', async tx => { tx.objectStore('meta').put({ enabled: true, liveArchive: true, policy: { revision: 5 } }, 'policy:connection'); });
  await expect(assertCommunityArchive(origin, { connectionId: 'connection', collectionIds: ['101'] })).rejects.toThrow('communityArchiveScopeChanged');
});
test('disable persists its fence while a page operation is hung and late attachment cannot revive it', async () => {
  const f = await fixture(); await f.install(); const old = await f.row();
  let release!: () => void, reached!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { reached = resolve; });
  vi.spyOn(chrome.tabs, 'query').mockResolvedValue([{ id: 1, url: f.frame.url }]);
  vi.spyOn(chrome.userScripts, 'execute').mockImplementation(async () => { reached(); await held; return []; });
  const enable = f.call({ kind: 'known.community.enable', installationId: old.id, enabled: true }); await started;
  expect(await f.call({ kind: 'known.community.enable', installationId: old.id, enabled: false })).toEqual({ ok: true, fenced: true });
  expect((await f.row()).enabled).toBe(false); release(); await enable;
  await expect(f.boot(old)).rejects.toThrow('communityRevoked'); expect(f.enqueue).not.toHaveBeenCalled();
});
