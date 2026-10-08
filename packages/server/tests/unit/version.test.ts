import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'vitest';
import { collectionProtocolSchemas } from '@know-n/colp/schema';
import { version } from '../../src/version.js';
import { buildApiApp } from '../../src/transport/app.js';
import { loadConfig } from '../support/test-config.js';
import type { FastifyInstance } from 'fastify';

const require = createRequire(import.meta.url);
const openApps: FastifyInstance[] = [];

function packageJsonAbove(entry: string): string {
  let directory = dirname(entry);
  while (true) {
    const candidate = resolve(directory, 'package.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    assert.notEqual(parent, directory);
    directory = parent;
  }
}

function readPackageVersion(packageJsonPath: string): string {
  const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  assert.equal(typeof parsed, 'object');
  assert.notEqual(parsed, null);
  const versionField = (parsed as { version?: unknown }).version;
  if (typeof versionField !== 'string') throw new TypeError('package.json version is missing');
  return versionField;
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
});

test('generated version matches the server package and the installed @know-n/colp package', () => {
  const serverVersion = readPackageVersion(fileURLToPath(new URL('../../package.json', import.meta.url)));
  const colpVersion = readPackageVersion(packageJsonAbove(require.resolve('@know-n/colp')));
  assert.equal(version.server, serverVersion);
  assert.equal(version.colp, colpVersion);
  assert.deepEqual([...version.protocols], Object.keys(collectionProtocolSchemas));
});

test('health reports the version and ready stays a status', async () => {
  const app = buildApiApp({
    config: loadConfig({
      DATABASE_URL: 'postgres://localhost/known',
      LOG_LEVEL: 'silent',
      OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
    }),
    readiness: { verifyReady: async () => {} },
  });
  openApps.push(app);

  const health = await app.inject({ method: 'GET', url: '/health' });
  const ready = await app.inject({ method: 'GET', url: '/ready' });
  assert.equal(health.statusCode, 200);
  assert.deepEqual(health.json(), {
    status: 'ok',
    version: {
      server: version.server,
      colp: version.colp,
      protocols: [...version.protocols],
    },
  });
  assert.equal(ready.statusCode, 200);
  assert.deepEqual(ready.json(), { status: 'ready' });
});
