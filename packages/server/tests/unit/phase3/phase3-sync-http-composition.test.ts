import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, test, vi } from 'vitest';
import type { Manifest } from '@know-n/colp/types';
import Fastify from 'fastify';
import { createTrustedIngressMatcher } from '../../../src/bootstrap/trusted-ingress.js';
import { createSyncTransportSecurity } from '../../../src/transport/colp-sync/sync-transport-security.js';
import { registerSyncSessionRoutes } from '../../../src/transport/colp-sync/sync-session-routes.js';
import {
  PHASE3_SYNC_ENDPOINT_KEYS,
  createPhase3SyncEndpointComposition,
  createPhase3SyncTransportGuard,
  phase3SyncProblem,
} from '../../../scripts/evidence/phase3-sync-http-composition.js';
import {
  createPhase3SyncDeploymentProbe,
  runPhase3SyncHttpAcceptance,
} from '../../../scripts/acceptance/phase3-sync-http-acceptance.js';
import { mintVerifiedExtensionCredentialFixture } from '../../support/extension-credential.js';

const fixturePath = resolve('tests/fixtures/phase3/sync-http-manifest.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Manifest;
const proxyFixture = JSON.parse(readFileSync(
  resolve('tests/fixtures/phase3/sync-http-proxy.json'),
  'utf8',
));

describe('P3-04 Manifest-only endpoint composition', () => {
  test('discovers exactly six registry-backed endpoint contracts without claiming sync', () => {
    const composition = createPhase3SyncEndpointComposition(fixture, {
      manifestUrl: 'https://sync.example.test/.well-known/collection-protocol',
      mountId: 'known-sync-entry',
      allowedEndpointOrigins: ['https://sync-edge.example.test'],
    });
    assert.deepEqual(Object.keys(composition.endpoints), [...PHASE3_SYNC_ENDPOINT_KEYS]);
    assert.equal(composition.profileClaimed, false);
    assert.equal(composition.maxBatchOperations, 1);
    assert.equal(composition.endpoints.syncConflict.variables[0], 'conflictId');
    assert.equal(composition.endpoints.syncPush.requestSchema, 'syncPush');
    assert.equal(composition.endpoints.syncPush.responseSchema, 'syncPushResult');
    assert.equal(composition.endpoints.syncPull.url.origin, 'https://sync-edge.example.test');
  });

  test.each(PHASE3_SYNC_ENDPOINT_KEYS)('fails closed when %s is absent', (key) => {
    const candidate = structuredClone(fixture);
    delete candidate.mounts[0]!.endpoints[key];
    assert.throws(
      () => createPhase3SyncEndpointComposition(candidate, {
        manifestUrl: 'https://sync.example.test/.well-known/collection-protocol',
        mountId: 'known-sync-entry',
        allowedEndpointOrigins: ['https://sync-edge.example.test'],
      }),
      new RegExp(`Manifest endpoint ${key} is missing`, 'u'),
    );
  });

  test('rejects wrong URI Template variables, insecure origins, and unlisted origins', () => {
    const wrongVariable = structuredClone(fixture);
    wrongVariable.mounts[0]!.endpoints.syncConflict =
      'https://sync.example.test/private-entry/conflicts/{collectionId}/decision' as never;
    assert.throws(() => createPhase3SyncEndpointComposition(wrongVariable, {
      manifestUrl: 'https://sync.example.test/.well-known/collection-protocol',
      mountId: 'known-sync-entry', allowedEndpointOrigins: ['https://sync-edge.example.test'],
    }), /syncConflict.*variables/u);

    for (const value of [
      'http://sync.example.test/private-entry/operation-ingress',
      'https://unlisted.example.test/private-entry/operation-ingress',
    ]) {
      const candidate = structuredClone(fixture);
      candidate.mounts[0]!.endpoints.syncPush = value as never;
      assert.throws(() => createPhase3SyncEndpointComposition(candidate, {
        manifestUrl: 'https://sync.example.test/.well-known/collection-protocol',
        mountId: 'known-sync-entry', allowedEndpointOrigins: ['https://sync-edge.example.test'],
      }), /https|allowlist/u);
    }
  });
});

describe('P3-04 raw transport admission', () => {
  const guard = createPhase3SyncTransportGuard(proxyFixture);

  test.each(['Authorization', 'Idempotency-Key', 'If-Match'])
  ('rejects duplicate raw %s fields before normalized headers', (name) => {
    const values: Record<string, string> = {
      Authorization: 'Bearer one', 'Idempotency-Key': 'one', 'If-Match': '"one"',
    };
    const rawHeaders = Object.entries(values).flatMap(([field, value]) => [field, value]);
    rawHeaders.push(name.toLowerCase(), name === 'Authorization' ? 'Bearer two' : 'two');
    assert.throws(() => guard.admitHeaders({
      endpointKey: 'syncConflict', rawHeaders, peerAddress: '127.0.0.1', encrypted: true,
    }), new RegExp(`exactly one ${name}`, 'iu'));
  });

  test('requires TLS evidence from a trusted ingress and rejects spoofed forwarded headers', () => {
    assert.doesNotThrow(() => guard.admitHeaders({
      endpointKey: 'syncPush',
      rawHeaders: ['Authorization', 'Bearer token', 'Idempotency-Key', 'batch', 'X-Forwarded-Proto', 'https',
        'X-Known-Ingress-Proof', 'phase3-controlled-ingress-v1'],
      peerAddress: '127.0.0.1', encrypted: false,
    }));
    assert.throws(() => guard.admitHeaders({
      endpointKey: 'syncPush',
      rawHeaders: ['Authorization', 'Bearer token', 'Idempotency-Key', 'batch', 'X-Forwarded-Proto', 'https'],
      peerAddress: '203.0.113.19', encrypted: false,
    }), /trusted ingress|TLS/u);
  });

  test('classifies stable COLP problems rather than Product errors', () => {
    assert.deepEqual(phase3SyncProblem('unsupported_media_type'), {
      type: 'https://know-n.com/colp/problems/unsupported-media-type',
      title: 'Unsupported media type', status: 415, code: 'unsupported_media_type',
    });
    assert.equal(phase3SyncProblem('rate_limited').status, 429);
    assert.equal(phase3SyncProblem('request_timeout').status, 503);
  });
});

describe('P3-04 deployment probe contract', () => {
  const credentialEvidence = mintVerifiedExtensionCredentialFixture({
    issuer: 'https://issuer.example.test/', subject: 'EREREREREREREREREREREQ',
    audience: 'known-sync-api', clientId: 'known-chromium-extension',
    credentialId: 'phase3-probe-credential',
  });
  const postgresProbe = {
    verifyProductionMigration: async () => ({ migration: '202607221600_authority_repair' }),
    verifyCanonicalMutation: async () => ({
      operationIdReservationOwner: 'sequence' as const, usesPushCoordinator: false as const,
      maxBatchOperations: 1 as const, resourceRevision: 'node-r2',
    }),
  };
  const credentialProbe = {
    authorization: 'Bearer stable-token',
    verifyAvailability: async () => credentialEvidence,
  };
  const timeoutCancellation = { verifyObserved: async () => undefined };
  const deploymentFetch: typeof fetch = vi.fn(async (input) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.pathname === '/.well-known/collection-protocol') return Response.json(fixture);
    const endpoint = url.pathname.includes('/conflicts/')
      ? 'syncConflict'
      : Object.entries(fixture.mounts[0]!.endpoints)
        .find(([, template]) => new URL(template).pathname === url.pathname)?.[0];
    const classes: Record<string, string> = {
      syncSessions: 'sync-session', syncSnapshot: 'sync-snapshot', syncPush: 'sync-push',
      syncPull: 'sync-pull', syncAck: 'sync-ack', syncConflict: 'sync-conflict',
    };
    return new Response('{}', {
      status: 429, headers: { 'content-type': 'application/problem+json',
        'ratelimit-policy': `"${classes[endpoint ?? ''] ?? 'missing'}";q=1;w=60` },
    });
  }) as typeof fetch;

  test.each([
    ['postgres', /PostgreSQL production migration probe/u],
    ['credentialAdapter', /P3-01 credential adapter probe/u],
  ] as const)('fails closed when %s is absent', (field, expected) => {
    const options = {
      runtimeOrigin: 'https://sync.example.test:443',
      manifestUrl: 'https://sync.example.test/.well-known/collection-protocol',
      fetch: vi.fn(async () => Response.json(fixture)) as typeof fetch,
      postgres: postgresProbe,
      credentialAdapter: credentialProbe,
      timeoutCancellation,
      allowedEndpointOrigins: ['https://sync-edge.example.test'],
    };
    assert.throws(
      () => createPhase3SyncDeploymentProbe({ ...options, [field]: undefined } as never),
      expected,
    );
  });

  test('checks an actual runtime port, production migration, credential/PostgreSQL adapters, and all routes', async () => {
    const probe = createPhase3SyncDeploymentProbe({
      runtimeOrigin: 'https://sync.example.test:443',
      manifestUrl: 'https://sync.example.test/.well-known/collection-protocol',
      fetch: deploymentFetch,
      postgres: postgresProbe,
      credentialAdapter: credentialProbe,
      timeoutCancellation,
      allowedEndpointOrigins: ['https://sync-edge.example.test'],
    });
    const evidence = await probe.run();
    assert.equal(evidence.runtimePort, 443);
    assert.deepEqual(evidence.mountedEndpoints, [...PHASE3_SYNC_ENDPOINT_KEYS]);
  });

  test('binds the Manifest fetch to the exact runtime origin and port', () => {
    assert.throws(() => createPhase3SyncDeploymentProbe({
      runtimeOrigin: 'https://sync.example.test:444',
      manifestUrl: 'https://sync.example.test:443/.well-known/collection-protocol',
      fetch: vi.fn() as typeof fetch, postgres: postgresProbe,
      credentialAdapter: credentialProbe, timeoutCancellation,
    }), /Manifest URL.*runtime origin/u);
  });

  test('acceptance refuses an ad hoc target and never marks this Deployment-proven', async () => {
    await assert.rejects(
      runPhase3SyncHttpAcceptance({} as never),
      /repo-owned P3-04 deployment probe/u,
    );
  });

  test('does not accept self-reported route, credential, migration, or mutation booleans as evidence', () => {
    const source = readFileSync(resolve('scripts/acceptance/phase3-sync-http-acceptance.ts'), 'utf8');
    const harness = readFileSync(resolve('scripts/evidence/phase3-sync-http-composition.ts'), 'utf8');
    assert.doesNotMatch(source, /mountedEndpoints:\s*ReadonlySet/u);
    assert.doesNotMatch(harness, /adapter:\s*'p3-01-verified-extension-credential'/u);
    assert.match(harness, /createExtensionCredentialEvidenceVerifier|ExtensionCredentialEvidencePort/u);
    assert.match(source, /verifyCanonicalMutation/u);
    assert.match(source, /probeMountedRoutes/u);
    assert.match(harness, /202607221600_authority_repair/u);
    assert.match(harness, /createServer/u);
  });
});

describe('FIX-M-008 trusted-ingress Sync TLS evidence', () => {
  describe('trusted-ingress peer matcher', () => {
    test('allowlisted CIDR and exact-address entries match only inside the allowlist', () => {
      const matches = createTrustedIngressMatcher(['10.0.0.0/8', '192.0.2.7']);
      assert.equal(matches('10.1.2.3'), true);
      assert.equal(matches('192.0.2.7'), true);
      assert.equal(matches('11.0.0.1'), false);
      assert.equal(matches('192.0.2.8'), false);
      assert.equal(matches(undefined), false);
      assert.equal(matches(''), false);
      assert.equal(matches('not-an-ip'), false);
    });

    test('IPv4-mapped IPv6 peers match IPv4 allowlist entries (Node reports IPv4 peers as ::ffff:a.b.c.d)', () => {
      const matches = createTrustedIngressMatcher(['10.0.0.0/8']);
      assert.equal(matches('::ffff:10.1.2.3'), true);
      assert.equal(matches('::ffff:198.51.100.9'), false);
      assert.equal(matches('::1'), false);
    });

    test('IPv6 CIDR allowlist entries match IPv6 peers', () => {
      const matches = createTrustedIngressMatcher(['fd00::/8']);
      assert.equal(matches('fd00::1'), true);
      assert.equal(matches('2001:db8::1'), false);
    });

    test('malformed allowlist entries fail closed at compile time', () => {
      assert.throws(() => createTrustedIngressMatcher(['10.0.0.0/33']), /prefix/u);
      assert.throws(() => createTrustedIngressMatcher(['garbage']), /not a valid IP/u);
    });
  });

  describe('Sync transport guard', () => {
    const security = (options: {
      readonly allowInsecureLoopback?: boolean;
      readonly trustedIngress?: readonly string[];
    } = {}) => createSyncTransportSecurity({
      allowInsecureLoopback: options.allowInsecureLoopback ?? false,
      ...(options.trustedIngress === undefined ? {} : { trustedIngress: options.trustedIngress }),
    });
    const request = (overrides: {
      readonly encrypted?: boolean;
      readonly remoteAddress?: string;
      readonly proto?: string | readonly string[];
    } = {}) => ({
      raw: { socket: {
        encrypted: overrides.encrypted ?? false,
        remoteAddress: overrides.remoteAddress ?? '203.0.113.19',
      } },
      headers: overrides.proto === undefined ? {} : { 'x-forwarded-proto': overrides.proto },
    }) as never;

    test('real socket TLS is authoritative even without an allowlist (direct TLS termination)', () => {
      assert.equal(security().isSecure(request({ encrypted: true, proto: 'http' })), true);
    });

    test('loopback is accepted only when allowInsecureLoopback opts in', () => {
      assert.equal(security().isSecure(request({ remoteAddress: '127.0.0.1' })), false);
      const loopback = security({ allowInsecureLoopback: true });
      assert.equal(loopback.isSecure(request({ remoteAddress: '127.0.0.1' })), true);
      assert.equal(loopback.isSecure(request({ remoteAddress: '::1' })), true);
      assert.equal(loopback.isSecure(request({ remoteAddress: '::ffff:127.0.0.1' })), true);
      assert.equal(loopback.isSecure(request({ remoteAddress: '10.0.0.9', proto: 'https' })), false);
    });

    test('forwarded https from an allowlisted ingress peer is accepted (proxy TLS termination)', () => {
      const guard = security({ trustedIngress: ['10.0.0.0/8'] });
      assert.equal(guard.isSecure(request({ remoteAddress: '10.0.0.9', proto: 'https' })), true);
    });

    test('host nginx on published loopback is trusted only with X-Forwarded-Proto https', () => {
      const guard = security({ trustedIngress: ['127.0.0.1'] });
      assert.equal(guard.isSecure(request({ remoteAddress: '127.0.0.1', proto: 'https' })), true);
      assert.equal(guard.isSecure(request({ remoteAddress: '::ffff:127.0.0.1', proto: 'https' })), true);
      assert.equal(guard.isSecure(request({ remoteAddress: '127.0.0.1' })), false);
      assert.equal(guard.isSecure(request({ remoteAddress: '127.0.0.1', proto: 'http' })), false);
    });

    test('docker-proxy peers on the compose bridge match the ingress CIDR', () => {
      const guard = security({ trustedIngress: ['127.0.0.1', '::1', '172.18.0.0/16'] });
      assert.equal(guard.isSecure(request({ remoteAddress: '172.18.0.1', proto: 'https' })), true);
      assert.equal(guard.isSecure(request({ remoteAddress: '::ffff:172.18.0.1', proto: 'https' })), true);
      assert.equal(guard.isSecure(request({ remoteAddress: '172.18.0.1' })), false);
      assert.equal(guard.isSecure(request({ remoteAddress: '10.0.0.9', proto: 'https' })), false);
    });

    test('a direct untrusted peer can never forge forwarded TLS', () => {
      const guard = security({ trustedIngress: ['10.0.0.0/8'] });
      assert.equal(guard.isSecure(request({ remoteAddress: '203.0.113.19', proto: 'https' })), false);
      // No allowlist declared: forwarded headers are never trusted.
      assert.equal(security().isSecure(request({ remoteAddress: '10.0.0.9', proto: 'https' })), false);
    });

    test('missing or http forwarded proto from a trusted peer fails closed', () => {
      const guard = security({ trustedIngress: ['10.0.0.0/8'] });
      assert.equal(guard.isSecure(request({ remoteAddress: '10.0.0.9' })), false);
      assert.equal(guard.isSecure(request({ remoteAddress: '10.0.0.9', proto: 'http' })), false);
      assert.equal(guard.isSecure(request({ remoteAddress: '10.0.0.9', proto: '' })), false);
    });

    test('IPv4-mapped IPv6 trusted peers resolve inside the guard', () => {
      const guard = security({ trustedIngress: ['10.0.0.0/8'] });
      assert.equal(guard.isSecure(request({ remoteAddress: '::ffff:10.0.0.9', proto: 'https' })), true);
      assert.equal(guard.isSecure(request({ remoteAddress: '::ffff:203.0.113.19', proto: 'https' })), false);
    });

    test('multi-value X-Forwarded-Proto from a trusted peer fails closed', () => {
      const guard = security({ trustedIngress: ['10.0.0.0/8'] });
      assert.equal(guard.isSecure(request({ remoteAddress: '10.0.0.9', proto: 'https' })), true);
      assert.equal(guard.isSecure(request({ remoteAddress: '10.0.0.9', proto: 'HTTPS' })), true);
      assert.equal(guard.isSecure(request({ remoteAddress: '10.0.0.9', proto: ' https ' })), true);
      assert.equal(guard.isSecure(request({ remoteAddress: '10.0.0.9', proto: 'https, http' })), false);
      assert.equal(guard.isSecure(request({ remoteAddress: '10.0.0.9', proto: 'http, https' })), false);
      assert.equal(guard.isSecure(request({ remoteAddress: '10.0.0.9', proto: 'https, https' })), false);
      assert.equal(guard.isSecure(request({ remoteAddress: '10.0.0.9', proto: ['https', 'http'] })), false);
      assert.equal(guard.isSecure(request({ remoteAddress: '10.0.0.9', proto: [] })), false);
      assert.equal(guard.isSecure(request({ remoteAddress: '10.0.0.9', proto: ['https'] })), true);
      // The socket-peer check is still the chain gate: an untrusted peer
      // with a single https token is rejected.
      assert.equal(guard.isSecure(request({ remoteAddress: '198.51.100.7', proto: 'https' })), false);
    });
  });

  describe('Sync Session route wiring', () => {
    const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
    const sessionRequest = {
      protocolVersion: '0.1',
      replica: { replicaId: 'replica-tls-1', name: 'Chrome', kind: 'browser_extension',
        adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
        capabilities: { read: true, write: true, events: true, separator: true, alias: false,
          annotations: 'sidecar', maxBatchOperations: 1 },
        binding: { browserProfileId: 'profile-tls-1', mountMode: 'mounted-folder',
          mountNativeId: 'native-tls-1', generation: 'browser-generation-1' },
        extensions: { 'https://example.test/private': { marker: 'tls-marker' } } },
      scope: 'collection',
      collection: { collectionId: 'collection-tls-1', lastCursor: null, lastRevision: null,
        bootstrapMode: 'download' },
      clientTime: '2026-07-25T10:00:00Z',
    };
    const sessionResult = {
      sessionId: 'session-tls-1', expiresAt: '2026-07-25T11:00:00Z',
      serverTime: '2026-07-25T10:00:01Z', clockSkewMilliseconds: 1_000,
      acceptedProtocolVersion: '0.1', scope: 'collection', maxBatchOperations: 1,
      tombstoneRetentionSeconds: 86_400,
      replicaLease: { leaseId: 'lease-tls-1', generation: '1', state: 'active',
        lastSeenAt: '2026-07-25T10:00:01Z', expiresAt: '2026-08-25T10:00:01Z',
        acknowledgedCursor: null },
      collection: { collectionId: 'collection-tls-1', snapshotRequired: true,
        serverCursor: 'sync-start', serverRevision: 'revision-tls-1' },
      conversionPolicy: { alias: 'duplicate', separator: 'preserve_remote',
        unknownExtensions: 'preserve_remote' },
    };

    test('accepts forwarded TLS only from an allowlisted socket peer', async () => {
      const calls: string[] = [];
      const app = Fastify({ logger: false });
      registerSyncSessionRoutes(app, {
        path: '/private-entry/session-negotiation',
        credentialVerifier: {
          async verify() {
            calls.push('authenticate');
            return mintVerifiedExtensionCredentialFixture({
              issuer: 'https://issuer.example.test', audience: 'known-sync-api',
              clientId: 'known-extension', subject: 'account-tls-1',
              credentialId: 'credential-tls-1',
            });
          },
        },
        application: {
          async issue() { calls.push('issue'); return { state: 'issued', response: sessionResult }; },
        },
        allowedOrigins: [EXTENSION_ORIGIN],
        rateLimit: { maxRequests: 100, windowMs: 60_000 },
        allowInsecureLoopback: false,
        trustedIngress: ['127.0.0.1'],
      });
      const headers = { authorization: 'Bearer token', 'idempotency-key': 'tls-wiring-1',
        origin: EXTENSION_ORIGIN, 'content-type': 'application/json' };
      const forged = await app.inject({ method: 'POST', url: '/private-entry/session-negotiation',
        remoteAddress: '198.51.100.7',
        headers: { ...headers, 'x-forwarded-proto': 'https' },
        payload: JSON.stringify(sessionRequest) });
      assert.equal(forged.statusCode, 401);
      assert.deepEqual(calls, []);
      const trusted = await app.inject({ method: 'POST', url: '/private-entry/session-negotiation',
        headers: { ...headers, 'x-forwarded-proto': 'https' },
        payload: JSON.stringify(sessionRequest) });
      assert.equal(trusted.statusCode, 201);
      assert.deepEqual(calls, ['authenticate', 'issue']);
      await app.close();
    });

    test('without a declared allowlist a proxied peer cannot pass the TLS gate', async () => {
      const calls: string[] = [];
      const app = Fastify({ logger: false });
      registerSyncSessionRoutes(app, {
        path: '/private-entry/session-negotiation',
        credentialVerifier: {
          async verify() { calls.push('authenticate'); return mintVerifiedExtensionCredentialFixture({
            issuer: 'https://issuer.example.test', audience: 'known-sync-api',
            clientId: 'known-extension', subject: 'account-tls-2',
            credentialId: 'credential-tls-2',
          }); },
        },
        application: {
          async issue() { calls.push('issue'); return { state: 'issued', response: sessionResult }; },
        },
        allowedOrigins: [EXTENSION_ORIGIN],
        rateLimit: { maxRequests: 100, windowMs: 60_000 },
        allowInsecureLoopback: false,
      });
      const forged = await app.inject({ method: 'POST', url: '/private-entry/session-negotiation',
        headers: { authorization: 'Bearer token', 'idempotency-key': 'tls-wiring-2',
          origin: EXTENSION_ORIGIN, 'content-type': 'application/json',
          'x-forwarded-proto': 'https' },
        payload: JSON.stringify(sessionRequest) });
      assert.equal(forged.statusCode, 401);
      assert.deepEqual(calls, []);
      await app.close();
    });
  });
});
