import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import type { Manifest } from '@know-n/colp/types';
import { SignJWT, exportJWK, generateKeyPair, type JSONWebKeySet } from 'jose';
import { createDatabaseRuntime, runMigrations } from '../src/infrastructure/database/index.js';
import { createPhase3SyncHttpHarness } from './evidence/phase3-sync-http-composition.js';
import { PHASE3_SYNC_ENDPOINT_KEYS } from './evidence/phase3-sync-http-composition.js';
import { createPhase3SyncDeploymentProbe } from './acceptance/phase3-sync-http-acceptance.js';
import { runPhase3SyncHttpAcceptance } from './acceptance/phase3-sync-http-acceptance.js';
import {
  createExtensionCredentialEvidenceVerifier,
  parseExtensionAuthConfig,
} from '../src/modules/identity/index.js';

export async function createPhase3SyncHttpAcceptanceProbe(
  options: { readonly env: NodeJS.ProcessEnv },
) {
  const databaseUrl = options.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required; P3-04 never skips PostgreSQL');
  const database = createDatabaseRuntime(databaseUrl, {
    maxConnections: 8,
    applicationName: 'known-phase3-sync-http-acceptance',
  });
  let harness: Awaited<ReturnType<typeof createPhase3SyncHttpHarness>> | undefined;
  try {
    await runMigrations(database.db, 'latest');
    const [manifestText, transportText, port] = await Promise.all([
      readFile(resolve('tests/fixtures/phase3/sync-http-manifest.json'), 'utf8'),
      readFile(resolve('tests/fixtures/phase3/sync-http-proxy.json'), 'utf8'),
      reservePort(),
    ]);
    const credential = await createCredentialFixture();
    const manifest = JSON.parse(manifestText) as Manifest;
    const transport = JSON.parse(transportText);
    harness = await createPhase3SyncHttpHarness({
      database,
      manifest,
      transport,
      listen: { host: '127.0.0.1', port },
      credential,
    });
    const probe = createPhase3SyncDeploymentProbe({
      runtimeOrigin: harness.origin,
      directRuntimeOrigin: harness.directOrigin,
      manifestUrl: `${harness.origin}/.well-known/collection-protocol`,
      fetch: harness.fetch,
      postgres: harness.postgresProbe,
      credentialAdapter: harness.credentialProbe,
      timeoutCancellation: harness.timeoutCancellationProbe,
    });
    return Object.freeze({
      probe,
      async verifyNegativeControls() {
        const passed: string[] = [];
        const expectRejected = async (label: string, action: () => Promise<unknown>) => {
          try { await action(); } catch { passed.push(label); return; }
          throw new Error(`negative control ${label} unexpectedly passed`);
        };
        await expectRejected('credential-adapter', async () => {
          const broken = createPhase3SyncDeploymentProbe({
            runtimeOrigin: harness!.origin, directRuntimeOrigin: harness!.directOrigin,
            manifestUrl: `${harness!.origin}/.well-known/collection-protocol`, fetch: harness!.fetch,
            postgres: harness!.postgresProbe,
            credentialAdapter: {
              authorization: harness!.credentialProbe.authorization,
              async verifyAvailability() { throw new Error('credential adapter unavailable'); },
            },
            timeoutCancellation: harness!.timeoutCancellationProbe,
          });
          await broken.run();
        });
        await expectRejected('postgres-connectivity', async () => {
          const broken = createPhase3SyncDeploymentProbe({
            runtimeOrigin: harness!.origin, manifestUrl: `${harness!.origin}/.well-known/collection-protocol`,
            fetch: harness!.fetch,
            postgres: {
              ...harness!.postgresProbe,
              async verifyProductionMigration() { throw new Error('PostgreSQL unavailable'); },
            },
            credentialAdapter: harness!.credentialProbe,
            timeoutCancellation: harness!.timeoutCancellationProbe,
          });
          await broken.run();
        });
        await expectRejected('production-migration', async () => {
          const broken = createPhase3SyncDeploymentProbe({
            runtimeOrigin: harness!.origin, manifestUrl: `${harness!.origin}/.well-known/collection-protocol`,
            fetch: harness!.fetch,
            postgres: {
              ...harness!.postgresProbe,
              async verifyProductionMigration() { return { migration: 'stale-migration' }; },
            },
            credentialAdapter: harness!.credentialProbe,
            timeoutCancellation: harness!.timeoutCancellationProbe,
          });
          await broken.run();
        });
        const deadPort = await reservePort();
        await expectRejected('runtime-port', async () => {
          const deadOrigin = `http://127.0.0.1:${deadPort}`;
          const broken = createPhase3SyncDeploymentProbe({
            runtimeOrigin: deadOrigin, manifestUrl: `${deadOrigin}/.well-known/collection-protocol`,
            fetch, postgres: harness!.postgresProbe, credentialAdapter: harness!.credentialProbe,
            timeoutCancellation: harness!.timeoutCancellationProbe,
          });
          await broken.run();
        });
        for (const key of PHASE3_SYNC_ENDPOINT_KEYS) {
          const brokenHarness = await createPhase3SyncHttpHarness({
            database, manifest, transport, credential, omittedEndpoint: key,
            listen: { host: '127.0.0.1', port: await reservePort() },
          });
          try {
            const broken = createPhase3SyncDeploymentProbe({
              runtimeOrigin: brokenHarness.origin, directRuntimeOrigin: brokenHarness.directOrigin,
              manifestUrl: `${brokenHarness.origin}/.well-known/collection-protocol`, fetch: brokenHarness.fetch,
              postgres: brokenHarness.postgresProbe, credentialAdapter: brokenHarness.credentialProbe,
              timeoutCancellation: brokenHarness.timeoutCancellationProbe,
            });
            await expectRejected(`mounted-route:${key}`, () => runPhase3SyncHttpAcceptance(broken));
          } finally { await brokenHarness.close(); }
        }
        return Object.freeze(passed);
      },
      async close() {
        await harness?.close();
        await database.close();
      },
    });
  } catch (error) {
    await harness?.close();
    await database.close();
    throw error;
  }
}

export async function createCredentialFixture() {
  const configText = await readFile(resolve('tests/fixtures/phase3/extension-auth.json'), 'utf8');
  const config = parseExtensionAuthConfig(JSON.parse(configText));
  const now = new Date();
  const keyPair = await generateKeyPair('RS256', { extractable: true });
  const publicJwk = await exportJWK(keyPair.publicKey);
  const jwks: JSONWebKeySet = { keys: [{ ...publicJwk, kid: 'phase3-sync-http', alg: 'RS256', use: 'sig' }] };
  const token = await new SignJWT({
    scope: 'known.sync', client_id: config.clientId,
  }).setProtectedHeader({ alg: 'RS256', kid: 'phase3-sync-http' })
    .setIssuer(config.issuer).setAudience(config.audience)
    .setSubject('EREREREREREREREREREREQ').setJti('phase3-sync-http-token')
    .setIssuedAt(Math.floor(now.getTime() / 1_000))
    .setExpirationTime(Math.floor(now.getTime() / 1_000) + 300)
    .sign(keyPair.privateKey);
  const verifier = createExtensionCredentialEvidenceVerifier({
    config, requiredScopes: ['known.sync'], now: () => now,
    jwks: { async getKeySet() { return jwks; } },
    async isRevoked() { return false; },
  });
  return Object.freeze({ authorization: `Bearer ${token}`, verifier });
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to reserve a runtime port');
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => error ? reject(error) : resolveClose()));
  return address.port;
}
