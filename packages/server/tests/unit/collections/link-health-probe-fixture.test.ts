import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { HardenedEgressError } from '../../../src/infrastructure/egress/index.js';
import {
  createLinkHealthProbeFixtureFromFile,
  linkHealthProbeInjectionFromEnv,
} from '../../../src/infrastructure/collections/link-health-probe-fixture.js';

const PUBLIC_PIN = '1.1.1.1';
const HEALTHY = 'https://lh-healthy.example.test/same';
const REDIRECT_FROM = 'https://lh-redirect.example.test/from';
const REDIRECT_TO = 'https://lh-redirect.example.test/to';
const DENIED = 'https://lh-denied.example.test/private';

function writeFixture(): string {
  const directory = mkdtempSync(join(tmpdir(), 'lh-probe-'));
  const path = join(directory, 'fixture.json');
  writeFileSync(path, JSON.stringify({
    pin: PUBLIC_PIN,
    scripts: {
      [HEALTHY]: { status: 200 },
      [REDIRECT_FROM]: { status: 301, location: REDIRECT_TO },
      [REDIRECT_TO]: { status: 200 },
      [DENIED]: { status: 200, denied: true },
      'https://lh-timeout.example.test/slow': { status: 200, timeout: true },
      'https://lh-tls.example.test/cert': { status: 200, tls: true },
    },
  }));
  return path;
}

test('fixture injection is inert without the env and refused in production', () => {
  assert.equal(linkHealthProbeInjectionFromEnv({}, 'test'), undefined);
  assert.throws(
    () => linkHealthProbeInjectionFromEnv({ KNOWN_LINK_HEALTH_PROBE_FIXTURE: '/tmp/x.json' }, 'production'),
    /not allowed in production/u,
  );
});

test('file fixture resolves a public pin and maps URL scripts without opening sockets', async () => {
  const path = writeFixture();
  const injection = createLinkHealthProbeFixtureFromFile(path);
  assert.deepEqual(await injection.resolve!('lh-healthy.example.test'), [PUBLIC_PIN]);
  const healthy = await injection.connect!({
    url: new URL(HEALTHY), ip: PUBLIC_PIN, family: 4,
  }, { method: 'HEAD' });
  assert.equal(healthy.status, 200);
  const redirect = await injection.connect!({
    url: new URL(REDIRECT_FROM), ip: PUBLIC_PIN, family: 4,
  }, { method: 'HEAD' });
  assert.equal(redirect.status, 301);
  assert.equal(redirect.headers.get('location'), REDIRECT_TO);
  const missing = await injection.connect!({
    url: new URL('https://lh-missing.example.test/none'), ip: PUBLIC_PIN, family: 4,
  }, { method: 'HEAD' });
  assert.equal(missing.status, 404);
  await assert.rejects(
    () => injection.connect!({
      url: new URL(DENIED), ip: PUBLIC_PIN, family: 4,
    }, { method: 'HEAD' }),
    (error: unknown) => error instanceof HardenedEgressError && error.reason === 'denied_address',
  );
  await assert.rejects(
    () => injection.connect!({
      url: new URL('https://lh-timeout.example.test/slow'), ip: PUBLIC_PIN, family: 4,
    }, { method: 'HEAD' }),
    (error: unknown) => error instanceof Error && error.name === 'AbortError',
  );
  await assert.rejects(
    () => injection.connect!({
      url: new URL('https://lh-tls.example.test/cert'), ip: PUBLIC_PIN, family: 4,
    }, { method: 'HEAD' }),
    (error: unknown) => error instanceof Error
      && (error as { code?: string }).code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  );
});
