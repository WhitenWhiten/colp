import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'vitest';
import { HardenedEgressError } from '../../../src/infrastructure/egress/index.js';
import { createProductionCimdFetch } from '../../../src/infrastructure/auth/cimd-node-fetch.js';

const PUBLIC_CIMD = 'https://cimd.example.test/.well-known/oauth-client';

test('production runtime wires the hardened CIMD fetch, not @better-auth/cimd/node', () => {
  const source = readFileSync(
    resolve(import.meta.dirname, '../../../src/infrastructure/auth/better-auth-runtime.ts'),
    'utf8',
  );
  assert.match(source, /fetchProductionClientMetadataResource/);
  assert.match(source, /wrapCimdClientDiscoveryWithLoopbackRedirectVariance/);
  assert.match(source, /createCimdClientDiscovery/);
  assert.doesNotMatch(source, /@better-auth\/cimd\/node/);
});

test('CIMD transport accepts HTTPS GET and HEAD and leaves redirects with the caller', async () => {
  const calls: Array<{ readonly href: string; readonly method: string | undefined }> = [];
  const fetchImpl = createProductionCimdFetch(async (input, init) => {
    const url = typeof input === 'string' || input instanceof URL ? new URL(String(input)) : new URL(input.url);
    calls.push({ href: url.href, method: init?.method });
    return new Response(null, { status: 302, headers: { location: 'https://evil.example.test/' } });
  });
  const redirected = await fetchImpl(PUBLIC_CIMD);
  assert.equal(redirected.status, 302);
  assert.equal(redirected.headers.get('location'), 'https://evil.example.test/');
  const headed = await fetchImpl(PUBLIC_CIMD, { method: 'HEAD' });
  assert.equal(headed.status, 302);
  assert.deepEqual(calls, [
    { href: PUBLIC_CIMD, method: 'GET' },
    { href: PUBLIC_CIMD, method: 'HEAD' },
  ]);
});

test('CIMD transport refuses HTTP, POST, and hardened-egress denials without echoing targets', async () => {
  const fetchImpl = createProductionCimdFetch(async () => {
    throw new Error('connect must not run');
  });
  await assert.rejects(
    fetchImpl('http://cimd.example.test/.well-known/oauth-client'),
    (error: unknown) => error instanceof TypeError && error.message.includes('HTTPS'),
  );
  await assert.rejects(
    fetchImpl(PUBLIC_CIMD, { method: 'POST' }),
    (error: unknown) => error instanceof TypeError && error.message.includes('GET and HEAD'),
  );

  const denied = createProductionCimdFetch(async () => {
    throw new HardenedEgressError('denied_address', 'CIMD metadata resolves to a disallowed address');
  });
  await assert.rejects(denied(PUBLIC_CIMD), (error: unknown) => {
    assert.ok(error instanceof TypeError);
    assert.equal(error.message.includes('10.'), false);
    assert.match(error.message, /refused the metadata hostname/);
    return true;
  });
});
