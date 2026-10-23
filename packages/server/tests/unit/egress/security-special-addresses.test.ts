import { describe, expect, it, vi } from 'vitest';
import { assertOidcEndpointUrl } from '../../../src/bootstrap/oidc-endpoint-policy.js';
import {
  classifyEgressAddress,
  createHardenedEgressFetch,
} from '../../../src/infrastructure/egress/hardened-egress.js';

describe('security scan: non-global egress addresses', () => {
  it('classifies every member of 192.0.0.0/24 with only the IANA global exceptions', () => {
    for (let last = 0; last < 256; last += 1) {
      expect(classifyEgressAddress(`192.0.0.${last}`)).toBe(
        last === 9 || last === 10 ? 'public' : 'denied',
      );
    }
  });

  it.each([
    '168.63.129.16', '169.254.169.254', '::ffff:168.63.129.16',
    '100::1', '0100:0000:0000:0000:0000:0000:0000:0001',
    '100:0:0:1::1', '5f00::1', '4000::1', '8000::1',
    '2001::1', '2001:0:0:0:0:0:0:1', '2001:1ff::1',
    '2001:db8::1', '2002::1', '3fff::1', '3fff:fff::1',
    '::ffff:8.8.8.8', '::ffff:192.0.0.8', '::ffff:c000:8',
    '0:0:0:0:0:ffff:c000:8', '64:ff9b::808:808', '64:ff9b:1::1',
    '::', '::1', 'fc00::1', 'fe80::1', 'ff02::1',
    '2606:4700:4700::1111%eth0', 'not-an-address',
  ])('denies %s including expanded and compressed spellings', (address) => {
    expect(classifyEgressAddress(address)).toBe('denied');
  });

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888'])
    ('preserves public destination %s', (address) => {
      expect(classifyEgressAddress(address)).toBe('public');
    });

  it.each(['192.0.0.8', '192.0.0.170', '100::1', '2001::1', '5f00::1', '168.63.129.16'])
    ('does not connect when a DNS answer mixes public and denied addresses: %s', async (address) => {
      const connect = vi.fn(async () => new Response('never'));
      const fetch = createHardenedEgressFetch({
        resolve: async () => ['8.8.8.8', address],
        connect,
      });
      await expect(fetch('https://public.example.com/item')).rejects.toMatchObject({
        reason: 'denied_address',
      });
      expect(connect).not.toHaveBeenCalled();
    });

  it.each(['strict', 'relaxed'] as const)('denies Azure platform literals in %s OIDC policy', mode => {
    expect(() => assertOidcEndpointUrl('issuer', 'https://168.63.129.16/machine', mode)).toThrow(/metadata/u);
  });

  it.each(['https://168.63.129.16/machine', 'http://168.63.129.16/machine', 'https://0xa83f8110/machine'])
    ('blocks Azure WireServer before DNS or connection: %s', async target => {
      const resolve = vi.fn(async () => ['8.8.8.8']); const connect = vi.fn(async () => new Response('never'));
      const fetch = createHardenedEgressFetch({ resolve, connect, allowPublicHttp: true });
      await expect(fetch(target)).rejects.toMatchObject({ reason: 'denied' });
      expect(resolve).not.toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled();
    });

  it('revalidates redirects to Azure platform services before connecting again', async () => {
    const connect = vi.fn(async () => new Response(null, { status: 302,
      headers: { location: 'http://168.63.129.16/machine' } }));
    const fetch = createHardenedEgressFetch({ resolve: async () => ['8.8.8.8'], connect, allowPublicHttp: true });
    await expect(fetch('https://public.example.com/')).rejects.toMatchObject({ reason: 'denied' });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(classifyEgressAddress('168.63.129.15')).toBe('public');
    expect(classifyEgressAddress('168.63.129.17')).toBe('public');
  });
});
