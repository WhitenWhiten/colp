import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  createHardenedEgressFetch,
  planHardenedEgressTarget,
} from '../../../src/infrastructure/egress/index.js';

const IPV4 = '93.184.216.34';
const IPV6 = '2606:2800:220:1:248:1893:25c8:1946';

test('planning prefers a public IPv4 pin when AAAA is listed first', async () => {
  const target = await planHardenedEgressTarget(
    'CIMD metadata',
    'https://cimd.example.test/.well-known/oauth-client',
    async () => [IPV6, IPV4],
  );
  assert.equal(target.ip, IPV4);
  assert.equal(target.family, 4);
});

test('planning still pins IPv6 when it is the only public family', async () => {
  const target = await planHardenedEgressTarget(
    'CIMD metadata',
    'https://cimd.example.test/.well-known/oauth-client',
    async () => [IPV6],
  );
  assert.equal(target.ip, IPV6);
  assert.equal(target.family, 6);
});

test('followRedirects false returns the 3xx and does not plan the next hop', async () => {
  const hostnames: string[] = [];
  const fetchImpl = createHardenedEgressFetch({
    followRedirects: false,
    resolve: async (hostname) => {
      hostnames.push(hostname);
      return [IPV4];
    },
    connect: async () => new Response(null, {
      status: 302,
      headers: { location: 'https://other.example.test/client.json' },
    }),
  });
  const response = await fetchImpl('https://cimd.example.test/.well-known/oauth-client');
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), 'https://other.example.test/client.json');
  assert.deepEqual(hostnames, ['cimd.example.test']);
});
