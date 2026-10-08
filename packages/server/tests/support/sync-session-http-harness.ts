/**
 * Shared harness for the P3-08 Sync Session HTTP suites. Extracted from
 * tests/unit/sync/sync-session-http.test.ts so the surface suites stay under
 * the test-granularity ceiling.
 */
import { request as rawRequest } from 'node:http';
import { connect } from 'node:net';
import type { Manifest, SyncSessionRequest } from '@know-n/colp/types';
import Fastify, { type FastifyInstance } from 'fastify';
import type { VerifiedExtensionCredential } from '../../src/modules/identity/index.js';
import {
  registerSyncSessionRoutes,
  type SyncSessionHttpApplication,
} from '../../src/transport/colp-sync/sync-session-routes.js';
import { mintVerifiedExtensionCredentialFixture } from './extension-credential.js';
import { loadConfig } from './test-config.js';

export const SECRET_TOKEN = 'token-SYNC-SECRET-MARKER';
export const SECRET_BINDING = 'binding-SYNC-SECRET-MARKER';
export const SECRET_EXTENSION = 'extension-SYNC-SECRET-MARKER';
export const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const apps: FastifyInstance[] = [];

/** Closes every app started via `start`; register as afterEach in each suite. */
export async function closeSyncSessionApps(): Promise<void> {
  await Promise.all(apps.splice(0).map((app) => app.close()));
}

/** Registers an already-built app (e.g. buildApiApp output) for afterEach cleanup. */
export function trackSyncSessionApp(app: FastifyInstance): void {
  apps.push(app);
}

export function request(overrides: Record<string, unknown> = {}): SyncSessionRequest {
  return {
    protocolVersion: '0.1',
    replica: {
      replicaId: 'replica-http-1', name: 'Chrome', kind: 'browser_extension',
      adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
      capabilities: {
        read: true, write: true, events: true, separator: true, alias: false,
        annotations: 'sidecar', maxBatchOperations: 1,
      },
      binding: {
        browserProfileId: 'profile-http-1', mountMode: 'mounted-folder',
        mountNativeId: SECRET_BINDING, generation: 'browser-generation-1',
      },
      extensions: { 'https://example.test/private': { marker: SECRET_EXTENSION } },
    },
    scope: 'collection',
    collection: {
      collectionId: 'collection-http-1', lastCursor: null, lastRevision: null,
      bootstrapMode: 'download',
    },
    clientTime: '2026-07-25T10:00:00Z',
    ...overrides,
  } as SyncSessionRequest;
}

export function result() {
  return Object.freeze({
    sessionId: 'session-http-1', expiresAt: '2026-07-25T11:00:00Z',
    serverTime: '2026-07-25T10:00:01Z', clockSkewMilliseconds: 1_000,
    acceptedProtocolVersion: '0.1' as const, scope: 'collection' as const,
    maxBatchOperations: 1, tombstoneRetentionSeconds: 86_400,
    replicaLease: {
      leaseId: 'lease-http-1', generation: '1', state: 'active' as const,
      lastSeenAt: '2026-07-25T10:00:01Z', expiresAt: '2026-08-25T10:00:01Z',
      acknowledgedCursor: null,
    },
    collection: {
      collectionId: 'collection-http-1', snapshotRequired: true,
      serverCursor: 'sync-start', serverRevision: 'revision-http-1',
    },
    conversionPolicy: {
      alias: 'duplicate' as const, separator: 'preserve_remote' as const,
      unknownExtensions: 'preserve_remote' as const,
    },
  });
}

export function manifest(origin: string): Manifest {
  return {
    protocol: 'https://know-n.com/colp/spec/0.1', protocolVersions: ['0.1'],
    serverId: `${origin}/`, serverUuid: '019f97ff-1111-7111-8111-111111111111', title: 'Known',
    mounts: [{
      id: 'known-sync-entry', baseUrl: `${origin}/private-entry/`, profiles: ['core'],
      endpoints: {
        syncSessions: `${origin}/private-entry/session-negotiation`,
        syncSnapshot: `${origin}/private-entry/snapshot-download`,
        syncPush: `${origin}/private-entry/operation-ingress`,
        syncPull: `${origin}/private-entry/event-stream`,
        syncAck: `${origin}/private-entry/checkpoint-commit`,
        syncConflict: `${origin}/private-entry/conflicts/{conflictId}/decision`,
      },
      features: {
        bookmarkUrls: { acceptedSchemes: ['http', 'https'] },
        sync: { multiCollectionSessions: false },
      },
      auth: {
        anonymousRead: false, apiKeys: false, oauth: true,
        protectedResourceMetadata: `${origin}/.well-known/oauth-protected-resource`,
      },
      limits: {
        maxPageSize: 100, maxSnapshotNodes: 10_000, minPollIntervalSeconds: 10,
        recommendedPollIntervalSeconds: 30, maxSyncBatchOperations: 1,
        idempotencyRetentionSeconds: 86_400, syncCursorRetentionSeconds: 2_592_000,
      },
    }],
  } as Manifest;
}

export async function start(options: {
  readonly verifier?: (authorization: string | readonly string[] | undefined) => Promise<VerifiedExtensionCredential>;
  readonly issue?: SyncSessionHttpApplication['issue'];
  readonly rateLimit?: number;
  readonly bodyLimitBytes?: number;
  readonly maxJsonDepth?: number;
  readonly maxJsonMembers?: number;
  readonly allowInsecureLoopback?: boolean;
  readonly manifest?: (origin: string) => unknown;
} = {}) {
  const calls: string[] = [];
  const app = Fastify({ logger: false });
  const application: SyncSessionHttpApplication = {
    async issue(input) {
      calls.push('issue');
      if (options.issue) return options.issue(input);
      return { state: 'issued', response: result() };
    },
  };
  registerSyncSessionRoutes(app, {
    path: '/private-entry/session-negotiation',
    credentialVerifier: {
      async verify({ authorization }) {
        calls.push('authenticate');
        return options.verifier
          ? options.verifier(authorization)
          : mintVerifiedExtensionCredentialFixture({
              issuer: 'https://issuer.example.test', audience: 'known-sync-api',
              clientId: 'known-extension', subject: 'account-http-1',
              credentialId: 'credential-http-1',
            });
      },
    },
    application,
    rateLimit: { maxRequests: options.rateLimit ?? 20, windowMs: 60_000 },
    allowedOrigins: [EXTENSION_ORIGIN],
    allowInsecureLoopback: options.allowInsecureLoopback ?? true,
    ...(options.bodyLimitBytes === undefined ? {} : { bodyLimitBytes: options.bodyLimitBytes }),
    ...(options.maxJsonDepth === undefined ? {} : { maxJsonDepth: options.maxJsonDepth }),
    ...(options.maxJsonMembers === undefined ? {} : { maxJsonMembers: options.maxJsonMembers }),
  });
  app.get('/.well-known/collection-protocol', async (_request, reply) => {
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('not listening');
    const origin = `http://127.0.0.1:${address.port}`;
    return reply.send(options.manifest?.(origin) ?? manifest(origin));
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  apps.push(app);
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('not listening');
  return { app, origin: `http://127.0.0.1:${address.port}`, calls };
}

export function syncEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test', DATABASE_URL: 'postgres://unused/known', LOG_LEVEL: 'silent',
    // FIX-H-001: OIDC_ALLOW_TEST_PROVIDER now defaults to false everywhere, so a
    // real-provider shape-only JWKS placeholder is required for loadConfig to
    // succeed (never fetched).
    OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
    PRODUCT_ORIGIN: 'https://known.example', PUBLICATION_ORIGIN: 'https://known.example',
    SYNC_SESSION_ENABLED: 'true', SYNC_EXTENSION_IDS: 'abcdefghijklmnopabcdefghijklmnop',
    SYNC_OAUTH_ISSUER: 'https://issuer.example.test', SYNC_OAUTH_CLIENT_ID: 'known-extension',
    SYNC_OAUTH_AUDIENCE: 'known-sync-api',
    SYNC_OAUTH_AUTHORIZATION_ENDPOINT: 'https://issuer.example.test/oauth2/authorize',
    SYNC_OAUTH_TOKEN_ENDPOINT: 'https://issuer.example.test/oauth2/token',
    SYNC_OAUTH_JWKS_URI: 'https://issuer.example.test/.well-known/jwks.json',
    SYNC_OAUTH_REDIRECT_URI: 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/callback',
    SYNC_OAUTH_SCOPES: 'openid known.sync', SYNC_OAUTH_ALGORITHMS: 'RS256',
    SYNC_SESSION_REPLAY_KEY: Buffer.alloc(32, 23).toString('base64'),
    SYNC_SNAPSHOT_CURSOR_KEY: Buffer.alloc(32, 29).toString('base64'),
    SYNC_SNAPSHOT_CURSOR_KEY_ID: 'test-sync-snapshot-v1',
    SYNC_PULL_CURSOR_KEY_ID: 'test-sync-pull-v1',
    SYNC_PULL_CURSOR_KEY: Buffer.alloc(32, 41).toString('base64'),
    SYNC_RECOVERY_CAPABILITY_KEY_ID: 'recovery-v1',
    SYNC_RECOVERY_CAPABILITY_KEY: Buffer.alloc(32, 44).toString('base64'),
    SYNC_PULL_LINEAGE_KEY_ID: 'lineage-v1',
    SYNC_PULL_LINEAGE_KEY: Buffer.alloc(32, 46).toString('base64'),
    ...overrides,
  };
}

export function syncProductionEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return syncEnv({
    NODE_ENV: 'production', TRUSTED_PROXY_HOPS: '0', TRUSTED_INGRESS: '127.0.0.1',
    OIDC_TRANSACTION_HMAC_SECRET: 'prod-hmac-secret-not-dev-default',
    OIDC_TRANSACTION_ENCRYPTION_KEYS:
      `1:oidc-pkce-prod:${Buffer.alloc(32, 5).toString('base64')}`,
    PRODUCT_EDITOR_CURSOR_HMAC_KEY: 'prod-product-editor-cursor-hmac-key-not-dev-default',
    PRODUCT_EDITOR_CURSOR_KEY_ID: 'prod-editor-v1',
    PRODUCT_OWNED_COLLECTIONS_CURSOR_HMAC_KEY: 'prod-owned-collections-cursor-key-not-dev-default',
    PRODUCT_OWNED_COLLECTIONS_CURSOR_KEY_ID: 'prod-owned-v1',
    PRODUCT_LINK_HEALTH_CURSOR_HMAC_KEY: 'prod-link-health-cursor-hmac-key-not-dev-default',
    PRODUCT_LINK_HEALTH_CURSOR_KEY_ID: 'prod-link-health-v1',
    PRODUCT_CLASSIFY_INBOX_CURSOR_HMAC_KEY: 'prod-classify-inbox-cursor-hmac-key-not-dev-default',
    PRODUCT_CLASSIFY_INBOX_CURSOR_KEY_ID: 'prod-classify-inbox-v1',
    PRODUCT_COLLECTION_VERSIONS_CURSOR_HMAC_KEY: 'prod-collection-versions-cursor-hmac-key-not-dev-default',
    PRODUCT_COLLECTION_VERSIONS_CURSOR_KEY_ID: 'prod-collection-versions-v1',
    PUBLISHING_INSIGHTS_VISITOR_HMAC_KEY: 'prod-publishing-insights-visitor-hmac-key-32b',
    PUBLISHING_INSIGHTS_RATELIMIT_HMAC_KEY: 'prod-publishing-insights-ratelimit-hmac-key-32b',
    COLLABORATION_INVITE_RATE_LIMIT_KEY_SECRET: 'prod-collaboration-invite-rate-limit-hmac',
    PRODUCT_EDITOR_CURSOR_ISSUANCE_FORMAT: 'keyed',
    PUBLICATION_SERVER_UUID: '019f9031-c541-74d0-bc83-15a5526fbb54',
    PUBLICATION_CURSOR_ACTIVE_KEY_ID: 'prod-publication-v1',
    PUBLICATION_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 17).toString('base64'),
    FOLLOW_CURSOR_ACTIVE_KEY_ID: 'prod-follow-v1',
    FOLLOW_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 19).toString('base64'),
    FEED_CURSOR_ACTIVE_KEY_ID: 'prod-feed-v1',
    FEED_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 21).toString('base64'),
    PUBLIC_ACTIVITY_CURSOR_ACTIVE_KEY_ID: 'prod-public-activity-v1',
    PUBLIC_ACTIVITY_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 27).toString('base64'),
    NOTIFICATION_CURSOR_ACTIVE_KEY_ID: 'prod-notification-v1',
    NOTIFICATION_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 23).toString('base64'),
    FOLLOWED_COLLECTIONS_CURSOR_ACTIVE_KEY_ID: 'prod-followed-collections-v1',
    FOLLOWED_COLLECTIONS_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 37).toString('base64'),
    COMMUNITY_CURSOR_HMAC_KEY: Buffer.alloc(32, 43).toString('base64'),
    OIDC_ISSUER: 'https://issuer.example.test', OIDC_CLIENT_ID: 'known-web',
    OIDC_REDIRECT_URI: 'https://known.example/api/v1/auth/oidc/callback',
    OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example.test/oauth2/authorize',
    OIDC_TOKEN_ENDPOINT: 'https://issuer.example.test/oauth2/token',
    OIDC_JWKS_URI: 'https://issuer.example.test/.well-known/jwks.json',
    OIDC_ALLOW_TEST_PROVIDER: 'false',
    ...overrides,
  });
}

export function routeDependencies(config: NonNullable<ReturnType<typeof loadConfig>['syncSession']>) {
  return {
    path: config.path, allowedOrigins: config.allowedOrigins, allowInsecureLoopback: true,
    rateLimit: config.rateLimit,
    credentialVerifier: {
      async verify() {
        return mintVerifiedExtensionCredentialFixture({
          issuer: 'https://issuer.example.test', audience: 'known-sync-api',
          clientId: 'known-extension', subject: 'account-http-1', credentialId: 'credential-http-1',
        });
      },
    },
    application: { async issue() { return { state: 'issued' as const, response: result() }; } },
  };
}

export async function post(origin: string, key: string): Promise<Response> {
  return fetch(`${origin}/private-entry/session-negotiation`, {
    method: 'POST', headers: {
      Authorization: `Bearer ${SECRET_TOKEN}`, 'Idempotency-Key': key,
      Origin: EXTENSION_ORIGIN,
      'Content-Type': 'application/json',
    }, body: JSON.stringify(request()),
  });
}

export async function rawHttp(origin: string, headers: readonly string[], body: string): Promise<{
  readonly status: number; readonly contentType: string; readonly body: string;
}> {
  const url = new URL('/private-entry/session-negotiation', origin);
  return new Promise((resolve, reject) => {
    const outgoing = rawRequest({ hostname: url.hostname, port: url.port, path: url.pathname,
      method: 'POST', headers: [...headers, 'Content-Length', String(Buffer.byteLength(body))] }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.on('end', () => resolve({ status: incoming.statusCode ?? 0,
        contentType: String(incoming.headers['content-type'] ?? ''), body: Buffer.concat(chunks).toString('utf8') }));
    });
    outgoing.once('error', reject);
    outgoing.end(body);
  });
}

export async function rawWire(origin: string, bytes: Buffer): Promise<string> {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const socket = connect({ host: url.hostname, port: Number(url.port) });
    const chunks: Buffer[] = [];
    socket.once('connect', () => socket.end(bytes));
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.once('end', () => resolve(Buffer.concat(chunks).toString('latin1')));
    socket.once('error', reject);
  });
}
