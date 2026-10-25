import { test, expect, vi } from 'vitest';
import { createSiteTransport, initialTransportState, validSiteSender, type SiteSender } from '../src/site-adapters/transport.js';
import { envelope, observation } from './fixtures/site-adapters/bilibili.js';
function harness() {
  let state = initialTransportState(), now = 1000, permitted = true, current = true, n = 0;
  const sender: SiteSender = { id: 'ext', url: 'https://www.bilibili.com/video/av1', origin: 'https://www.bilibili.com', frameId: 0,
    documentId: 'doc', documentLifecycle: 'active', tab: { id: 1, incognito: false } };
  const deps = { extensionId: 'ext', now: () => now, random: () => `nonce-${++n}`, read: async () => structuredClone(state),
    write: async (s: typeof state) => { state = structuredClone(s); }, permitted: async () => permitted, current: async () => current ? sender.url! : null };
  const transport = createSiteTransport(deps);
  const hello = { protocolVersion: 1, operation: 'hello', runtime: 'bundled', activationId: 'activation-1', adapterId: 'bundled.bilibili', source: { state: 'signedIn', accountId: '42' } };
  const ready = async () => { await transport.configure(true); await transport.bootstrap(hello, sender); await transport.confirm('42');
    const lease = await transport.bootstrap(hello, sender); if (lease.status !== 'ready') throw Error('not ready'); return lease; };
  return { transport, deps, sender, hello, ready, state: () => state, advance: (ms: number) => { now += ms; }, expired: () => { now += 61000; }, revoke: () => { permitted = false; }, stale: () => { current = false; } };
}
test('strict browser sender scope rejects frames, spoofed origins, inactive and incognito documents', () => {
  const h = harness(); expect(validSiteSender(h.sender, 'ext')).toBe(true);
  for (const patch of [{ id: 'other' }, { frameId: 1 }, { documentId: undefined }, { documentLifecycle: 'prerender' },
    { origin: 'https://evil.example' }, { url: 'https://space.bilibili.com/' }, { tab: { id: 1, incognito: true } }])
    expect(validSiteSender({ ...h.sender, ...patch }, 'ext')).toBe(false);
});
test('new account needs explicit connection; one lease per generation and document survives worker reconstruction', async () => {
  const h = harness(); const l = await h.ready();
  expect(await h.transport.bootstrap(h.hello, h.sender)).toEqual(l);
  const restarted = createSiteTransport(h.deps);
  const m = { ...envelope, leaseId: l.leaseId, capability: l.capability, operation: 'emit', data: observation };
  expect(await restarted.authorize(m, h.sender)).not.toBeNull();
  await h.transport.bootstrap({ ...h.hello, source: { state: 'signedIn', accountId: '43' } }, h.sender);
  expect(await h.transport.authorize(m, h.sender)).toBeNull();
  await expect(h.transport.confirm('42')).rejects.toThrow('sourceUnresolved');
});
test('renewal before expiry rotates the old capability and provides another complete read window', async () => {
  const h = harness(), original = await h.ready(); h.advance(35000);
  const renewed = await h.transport.bootstrap(h.hello, h.sender); expect(renewed.status).toBe('ready'); if (renewed.status !== 'ready') throw Error('not ready');
  expect(renewed.leaseId).not.toBe(original.leaseId); expect(renewed.expiresAt).toBeGreaterThan(original.expiresAt);
  expect(await h.transport.authorize({ ...envelope, operation: 'connect', leaseId: original.leaseId, capability: original.capability }, h.sender)).toBeNull();
  expect(await h.transport.authorize({ ...envelope, operation: 'connect', leaseId: renewed.leaseId, capability: renewed.capability }, h.sender)).not.toBeNull();
});
test.each(['navigate', 'disable', 'expire', 'permission', 'document', 'signedOut'] as const)('%s fences old replies', async kind => {
  const h = harness(), l = await h.ready();
  const m = { ...envelope, leaseId: l.leaseId, capability: l.capability, operation: 'emit', data: observation };
  if (kind === 'navigate') await h.transport.invalidate(1);
  if (kind === 'disable') await h.transport.configure(false);
  if (kind === 'expire') h.expired();
  if (kind === 'permission') h.revoke();
  if (kind === 'document') h.stale();
  if (kind === 'signedOut') await h.transport.bootstrap({ ...h.hello, source: { state: 'signedOut' } }, h.sender);
  expect(await h.transport.authorize(m, h.sender)).toBeNull();
});
test('private capability and content identity cannot be replaced with authority claims', async () => {
  const h = harness(), l = await h.ready();
  expect(await h.transport.authorize({ ...envelope, leaseId: l.leaseId, operation: 'connect' }, h.sender)).toBeNull();
  expect(await h.transport.authorize({ ...envelope, leaseId: l.leaseId, capability: l.capability, operation: 'emit', data: {
    ...observation, item: { ...observation.item, id: 'video:av:99' } } }, h.sender)).toBeNull();
});

test('navigation ignores unrelated tabs, fences matching routes and removes closed or departed tabs', async () => {
  const h = harness(), lease = await h.ready(), write = vi.spyOn(h.deps, 'write');
  expect(await h.transport.navigate(99, 'https://other.example/')).toBe(false); expect(write).not.toHaveBeenCalled();
  expect(await h.transport.navigate(1, 'https://www.bilibili.com/video/av2')).toBe(true);
  expect(h.state().routes['1']).toBe(1); expect(h.state().leases).toHaveLength(0);
  expect(await h.transport.authorize({ ...envelope, leaseId: lease.leaseId, capability: lease.capability, operation: 'connect' }, h.sender)).toBeNull();
  await h.transport.navigate(1, 'https://other.example/'); expect(h.state().routes).toEqual({});
  await h.transport.bootstrap(h.hello, h.sender); await h.transport.removeTab(1); expect(h.state().routes).toEqual({}); expect(h.state().leases).toEqual([]);
  write.mockClear(); expect(await h.transport.removeTab(999)).toBe(false); expect(write).not.toHaveBeenCalled();
  await h.transport.configure(false); write.mockClear();
  expect(await h.transport.navigate(1, h.sender.url!)).toBe(false); expect(write).not.toHaveBeenCalled();
});
test('startup prunes old route leaks and preserves active tab epochs and leases', async () => {
  const h = harness(); await h.ready(); const state = await h.deps.read(); state.routes['999'] = 42; await h.deps.write(state);
  expect(await h.transport.pruneTabs([1])).toEqual([999]); expect(h.state().routes).toEqual({ '1': 0 }); expect(h.state().leases).toHaveLength(1);
  await h.transport.pruneTabs([]); expect(h.state().routes).toEqual({}); expect(h.state().leases).toHaveLength(0);
});
