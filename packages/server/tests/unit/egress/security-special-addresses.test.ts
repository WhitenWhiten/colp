import { describe, expect, it, vi } from 'vitest';
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

  it.each(['192.0.0.8', '192.0.0.170', '100::1', '2001::1', '5f00::1'])
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
});
