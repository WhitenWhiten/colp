import { createPostgresLibraryCollectionUnitOfWork } from '../../server/src/infrastructure/collections/library-collection-postgres.js';
import { bootstrapCanonicalOwnedCollection, generateRevisionToken } from '../../server/src/modules/collections/index.js';
import type { createBookmarkSubscriptionProductFixture } from './bookmark-subscription-product-stack.js';
import { knowNBackendRoot, loadClassificationProductStack, type ClassificationProductFixture } from './cloud-product-fixtures.js';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { createValidatorRegistry } from '@know-n/colp/schema';
import { subtreeDeleteSource } from '@know-n/colp/sync/canonical';
import Fastify, { type FastifyInstance } from '../../server/node_modules/fastify/fastify.js';
// @ts-expect-error The E2E harness deliberately reuses the backend's pinned JOSE runtime.
import { SignJWT, exportJWK, generateKeyPair } from '../../server/node_modules/jose/dist/webapi/index.js';
// @ts-expect-error The E2E harness deliberately reuses the backend's pinned PostgreSQL runtime.
import pg from '../../server/node_modules/pg/lib/index.js';
import { createDatabaseRuntime, runMigrations, createPostgresSharedExposureFactsPort, createAttachmentExposurePolicyAdapter } from '../../server/src/infrastructure/database/index.js';
import { createPostgresOwnedCollectionsReadPort, createPostgresCollectionsUnitOfWork } from '../../server/src/infrastructure/collections/index.js';
import { createPostgresBookmarkPreferencesQuery, createPostgresBookmarkPreferencesUnitOfWork, createPostgresExtensionOwnerSubjectPort, createPostgresExtensionOwnerAccountPort, createPostgresIdentityUnitOfWork } from '../../server/src/infrastructure/identity/index.js';
import { createProductOwnedCollectionsCursorSigner } from '../../server/src/modules/collections/index.js';
import { registerExtensionCollectionRoutes } from '../../server/src/transport/colp-sync/extension-collection-routes.js';
import { createFixedWindowRateLimiter } from '../../server/src/transport/http-security.js';
import {
  createPostgresReplicaRetirementApplication,
  createPostgresProductSyncCenterUnitOfWork,
  createPostgresReplicaRetentionWindowPort,
  createPostgresReplicaStore,
  createPostgresSyncSessionHttpApplication,
  createPostgresSyncSessionIssuer,
  createPostgresSyncPushApplication,
  createPostgresSyncConflictResolutionApplication,
  createPostgresSyncBootstrapSnapshotApplication,
  createPostgresSyncPullReadPort,
  createPostgresSyncEffectPageReadPort,
  createPostgresSyncAckApplication,
  createPostgresSyncRecoveryApplication,
  createSyncPullCursorKeyring,
  createSyncRecoveryCapabilityKeyring,
} from '../../server/src/infrastructure/sync/index.js';
import {
  createCompositeExtensionCredentialVerifier,
  createExtensionCredentialEvidenceVerifier,
  createSessionBackedExtensionCredentialVerifier,
  parseExtensionAuthConfig,
} from '../../server/src/modules/identity/index.js';
import {
  materializeCollectionPayload, materializeNodePayload, RESOURCE_PAYLOAD_SCHEMA_VERSION,
  type CollectionsWritePorts,
  type FaviconPolicyCommandPorts,
} from '../../server/src/modules/collections/index.js';
import { registerSyncRetireRoutes } from '../../server/src/transport/colp-sync/sync-retire-routes.js';
import { registerSyncSessionRoutes } from '../../server/src/transport/colp-sync/sync-session-routes.js';
import { registerSyncPushRoutes } from '../../server/src/transport/colp-sync/sync-push-routes.js';
import { registerSyncConflictRoutes } from '../../server/src/transport/colp-sync/sync-conflict-routes.js';
import { registerSyncSnapshotRoutes } from '../../server/src/transport/colp-sync/sync-snapshot-routes.js';
import { registerSyncPullRoutes } from '../../server/src/transport/colp-sync/sync-pull-routes.js';
import { registerSyncEffectPageRoutes } from '../../server/src/transport/colp-sync/sync-effect-page-routes.js';
import { registerSyncAckRoutes } from '../../server/src/transport/colp-sync/sync-ack-routes.js';
import { registerBetterAuthRoutes } from '../../server/src/transport/auth/better-auth-routes.js';
import {
  buildBetterAuthOptions,
  createBetterAuthRuntime,
} from '../../server/src/infrastructure/auth/better-auth-runtime.js';
import {
  createBetterAuthServerApi,
  createBetterAuthSessionAuthority,
} from '../../server/src/infrastructure/auth/better-auth-session-authority.js';
import { createBetterAuthSessionTokenProtector } from '../../server/src/infrastructure/auth/better-auth-session-token-protection.js';
import { createArgon2idPasswordHasher } from '../../server/src/infrastructure/auth/argon2id-password-hasher.js';
import { createPostgresBusinessAccountUnitOfWork } from '../../server/src/infrastructure/auth/business-account-unit-of-work.js';
import { betterAuth } from '../../server/node_modules/better-auth/dist/index.mjs';
import { FIXTURE_COLLECTION_ID } from './fixture-ids.js';
import { clearExternalBuildPointing, externalBackendOrigin, startExternalRealStack } from './external-backend.js';
import { loadConfig } from '../../server/src/bootstrap/config.js';
import { registerSessionMeRoutes } from '../../server/src/transport/auth/browser-auth-handlers.js';
import { registerBookmarkPreferencesRoutes } from '../../server/src/transport/product/bookmark-preferences-routes.js';
import { installProductAdmission } from '../../server/src/transport/product-admission.js';
import { ProductHttpError, sendProductError } from '../../server/src/transport/product-error.js';

const EXTENSION_ID = 'pplpnpegpnghcddhmpgkbfkdfadjiaen';
const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;
const ISSUER = 'https://identity.known.example/';
const SERVER_ORIGIN = 'https://known.example';
const CLIENT_ID = 'known-chromium-extension';
const AUDIENCE = 'known-sync-api';
const SUBJECT = 'p3-27-oidc';
const COLLECTION_ID = FIXTURE_COLLECTION_ID;
const REPLICA_ID = 'replica-p3-27';
const PROFILE_ID = 'profile-p3-27';
// Task E3 fixed test credentials for the REAL Better Auth account registration
// (test-only; recorded in the E3 report, never logged).
const FIXTURE_BA_EMAIL = 'p3-27-extension@example.test';
const FIXTURE_BA_PASSWORD = 'p3-27-extension-password-e3';
const FIXTURE_BA_SECRET = 'p3-27-extension-better-auth-secret-0123456789abcdef';
/** Deterministic test-only keyring shared by the BA adapter and Session Authority. */
const FIXTURE_BA_SESSION_TOKEN_PROTECTION = {
  keys: [{ version: 1, key: Buffer.alloc(32, 0x27) }],
  legacyPlaintextReadUntil: null,
} as const;
/** BA-created business account (auth_users + mapping + accounts via A2 hooks). */
let fixtureAccount: { readonly id: string; readonly subjectId: string } | null = null;
let fixtureAuthUserId: string | null = null;
/** C1 mailbox entries from the fixture's REAL BA registration (test material). */
let fixtureAuthMailbox: ReadonlyArray<{ readonly to: string; readonly subject: string; readonly receivedAt: string }> = [];
const P3_29_BINDINGS = [
  { replicaId: 'replica-p3-29-a', browserProfileId: 'profile-p3-29-a', suffix: 'p3-29-a' },
  { replicaId: 'replica-p3-29-b', browserProfileId: 'profile-p3-29-b', suffix: 'p3-29-b' },
] as const;

export type IssuerMode = 'normal' | 'offline';

export type PushFault = 'none' | 'authentication_required_once' | 'timeout_once' | 'lost_batch_response_once'
  | 'service_unavailable_once' | 'rate_limited_once' | 'sequence_gap_once' | 'sequence_gap'
  | 'sequence_blocked_once' | 'deferred_once';

export interface PushRequestObservation {
  readonly url: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
  readonly fingerprint: string;
  readonly responseStatus?: number;
  readonly responseCode?: string;
  /** Observe the COLP Bearer transport without retaining the opaque session credential. */
  readonly sessionCookiePresent: boolean;
  readonly bearerAuthorizationPresent: boolean;
}

export interface CanonicalFixture {
  readonly rootId: string; readonly rootRevision: string; readonly rootResourceRevision?: string;
  readonly folderId: string; readonly folderRevision: string; readonly folderResourceRevision?: string;
  readonly bookmarkId: string; readonly bookmarkRevision: string;
  readonly bookmarkParentId?: string;
  readonly folderTitle: string; readonly bookmarkTitle: string; readonly bookmarkUrl: string;
}

export interface RealStack {
  readonly subscriptionProduct?: Awaited<ReturnType<typeof createBookmarkSubscriptionProductFixture>>;
  readonly classificationProduct?: ClassificationProductFixture;
  readonly browserHostResolverRules: string;
  readonly extensionBinding: { readonly replicaId: string; readonly browserProfileId: string; readonly generation: '1' };
  readonly extensionBindings: readonly [
    { readonly replicaId: string; readonly browserProfileId: string; readonly generation: '1' },
    { readonly replicaId: string; readonly browserProfileId: string; readonly generation: '1' },
  ];
  readonly authUserId: string;
  readonly collectionId: string;
  readonly serverOrigin: string;
  setMode(mode: IssuerMode): void;
  setSyncOffline(offline: boolean): void;
  /** Change only the isolated test collection's availability for lifecycle acceptance. */
  setFixtureCollectionUnavailable(unavailable: boolean): Promise<void>;
  forceFixtureReplicaRecovery(): Promise<void>;
  observations(): Promise<Record<string, unknown>>;
  canonicalSiblingOrder(parentId: string): Promise<ReadonlyArray<{
    readonly id: string; readonly parentId: string; readonly positionToken: string;
    readonly title: string; readonly url: string | null;
  }>>;
  /** Stored node extension maps of the live bookmarks with this URL (pins live there). */
  canonicalBookmarkExtensions(url: string): Promise<ReadonlyArray<Readonly<Record<string, unknown>>>>;
  /** FO-04 manual-protection seam: run the REAL updateMyFaviconPolicy command. */
  setFaviconPolicyForFixture(patch: { readonly newDefault?: 'capture' | 'online' | 'none' }): Promise<void>;
  revokeCurrentCredential(): Promise<void>;
  setPushFault(fault: PushFault): void;
  setEffectPageRateLimitPages(pageNumbers: readonly number[]): void;
  seedPagedSubtree(memberCount?: number): Promise<{
    readonly effectId: string; readonly pageCount: number; readonly memberCount: number;
  }>;
  seedCanonicalFixture(nestedBookmark?: boolean): Promise<CanonicalFixture>;
  concurrentlyUpdateCanonicalBookmark(fixture: CanonicalFixture): Promise<void>;
  commitAfterDisconnect(): Promise<void>;
  restorePushResponses(): Promise<void>;
  listDeletedCanonicalNodes(): Promise<ReadonlyArray<{
    readonly id: string; readonly parentId: string | null; readonly revision: string;
    readonly deletedAt: string; readonly titlePresent: boolean; readonly kind: string;
  }>>;
  restoreDeletedNode(nodeId: string): Promise<{ readonly revision: string; readonly parentId: string }>;
  listProductTrash(): Promise<ReadonlyArray<{
    readonly deletionId: string; readonly nodeId: string; readonly kind: string; readonly revision: string;
    readonly title: string | null;
  }>>;
  restoreProductTrashBatch(items: ReadonlyArray<{ readonly deletionId: string; readonly expectedRevision: string }>):
    Promise<{ readonly results: ReadonlyArray<{ readonly deletionId: string; readonly outcome: string; readonly nodeId?: string }> }>;
  restoreProductTrashSubtree(deletionId: string, expectedRevision: string):
    Promise<{ readonly results: ReadonlyArray<{ readonly deletionId: string; readonly outcome: string; readonly nodeId?: string; readonly parentId?: string }> }>;
  close(): Promise<void>;
}

const MAX_SYNC_BATCH_OPERATIONS = knowNBackendRoot ? 1 : 50;

export async function startRealStack(options: {readonly classification?:boolean; readonly syntheticCapture?: boolean; readonly subscriptions?: boolean; readonly web?: boolean; readonly freshLibrary?: boolean} = {}): Promise<RealStack> {
  const externalOrigin = externalBackendOrigin();
  if (externalOrigin) return startExternalRealStack(externalOrigin);
  await clearExternalBuildPointing();
  const isolated = await createIsolatedDatabase();
  await runMigrations(isolated.runtime.db, 'latest', resolve(knowNBackendRoot ?? resolve(import.meta.dirname, '../../server'), 'migrations'));
  await seedDatabase(isolated, options.freshLibrary);
  let activeLibraryId = FIXTURE_COLLECTION_ID;
  const subscriptionProduct = options.subscriptions && fixtureAccount
    ? await (await import('./bookmark-subscription-product-stack.js')).createBookmarkSubscriptionProductFixture(isolated.runtime, fixtureAccount) : undefined;

  const baRuntimeInput = betterAuthRuntimeInput(isolated);
  const authorityAuth = betterAuth(buildBetterAuthOptions(baRuntimeInput));
  const browserSessionAuthority = createBetterAuthSessionAuthority({
    db: isolated.runtime.db,
    betterAuth: createBetterAuthServerApi(authorityAuth),
    secret: FIXTURE_BA_SECRET,
    sessionExpiresInSeconds: 86_400,
    sessionTokenProtector: createBetterAuthSessionTokenProtector(
      FIXTURE_BA_SESSION_TOKEN_PROTECTION,
    ),
  });
  const baRuntime = createBetterAuthRuntime(baRuntimeInput);
  if (baRuntime === null) throw new Error('extension e2e Better Auth runtime is disabled');

  const keys = await generateKeyPair('RS256', { extractable: true });
  const publicJwk = await exportJWK(keys.publicKey);
  Object.assign(publicJwk, { kid: 'p3-27-rs256', alg: 'RS256', use: 'sig' });
  const jwks = { keys: [publicJwk] };
  const authConfig = parseExtensionAuthConfig({
    issuer: ISSUER,
    clientId: CLIENT_ID,
    audience: AUDIENCE,
    authorizationEndpoint: `${ISSUER}oauth2/authorize`,
    tokenEndpoint: `${ISSUER}oauth2/token`,
    jwksUri: `${ISSUER}.well-known/jwks.json`,
    redirectUri: `https://${EXTENSION_ID}.chromiumapp.org/oauth2`,
    extensionIds: [EXTENSION_ID],
    redirectOrigins: [`https://${EXTENSION_ID}.chromiumapp.org`],
    scopes: ['openid', 'offline_access', 'known.sync'],
    algorithms: ['RS256'],
    clockSkewSeconds: 5,
    evidenceTtlSeconds: 60,
  });
  const joseVerifier = createExtensionCredentialEvidenceVerifier({
    config: authConfig,
    jwks: { async getKeySet() { return jwks; } },
    requiredScopes: ['known.sync'],
    async isRevoked(input) {
      const stored = await isolated.runtime.db.selectFrom('sync_extension_credentials')
        .select(['credential_digest', 'revoked_at'])
        .where('issuer', '=', input.issuer)
        .where('credential_id', '=', input.tokenId)
        .executeTakeFirst();
      return stored !== undefined
        && (stored.revoked_at !== null || stored.credential_digest !== input.tokenDigest);
    },
  });
  const credentialVerifier = createCompositeExtensionCredentialVerifier(
    joseVerifier,
    createSessionBackedExtensionCredentialVerifier({
      config: authConfig,
      identityIssuer: SERVER_ORIGIN,
      sessions: {
        async authenticate(cookieHeader) {
          const actor = await browserSessionAuthority.authenticate({ cookie: cookieHeader }, { touch: false });
          if (!actor) return null;
          const expiresAt = actor.session.idleExpiresAt.getTime() <= actor.session.absoluteExpiresAt.getTime()
            ? actor.session.idleExpiresAt : actor.session.absoluteExpiresAt;
          return {
            accountId: actor.account.id,
            subjectId: actor.account.subjectId,
            sessionId: actor.session.id,
            issuedAt: actor.session.createdAt,
            expiresAt,
          };
        },
      },
      identities: {
        async ensure(input) {
          const byAccount = await isolated.runtime.db.selectFrom('account_identities')
            .select(['issuer', 'subject']).where('account_id', '=', input.accountId).executeTakeFirst();
          if (!byAccount) throw new Error('identity_missing');
          return { issuer: byAccount.issuer, subject: byAccount.subject };
        },
      },
    }),
  );
  // One pull-cursor keyring, shared exactly as production shares it
  // (`sync-session-runtime.ts`): the Session issuer reissues the resume cursor
  // with it when an expired Replica resumes under a new lease generation
  // (`reissueExpiredResumeCursor`), and the recovery application, bootstrap
  // Snapshot and Pull reader all verify cursors against the same keys.
  const pullCursorKeys = createSyncPullCursorKeyring({ active: { id: 'p3-33-pull-v1',
    secret: Buffer.alloc(32, 33).toString('base64') }, retained: [], ttlMs: 300_000 });
  const issuer = createPostgresSyncSessionIssuer(isolated.runtime.db, {
    issuer: ISSUER,
    audience: AUDIENCE,
    clientId: CLIENT_ID,
    replayEncryptionKey: Buffer.alloc(32, 27),
    replayEncryptionKeyVersion: 1,
    sessionDurationSeconds: 900,
    replicaLeaseExtensionSeconds: 3_600,
    tombstoneRetentionSeconds: 86_400,
    maxBatchOperations: MAX_SYNC_BATCH_OPERATIONS,
    endpointCapabilities: ['syncSnapshot', 'syncPush', 'syncPull', 'syncAck', 'syncConflict'],
    // Production (`sync-session-runtime.ts`) always wires this port; without it a
    // `recovery_required` Replica's Session issue is denied `replica_recovery_required`,
    // which surfaces to the client as a 410 and re-enters the deadlock.
    retentionWindow: createPostgresReplicaRetentionWindowPort(`${SERVER_ORIGIN}/v1/snapshot`),
    pullCursorKeyring: pullCursorKeys,
    recoveryProofRetentionMs: 2_592_000_000,
  });

  const certificateDirectory = await mkdtemp(resolve(tmpdir(), 'known-p3-27-tls-'));
  const keyPath = resolve(certificateDirectory, 'key.pem');
  const certificatePath = resolve(certificateDirectory, 'certificate.pem');
  const opensslConfigPath = resolve(certificateDirectory, 'openssl.cnf');
  await writeFile(opensslConfigPath, `[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=v3\n[dn]\nCN=known.example\n[v3]\nsubjectAltName=DNS:known.example,DNS:identity.known.example\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`);
  await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certificatePath, '-days', '1', '-subj', '/CN=known.example',
    '-config', opensslConfigPath, '-extensions', 'v3']);
  const app = Fastify({ logger: false, https: {
    key: await readFile(keyPath),
    cert: await readFile(certificatePath),
  } }) as FastifyInstance;
  const classificationProduct=options.classification ? (await loadClassificationProductStack()).mountClassificationProductFixture(app,isolated.runtime,browserSessionAuthority,EXTENSION_ORIGIN,options.syntheticCapture) : undefined;
  // Preferences use the real Product cookie/CSRF authority and PostgreSQL
  // storage, independently of whether this scenario enables classification.
  app.register(async product => {
    const identityUnitOfWork = createPostgresIdentityUnitOfWork(isolated.runtime.db);
    if (!options.classification) {
      product.decorate('browserSessionAuthority', browserSessionAuthority);
      installProductAdmission(product);
      const base = loadConfig({ KNOWN_FEATURE_EXPORT_JOBS: 'false', NODE_ENV: 'test', DATABASE_URL: 'postgres://fixture/unused',
        PRODUCT_ORIGIN: SERVER_ORIGIN, ALLOWED_ORIGINS: SERVER_ORIGIN,
        OIDC_ISSUER: ISSUER, OIDC_CLIENT_ID: 'fixture',
        OIDC_REDIRECT_URI: `${SERVER_ORIGIN}/api/v1/auth/oidc/callback`,
        OIDC_AUTHORIZATION_ENDPOINT: `${ISSUER}authorize`, OIDC_TOKEN_ENDPOINT: `${ISSUER}token`,
        OIDC_ALLOW_TEST_PROVIDER: 'true', OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-preferences-fixture-not-production' });
      const config = { ...base, betterAuth: { ...base.betterAuth, enabled: true,
        trustedOrigins: [EXTENSION_ORIGIN, SERVER_ORIGIN] } };
      registerSessionMeRoutes(product, { config, identityUnitOfWork, browserSessionAuthority });
      if (options.web) await (await import('./library-web-stack.js')).mountLibraryWebFixture(product, isolated.runtime, config, identityUnitOfWork);
    }
    product.setErrorHandler((error, request, reply) => sendProductError(request, reply,
      error instanceof ProductHttpError ? error : new ProductHttpError({ statusCode: 500,
        code: 'internal_error', message: 'Fixture Product error.' })));
    subscriptionProduct?.register(product);
    registerBookmarkPreferencesRoutes(product, { identityUnitOfWork,
      allowedOrigins: [EXTENSION_ORIGIN, SERVER_ORIGIN],
      queryStore: createPostgresBookmarkPreferencesQuery(isolated.runtime.db),
      commandUnitOfWork: createPostgresBookmarkPreferencesUnitOfWork(isolated.runtime.db) });
  });
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    const path = request.url.split('?', 1)[0] ?? '';
    if(options.classification && path.startsWith('/api/v1/') && !path.startsWith('/api/v1/auth/'))return;
    const betterAuthOrigin = typeof origin === 'string' && origin === EXTENSION_ORIGIN
      && path.startsWith('/api/v1/auth');
    if (origin === EXTENSION_ORIGIN) {
      reply.header('Access-Control-Allow-Origin', EXTENSION_ORIGIN);
      reply.header('Access-Control-Allow-Credentials', 'true');
      reply.header('Vary', 'Origin');
      reply.header('Access-Control-Allow-Headers',
        betterAuthOrigin
          ? 'Authorization, Content-Type, Cookie, Origin, X-CSRF-Token, X-Known-Auth-Intent'
          : 'Authorization, Content-Type, Cookie, Origin, Idempotency-Key, If-Match, If-None-Match, X-CSRF-Token, Known-Command-Id, Known-Subscription-Exit-Preview, Known-Sync-Session, Collection-Protocol-Version');
      reply.header('Access-Control-Expose-Headers', 'ETag, Known-Bookmark-Session, Known-Subscription-Session, Retry-After');
      reply.header('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
    }
    if (request.method === 'OPTIONS' && origin === EXTENSION_ORIGIN) {
      return reply.code(204).send();
    }
  });
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' },
    (_request, body, done) => done(null, body));
  let disconnectPushResponses = false;
  const lostBatchResponses = new Set<string>();
  let pushFault: PushFault = 'none';
  const pushRequests: PushRequestObservation[] = [];
  const pushRequestIndexes = new Map<string, number>();
  const pushResponses: string[] = [];
  const pullResponses: Array<{ status: number; contentType: string; code?: string }> = [];
  app.addHook('onSend', async (request, reply, payload) => {
    if (!request.url.startsWith('/v1/pull')) return payload;
    let code: string | undefined;
    try { const parsed = JSON.parse(String(payload)) as { code?: unknown };
      if (typeof parsed.code === 'string') code = parsed.code; } catch { /* response shape is checked by the client */ }
    pullResponses.push({ status: reply.statusCode, contentType: String(reply.getHeader('content-type') ?? ''),
      ...(code ? { code } : {}) }); return payload;
  });
  app.addHook('preParsing', async (request, reply, payload) => {
    if (request.url !== '/v1/push' || request.method !== 'POST') return payload;
    const chunks: Buffer[] = [];
    for await (const chunk of payload) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString('utf8');
    pushRequestIndexes.set(request.id, pushRequests.length);
    pushRequests.push({ url: request.url, headers: redactSensitiveHeaders(request.headers), body,
      fingerprint: createHash('sha256').update(body).digest('hex'),
      sessionCookiePresent: typeof request.headers.cookie === 'string'
        && request.headers.cookie.includes('__Host-known_session='),
      bearerAuthorizationPresent: typeof request.headers.authorization === 'string'
        && request.headers.authorization.startsWith('Bearer ') });
    const replay = Readable.from([Buffer.from(body)]);
    const push = JSON.parse(body) as { readonly batchId: string;
      readonly operations: readonly [{ readonly opId: string; readonly sequence: number }] };
    const activeFault = pushFault;
    if (activeFault === 'lost_batch_response_once' && push.operations.length > 1) {
      lostBatchResponses.add(request.id);
      pushFault = 'none';
    } else if (pushFault !== 'sequence_gap' && pushFault !== 'lost_batch_response_once') pushFault = 'none';
    if (activeFault === 'authentication_required_once') {
      await reply.code(401).type('application/problem+json').send({ type: 'about:blank', title: 'Authentication required',
        status: 401, code: 'authentication_required', retryable: true });
    } else if (activeFault === 'service_unavailable_once') {
      await reply.code(503).type('application/problem+json').send({ type: 'about:blank', title: 'Unavailable',
        status: 503, code: 'service_unavailable', retryable: true });
    } else if (activeFault === 'rate_limited_once') {
      reply.header('Retry-After', '1'); await reply.code(429).type('application/problem+json').send({ type: 'about:blank',
        title: 'Rate limited', status: 429, code: 'rate_limited', retryable: true });
    } else if (activeFault === 'sequence_gap_once' || activeFault === 'sequence_gap' || activeFault === 'sequence_blocked_once') {
      const code = activeFault === 'sequence_blocked_once' ? 'sequence_blocked' : 'sequence_gap';
      await reply.code(409).type('application/problem+json').send({
        type: `https://know-n.com/colp/problems/${code}`, title: code, status: 409, code,
        expectedSequence: push.operations[0].sequence, retryable: true });
    } else if (activeFault === 'deferred_once') {
      const operation = push.operations[0];
      await reply.code(200).type('application/json').send({ batchId: push.batchId, results: [{ opId: operation.opId,
        sequence: operation.sequence, status: 'deferred', code: 'pending_parent', retryAfterSeconds: 1, warnings: [] }],
      serverCursor: 'cursor-0' });
    } else if (activeFault === 'timeout_once') {
      await new Promise<void>((resolveDelay) => {
        const timer = setTimeout(resolveDelay, 20_000); timer.unref();
        request.raw.once('aborted', () => { clearTimeout(timer); resolveDelay(); });
      });
      request.raw.socket.destroy();
    }
    return replay;
  });
  app.addHook('onSend', async (request, reply, payload) => {
    const origin = request.headers.origin;
    if (origin === EXTENSION_ORIGIN) reply.header('Access-Control-Allow-Origin', EXTENSION_ORIGIN);
    reply.header('Cache-Control', 'no-store');
    if (request.url === '/v1/push') {
      const body = Buffer.isBuffer(payload) ? payload.toString('utf8')
        : typeof payload === 'string' ? payload : '[streamed-response]';
      pushResponses.push(body);
      const index = pushRequestIndexes.get(request.id);
      pushRequestIndexes.delete(request.id);
      if (index !== undefined) {
        let responseCode: string | undefined;
        try { const parsed = JSON.parse(body) as { code?: unknown };
          if (typeof parsed.code === 'string') responseCode = parsed.code; } catch { /* streamed response */ }
        pushRequests[index] = { ...pushRequests[index]!, responseStatus: reply.statusCode,
          ...(responseCode ? { responseCode } : {}) };
      }
    }
    if ((disconnectPushResponses && request.url === '/v1/push') || lostBatchResponses.delete(request.id)) request.raw.socket.destroy();
    return payload;
  });

  let mode: IssuerMode = 'normal';
  let syncOffline = false; let syncOfflineBlockedRequests = 0;
  const effectPageRateLimitPages = new Set<number>();
  let revokeCount = 0;
  let accessCount = 0;
  let latestAccessToken: string | undefined;
  let auxiliaryAuthority: { readonly sessionId: string; nextSequence: number } | undefined;
  const pushRequestDigests: string[] = [];
  const pushErrors: Array<{ readonly name: string; readonly code?: string; readonly message: string;
    readonly stack?: string }> = [];

  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?', 1)[0] ?? '';
    const effectPageMatch = request.method === 'GET'
      ? /^\/v1\/effects\/[^/]+\/pages\/(\d+)$/u.exec(path) : null;
    const effectPageNumber = effectPageMatch ? Number(effectPageMatch[1]) : 0;
    if (effectPageNumber > 0 && effectPageRateLimitPages.delete(effectPageNumber)) {
      // This fault is deliberately installed only by the real-stack test
      // harness. The response still crosses the production Fastify boundary,
      // allowing the MV3 durable downloader to exercise Retry-After handling.
      return reply.code(429).header('Retry-After', '1').type('text/plain')
        .send(`effect page ${effectPageNumber} rate limited`);
    }
    if (syncOffline && (path === '/v1/push' || path === '/v1/pull')) {
      syncOfflineBlockedRequests += 1;
      request.raw.socket.destroy();
      return reply.hijack();
    }
    if (mode === 'offline' && request.method === 'POST' && path === '/api/v1/auth/sign-in/email') {
      request.raw.socket.destroy();
    }
    if (request.method === 'POST' && path === '/api/v1/auth/sign-out') revokeCount += 1;
  });
  registerBetterAuthRoutes(app, {
    betterAuthRuntime: baRuntime,
    allowedOrigins: [EXTENSION_ORIGIN, SERVER_ORIGIN],
  });
  app.get('/.well-known/jwks.json', async () => jwks);
  app.get('/.well-known/collection-protocol', async () => manifest());
  app.get('/__test/health', async () => ({ ok: true, engine: 'postgresql' }));

  registerSyncSessionRoutes(app, {
    path: '/v1/session',
    allowedOrigins: [EXTENSION_ORIGIN],
    credentialVerifier,
    // Production bootstrap enables gen-1 auto-registration (bootstrap/api.ts);
    // fresh extension installs mint their own replica and rely on it.
    application: createPostgresSyncSessionHttpApplication(isolated.runtime.db, issuer, {
      registerUnknownGenerationOneReplica: true,
      registrationLeaseSeconds: 3_600,
    }),
    rateLimit: { maxRequests: 100, windowMs: 60_000 },
  });
  registerSyncRetireRoutes(app, {
    path: '/extensions/sync-retire',
    allowedOrigins: [EXTENSION_ORIGIN],
    credentialVerifier,
    application: createPostgresReplicaRetirementApplication(isolated.runtime.db),
    rateLimit: { maxRequests: 100, windowMs: 60_000 },
  });
  const pushApplication = createPostgresSyncPushApplication(isolated.runtime.db, issuer, {
    conflictPayloadEncryption: { key: Buffer.alloc(32, 31), keyVersion: 1 },
    effectPageAuthority: SERVER_ORIGIN,
    effectPageTemplate: `${SERVER_ORIGIN}/v1/effects/{effectId}/pages/{pageNumber}`,
  });
  registerSyncPushRoutes(app, { path: '/v1/push', allowedOrigins: [EXTENSION_ORIGIN], credentialVerifier,
    application: { ...pushApplication, async admit(input) { pushRequestDigests.push(input.requestFingerprint);
      try { return await pushApplication.admit(input); } catch (error) {
        const value = error as Error & { readonly code?: string; readonly cause?: unknown };
        const cause = value.cause instanceof Error ? value.cause : undefined;
        pushErrors.push({ name: value.name,
          ...(value.code ? { code: value.code } : {}), message: value.message,
          ...(cause ? { detail: cause.message } : {}),
          ...(value.stack ? { stack: value.stack } : {}) });
        throw error;
      } } }, rateLimit: { maxRequests: 100, windowMs: 60_000 },
    maxBatchOperations: MAX_SYNC_BATCH_OPERATIONS });
  registerSyncConflictRoutes(app, {
    pathTemplate: '/v1/conflicts/{conflictId}', allowedOrigins: [EXTENSION_ORIGIN], credentialVerifier,
    application: createPostgresSyncConflictResolutionApplication(isolated.runtime.db, issuer, {
      conflictPayloadKeyring: { active: { key: Buffer.alloc(32, 31), keyVersion: 1 }, retained: [] },
    }), rateLimit: { maxRequests: 100, windowMs: 60_000 },
  });
  // Production (`sync-session-runtime.ts`) builds this application: it issues the
  // `recoveryCapability` attached to the LAST Snapshot page and owns the recovery Ack
  // path. Without it the snapshot factory's `...(recovery ? {...} : {})` gate leaves
  // `issueRecoveryCapability` unwired, so a recovery Snapshot can never carry the
  // capability the client is required to present — the deadlock would persist in the
  // harness even with the server-side fix in place.
  const recovery = createPostgresSyncRecoveryApplication(isolated.runtime.db, {
    capabilityKeys: createSyncRecoveryCapabilityKeyring({ active: { id: 'p3-33-recovery-v1',
      secret: Buffer.alloc(32, 35).toString('base64') }, retained: [], ttlMs: 300_000 }),
    leaseExtensionSeconds: 600,
    maxLeaseLifetimeSeconds: 3_600,
    pullCursorKeyring: pullCursorKeys,
    recoveryProofRetentionMs: 2_592_000_000,
  });
  registerSyncSnapshotRoutes(app, { path: '/v1/snapshot', allowedOrigins: [EXTENSION_ORIGIN], credentialVerifier,
    application: createPostgresSyncBootstrapSnapshotApplication(isolated.runtime, { cursorSecret: Buffer.alloc(32, 34),
      cursorKeyId: 'p3-33-snapshot-v1', cursorTtlMs: 300_000, pullCursorKeyring: pullCursorKeys,
      recovery, recoveryProofRetentionMs: 2_592_000_000,
      attachmentExposure: createAttachmentExposurePolicyAdapter(
        createPostgresSharedExposureFactsPort(isolated.runtime),
      ) }),
    rateLimit: { maxRequests: 100, windowMs: 60_000 } });
  registerSyncPullRoutes(app, { path: '/v1/pull', allowedOrigins: [EXTENSION_ORIGIN], credentialVerifier,
    reader: createPostgresSyncPullReadPort(isolated.runtime.db, pullCursorKeys, {
      effectPageAuthority: SERVER_ORIGIN,
      effectPageTemplate: `${SERVER_ORIGIN}/v1/effects/{effectId}/pages/{pageNumber}`,
    }),
    rateLimit: { maxRequests: 100, windowMs: 60_000 }, maxLimit: 200, responseBudgetBytes: 1_048_576,
    requestTimeoutMs: 5_000, recommendedPullAfterSeconds: 1, snapshotUrl: `${SERVER_ORIGIN}/v1/snapshot` });
  // Keep the Extension real-stack harness on the same production reader and
  // transport as the API.  Without this registration the manifest advertises
  // effect pages, but a real MV3 Pull can only ever receive a 404 after the
  // first paged subtree effect.
  registerSyncEffectPageRoutes(app, {
    pathTemplate: '/v1/effects/{effectId}/pages/{pageNumber}',
    allowedOrigins: [EXTENSION_ORIGIN], credentialVerifier,
    reader: createPostgresSyncEffectPageReadPort(isolated.runtime.db),
    responseBudgetBytes: 2 * 1024 * 1024,
    rateLimit: { subjectMaxRequests: 100, effectMaxRequests: 24,
      ipMaxRequests: 100, windowMs: 60_000 },
  });
  const ordinaryAck = createPostgresSyncAckApplication(isolated.runtime.db, { leaseExtensionSeconds: 600,
    maxLeaseLifetimeSeconds: 3_600 });
  registerSyncAckRoutes(app, { path: '/v1/ack', allowedOrigins: [EXTENSION_ORIGIN], credentialVerifier,
    // Production (`sync-session-runtime.ts`) routes recovery Acks by the explicit
    // `recoveryCapability` protocol field, with legacy 0.1 clients carrying it in the
    // cursor. Without this split a 0.2 recovery Ack reaches the ordinary path, whose
    // `replica.status !== 'active'` check answers `stale_replica` — a 410 loop.
    application: Object.freeze({ async acknowledge(input: Parameters<typeof ordinaryAck.acknowledge>[0]) {
      if (input.request.recoveryCapability === undefined && !input.request.cursor.startsWith('src1.')) {
        return ordinaryAck.acknowledge(input);
      }
      return recovery.acknowledge(input);
    } }), rateLimit: { maxRequests: 100, windowMs: 60_000 },
    maxBodyBytes: 16_384, maxWarnings: 8, maxWarningBytes: 2_048 });
  registerExtensionCollectionRoutes(app, {
    libraryCollectionUnitOfWork: createPostgresLibraryCollectionUnitOfWork(isolated.runtime.db),
    ownerAccount: createPostgresExtensionOwnerAccountPort(isolated.runtime.db),
    credentialVerifier,
    ownerSubject: createPostgresExtensionOwnerSubjectPort(isolated.runtime.db),
    ownedCollectionsQuery: {
      reads: createPostgresOwnedCollectionsReadPort(isolated.runtime.db),
      cursors: createProductOwnedCollectionsCursorSigner({
        current: { id: 'e2e-owned-cursor', key: Buffer.alloc(32, 29).toString('base64') } }),
      clock: { now: async () => new Date() },
    },
    allowedOrigins: [EXTENSION_ORIGIN],
  });

  // FO-04: the four extension favicon helper operations under /colp/v0.1/sync
  // reuse the same COLP extension credential authority. Gated by
  // KNOWN_FEATURE_FAVICON_POLICY (the harness adopts the production env var);
  // off => every helper operation 404.
  for (const type of [
    'image/png', 'image/jpeg', 'image/webp', 'image/x-icon',
    'image/vnd.microsoft.icon', 'application/octet-stream',
  ]) {
    if (app.hasContentTypeParser(type)) continue;
    app.addContentTypeParser(type, { parseAs: 'buffer' },
      (_request, body: unknown, done) => done(null, body));
  }
  // The REAL service worker captures tab favicons over the network
  // (captureTabFavicon). The fixture keeps a tiny PNG at /favicon.png so the
  // durable engine's save path materializes a sidecar end-to-end through the
  // browser fetch boundary, then the drain posts those bytes via the helper.
  const fixtureFaviconPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  app.get('/favicon.png', async (_request, reply) => {
    reply.type('image/png').header('cache-control', 'no-store').send(fixtureFaviconPng);
  });
  app.get('/site.html', async (_request, reply) => {
    reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(
      '<!doctype html><html><head><title>FO-04 fixture page</title>'
      + '<link rel="icon" href="/favicon.png" type="image/png"></head>'
      + '<body><h1>FO-04 fixture page</h1></body></html>');
  });
  const faviconObjectStore = createMemoryFaviconObjectStore();
  const faviconHelperIdentity = createPostgresIdentityUnitOfWork(isolated.runtime.db);
  const faviconHelperCollections = createPostgresCollectionsUnitOfWork(isolated.runtime.db);
  if (knowNBackendRoot) (await import('../../server/src/transport/colp-sync/sync-favicon-helper-routes.js')).registerSyncFaviconHelperRoutes(app, {
    enabled: process.env.KNOWN_FEATURE_FAVICON_POLICY === 'true',
    extensionCollectionRoutes: {
      credentialVerifier,
      ownerSubject: createPostgresExtensionOwnerSubjectPort(isolated.runtime.db),
      ownedCollectionsQuery: {
        reads: createPostgresOwnedCollectionsReadPort(isolated.runtime.db),
        cursors: createProductOwnedCollectionsCursorSigner({
          current: { id: 'e2e-owned-cursor', key: Buffer.alloc(32, 29).toString('base64') } }),
        clock: { now: async () => new Date() },
      },
      allowedOrigins: [EXTENSION_ORIGIN],
    },
    identityUnitOfWork: faviconHelperIdentity,
    collectionsUnitOfWork: faviconHelperCollections,
    faviconStore: faviconObjectStore,
    productOrigin: SERVER_ORIGIN,
    rateLimiter: createFixedWindowRateLimiter({ maxRequests: 120, windowMs: 60_000 }),
    timeoutMs: 2_000,
  });
  if (!fixtureAuthUserId) throw new Error('fixture Better Auth user is missing');
  const authUserId = fixtureAuthUserId;
  let observationOffset = { sessions: 0, receipts: 0 };
  const replicaCheckpoints = new Map<string, string>();
  const httpsPort = await listenOnLoopbackHttps(app);
  const browserHostResolverRules = [
    `MAP known.example:443 127.0.0.1:${httpsPort}`,
    `MAP identity.known.example:443 127.0.0.1:${httpsPort}`,
    ...(options.classification?[`MAP api.cloudflare.com:443 127.0.0.1:${httpsPort}`]:[]),
  ].join(',');
  try {
    await mintAuxiliaryAccessToken();
    if (!options.freshLibrary) for (const binding of [
      { replicaId: REPLICA_ID, browserProfileId: PROFILE_ID },
      ...P3_29_BINDINGS,
    ]) await bootstrapReplicaCheckpoint(binding);
    observationOffset = await sessionReceiptCounts();
  } catch (error) {
    await app.close().catch(() => undefined);
    pullCursorKeys.destroy();
    await isolated.close().catch(() => undefined);
    await rm(certificateDirectory, { recursive: true, force: true });
    throw error;
  }

  async function mintAuxiliaryAccessToken() {
    accessCount += 1;
    const seconds = Math.floor(Date.now() / 1_000);
    const credentialId = `p3-27-access-${accessCount}`;
    const accessToken = await new SignJWT({ scope: 'openid offline_access known.sync', client_id: CLIENT_ID })
      .setProtectedHeader({ alg: 'RS256', kid: 'p3-27-rs256' })
      .setIssuer(ISSUER).setSubject(fixtureAccount?.subjectId ?? SUBJECT).setAudience(AUDIENCE)
      .setIssuedAt(seconds).setExpirationTime(seconds + 300)
      .setJti(credentialId).sign(keys.privateKey);
    latestAccessToken = accessToken;
    return accessToken;
  }

  return {
    subscriptionProduct,
    classificationProduct,
    browserHostResolverRules,
    extensionBinding: { replicaId: REPLICA_ID, browserProfileId: PROFILE_ID, generation: '1' },
    extensionBindings: [{ replicaId: P3_29_BINDINGS[0].replicaId,
      browserProfileId: P3_29_BINDINGS[0].browserProfileId, generation: '1' }, {
      replicaId: P3_29_BINDINGS[1].replicaId,
      browserProfileId: P3_29_BINDINGS[1].browserProfileId, generation: '1' }],
    authUserId,
    get collectionId() { return activeLibraryId; },
    serverOrigin: SERVER_ORIGIN,
    setMode(value) { mode = value; },
    setSyncOffline(value) { syncOffline = value; },
    async setFixtureCollectionUnavailable(value) {
      const client = await isolated.runtime.pool.connect(), deletedAt = value ? new Date() : null;
      try {
        await client.query('begin');
        await client.query('set constraints all deferred');
        await client.query('update nodes set deleted_at=$1 where collection_id=$2 and is_root', [deletedAt, COLLECTION_ID]);
        await client.query('update collections set deleted_at=$1 where id=$2', [deletedAt, COLLECTION_ID]);
        await client.query('commit');
      } catch (error) { await client.query('rollback'); throw error; }
      finally { client.release(); }
    },
    async setFaviconPolicyForFixture(patch) {
      const { updateMyFaviconPolicy } = await import('../../server/src/modules/collections/index.js');
      // Real updateMyFaviconPolicy command through the REAL postgres
      // collections unit of work: one production-command execution (the same
      // app command the Product PATCH route invokes), no hand-built handler.
      if (!fixtureAccount) throw new Error('fixture account missing');
      const account = fixtureAccount;
      const policyRow = await isolated.runtime.pool.query(
        `select revision from account_favicon_policies where account_id=$1`,
        [account.id]);
      const revision = policyRow.rows[0]?.revision as string | undefined ?? '1';
      const outcome = await faviconHelperCollections.execute((ports) => {
        // The postgres collections write ports carry the FO-03 batch ports
        // (createPostgresFaviconBatchWritePorts is spread into them); the
        // CollectionsWritePorts interface keeps them optional so memory
        // doubles still compile.
        const required = ports as CollectionsWritePorts & {
          faviconBatchJobs: FaviconPolicyCommandPorts['batchJobs']['jobs'];
          faviconBatchCandidates: FaviconPolicyCommandPorts['batchJobs']['candidates'];
          faviconRestoreRead: FaviconPolicyCommandPorts['batchJobs']['restores'];
        };
        return updateMyFaviconPolicy({
          receipts: ports.receipts,
          clock: ports.clock,
          policies: ports.faviconPolicies!,
          batchJobs: {
            jobs: required.faviconBatchJobs,
            candidates: required.faviconBatchCandidates,
            restores: required.faviconRestoreRead,
          },
        }, {
          actor: { principalId: account.id, subjectId: account.subjectId },
          commandId: randomUUID(),
          expectedEtag: `"favicon-policy:${revision}"`,
          patch,
        });
      });
      if (outcome.kind === 'replay' || outcome.kind === 'in_progress' || outcome.kind === 'reused') {
        // The command id collision only happens when the same patch replays;
        // the spec uses a fresh UUID each time, so this is defensive.
        throw new Error(`favicon policy command not succeeded: ${outcome.kind}`);
      }
    },
    setEffectPageRateLimitPages(pageNumbers) {
      effectPageRateLimitPages.clear();
      for (const pageNumber of pageNumbers) {
        if (Number.isSafeInteger(pageNumber) && pageNumber > 0) effectPageRateLimitPages.add(pageNumber);
      }
    },
    async seedPagedSubtree(memberCount = 10_000) {
      if (!Number.isSafeInteger(memberCount) || memberCount < 513 || memberCount > 10_000) {
        throw new Error('q001_member_count_invalid');
      }
      const suffix = randomUUID().replaceAll('-', '');
      const rootId = `q001-root-${suffix}`;
      const rootRevision = `q001-root-revision-${suffix}`;
      const childrenRevision = `q001-children-revision-${suffix}`;
      const memberPrefix = `q001-member-${suffix}-`;
      const now = new Date(Math.floor(Date.now() / 1_000) * 1_000);
      const client = await isolated.runtime.pool.connect();
      try {
        await client.query('begin');
        await client.query("select set_config('known.sync_authority','server',true)");
        await client.query("insert into resource_id_ledger(resource_id,resource_type) values ($1,'node')", [rootId]);
        const rootPayload = {
          schemaVersion: 1, resourceType: 'node', id: rootId, collectionId: COLLECTION_ID, kind: 'folder',
          isRoot: false, folderRole: null, title: 'Q001 paged subtree', parentId: 'p3-27-root', url: null,
          description: null,
          position: `q001-${suffix}`, resourceRevision: rootRevision,
          childrenRevision, visibility: 'inherit', tags: [],
          createdAt: now.toISOString().replace('.000Z', 'Z'),
          updatedAt: now.toISOString().replace('.000Z', 'Z'), deletedAt: null,
          deletedCommitOrdinal: null, extensions: {},
        };
        await client.query(`insert into nodes
          (id,collection_id,parent_id,kind,is_root,title,url,description,tags,visibility,position_token,
           resource_revision,children_revision,created_at,updated_at,payload_json,payload_schema_version,payload_authority_status)
          values ($1,$2,'p3-27-root','folder',false,'Q001 paged subtree',null,null,'[]'::jsonb,'inherit',$3,
           $4,$5,$6,$6,$7,$8,'backfilled')`,
        [rootId, COLLECTION_ID, rootPayload.position, rootRevision, childrenRevision, now,
          rootPayload, RESOURCE_PAYLOAD_SCHEMA_VERSION]);
        await client.query(`insert into sync_node_revision_history
          (collection_id,resource_id,revision,kind,payload_json,commit_ordinal,operation_id)
          values ($1,$2,$3,'folder',$4,0,null)`, [COLLECTION_ID, rootId, rootRevision, rootPayload]);
        await client.query(`insert into resource_id_ledger(resource_id,resource_type)
          select $1::text || lpad(index::text, 5, '0'),'node' from generate_series(1,$2::int) as generated(index)`,
        [memberPrefix, memberCount - 1]);
        await client.query(`insert into nodes
          (id,collection_id,parent_id,kind,is_root,title,url,description,tags,visibility,position_token,
           resource_revision,children_revision,created_at,updated_at,payload_json,payload_schema_version,payload_authority_status)
          select $1::text || lpad(index::text, 5, '0'),$2::text,$3::text,'bookmark',false,
            'Q001 member ' || index::text,'https://example.test/q001/' || index::text,null,'[]'::jsonb,'inherit',
            'q001-' || lpad(index::text, 5, '0'),
            'q001-member-revision-' || lpad(index::text, 5, '0'),
            'q001-member-children-' || lpad(index::text, 5, '0'),$4,$4,
            jsonb_build_object('schemaVersion',1,'resourceType','node','id',$1::text || lpad(index::text, 5, '0'),
              'collectionId',$2::text,'kind','bookmark','isRoot',false,'folderRole',null,
              'title','Q001 member ' || index::text,'parentId',$3::text,
              'position','q001-' || lpad(index::text, 5, '0'),
              'resourceRevision','q001-member-revision-' || lpad(index::text, 5, '0'),
              'childrenRevision','q001-member-children-' || lpad(index::text, 5, '0'),
              'visibility','inherit','tags','[]'::jsonb,'extensions','{}'::jsonb,
              'description',null,'url','https://example.test/q001/' || index::text,
              'createdAt',to_char($4::timestamptz at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
              'updatedAt',to_char($4::timestamptz at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
              'deletedAt',null,'deletedCommitOrdinal',null),
            $5,'backfilled'
          from generate_series(1,$6::int) as generated(index)`,
        [memberPrefix, COLLECTION_ID, rootId, now, RESOURCE_PAYLOAD_SCHEMA_VERSION, memberCount - 1]);
        await client.query(`insert into sync_node_revision_history
          (collection_id,resource_id,revision,kind,payload_json,commit_ordinal,operation_id)
          select $1::text,$2::text || lpad(index::text, 5, '0'),'q001-member-revision-' || lpad(index::text, 5, '0'),
            'bookmark',jsonb_build_object('schemaVersion',1,'resourceType','node','id',$2::text || lpad(index::text, 5, '0'),
              'collectionId',$1::text,'kind','bookmark','isRoot',false,'folderRole',null,
              'title','Q001 member ' || index::text,'parentId',$3::text,
              'position','q001-' || lpad(index::text, 5, '0'),
              'resourceRevision','q001-member-revision-' || lpad(index::text, 5, '0'),
              'childrenRevision','q001-member-children-' || lpad(index::text, 5, '0'),
              'visibility','inherit','tags','[]'::jsonb,'extensions','{}'::jsonb,
              'description',null,'url','https://example.test/q001/' || index::text,
              'createdAt',to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
              'updatedAt',to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
              'deletedAt',null,'deletedCommitOrdinal',null),0,null
          from generate_series(1,$4::int) as generated(index)`,
        [COLLECTION_ID, memberPrefix, rootId, memberCount - 1]);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally { client.release(); }
      const authority = await getAuxiliaryAuthority();
      const deleted = await auxiliaryPush(authority, { type: 'delete_subtree', targetId: rootId,
        baseRevision: rootRevision, payload: { reason: 'q001-paged-effect' },
        source: subtreeDeleteSource(rootId, [{ id: rootId, revision: rootRevision },
          ...Array.from({ length: memberCount - 1 }, (_, offset) => ({
            id: `${memberPrefix}${String(offset + 1).padStart(5, '0')}`,
            revision: `q001-member-revision-${String(offset + 1).padStart(5, '0')}`,
          }))]) });
      const effect = await isolated.runtime.db.selectFrom('sync_operation_effects')
        .select(['effect_id', 'effect_json']).where('operation_id', '=', deleted.operationId).executeTakeFirst();
      if (!effect) throw new Error('q001_effect_missing');
      const effectRef = (effect.effect_json as { readonly effectRef?: {
        readonly pageCount?: unknown; readonly memberCount?: unknown;
      } } | undefined)?.effectRef;
      if (!effectRef || effectRef.pageCount !== Math.ceil(memberCount / 512)
          || effectRef.memberCount !== memberCount) throw new Error('q001_effect_not_paged');
      return { effectId: effect.effect_id, pageCount: Number(effectRef.pageCount), memberCount };
    },
    async canonicalSiblingOrder(parentId) {
      const result = await isolated.runtime.pool.query(`select id,parent_id,position_token,title,url
        from nodes where collection_id=$1 and parent_id=$2 and deleted_at is null
        order by position_token collate "C", id collate "C"`, [COLLECTION_ID, parentId]);
      return result.rows.map((row) => ({ id: String(row.id), parentId: String(row.parent_id),
        positionToken: String(row.position_token), title: String(row.title),
        url: row.url === null ? null : String(row.url) }));
    },
    async canonicalBookmarkExtensions(url) {
      const result = await isolated.runtime.pool.query(`select coalesce(payload_json->'extensions', '{}'::jsonb) as extensions
        from nodes where collection_id=$1 and kind='bookmark' and url=$2 and deleted_at is null order by id`, [COLLECTION_ID, url]);
      return result.rows.map((row) => row.extensions as Record<string, unknown>);
    },
    async observations() {
      const libraries = await isolated.runtime.pool.query('select id from collections where owner_subject_id=$1 and is_library and deleted_at is null', [fixtureAccount?.subjectId ?? SUBJECT]);
      if (libraries.rows[0]) activeLibraryId = libraries.rows[0].id;
      const sessions = await isolated.runtime.pool.query('select count(*)::int as count from sync_sessions');
      const receipts = await isolated.runtime.pool.query('select count(*)::int as count from sync_session_idempotency_receipts');
      const replica = await isolated.runtime.pool.query('select status from sync_replicas where replica_id=$1', [REPLICA_ID]);
      const mutations = await isolated.runtime.pool.query(
        'select count(*)::int as count from nodes where collection_id=$1 and not is_root and folder_role is null', [activeLibraryId]);
      const pushReceipt = await isolated.runtime.pool.query(`select result_digest,result_json from sync_sequence_receipts
        where replica_id=$1 order by sequence_number limit 1`, [REPLICA_ID]);
      const sequenceReceipts = await isolated.runtime.pool.query(`select sequence_number,operation_id as op_id,result_digest,result_json
        from sync_sequence_receipts where replica_id=$1 order by sequence_number`, [REPLICA_ID]);
      const canonicalNodes = await isolated.runtime.pool.query(`select id,parent_id,title,url,is_root,folder_role,deleted_at,
        position_token,resource_revision,children_revision from nodes where collection_id=$1 order by created_at,id`, [activeLibraryId]);
      const canonicalSiblings = await isolated.runtime.pool.query(`select id,parent_id,position_token,title,url
        from nodes where collection_id=$1 and not is_root and deleted_at is null
        order by parent_id collate "C", position_token collate "C", id collate "C"`, [activeLibraryId]);
      const canonicalSiblingOrders: Record<string, string[]> = {};
      for (const row of canonicalSiblings.rows) {
        const parentId = String(row.parent_id);
        (canonicalSiblingOrders[parentId] ??= []).push(String(row.id));
      }
      const baEvidence = await isolated.runtime.pool.query(`select
          (select count(*)::int from auth_users) as auth_users,
          (select count(*)::int from auth_user_account_map) as mappings,
          (select count(*)::int from accounts where id=$1) as fixture_account,
          (select count(*)::int from account_identities where account_id=$1 and issuer=$2 and subject=$3) as identity_row`,
        [fixtureAccount?.id ?? '', ISSUER, fixtureAccount?.subjectId ?? SUBJECT]);
      // FO-04/FO-07 favicon evidence: the real helper wrote these rows/objects.
      const faviconEvidence = {
        bindings: (await isolated.runtime.pool.query(
          `select node_id,object_id,content_type,byte_size from bookmark_icons
           where collection_id=$1 order by node_id`, [activeLibraryId])).rows,
        sources: (await isolated.runtime.pool.query(
          `select node_id,source_mode,revision from bookmark_icon_sources
           where collection_id=$1 order by node_id`, [activeLibraryId])).rows,
        policies: (await isolated.runtime.pool.query(
          `select account_id,new_default,revision from account_favicon_policies
           where account_id=$1`, [fixtureAccount?.id ?? ''])).rows,
        objectPuts: [...faviconObjectStore.puts], objectDeletes: [...faviconObjectStore.deletes],
        objectCount: faviconObjectStore.objects.size,
      };
      return { libraryCount: libraries.rowCount, revokeCount, syncOfflineBlockedRequests,
        sessions: Number(sessions.rows[0]?.count ?? 0) - observationOffset.sessions,
        receipts: Number(receipts.rows[0]?.count ?? 0) - observationOffset.receipts,
        replicaStatus: replica.rows[0]?.status,
        serverMutationCount: mutations.rows[0]?.count, serverReceiptDigest: pushReceipt.rows[0]?.result_digest,
        serverReceipt: pushReceipt.rows[0]?.result_json,
        pushRequestDigests: [...pushRequestDigests], pushRequests: structuredClone(pushRequests),
        pushResponses: [...pushResponses], pullResponses: [...pullResponses],
        sequenceReceipts: sequenceReceipts.rows, canonicalNodes: canonicalNodes.rows,
        canonicalSiblingRows: canonicalSiblings.rows, canonicalSiblingOrders, pushErrors: [...pushErrors],
        authMailboxEntries: structuredClone(fixtureAuthMailbox), baEvidence: baEvidence.rows[0],
        faviconEvidence };
    },
    async revokeCurrentCredential() {
      if (fixtureAccount) {
        await isolated.runtime.pool.query(
          'update known_auth_session_metadata set revoked_at=current_timestamp where account_id=$1 and revoked_at is null',
          [fixtureAccount.id]);
      }
      if (fixtureAuthUserId) {
        await isolated.runtime.pool.query(
          `update auth_sessions set "expiresAt"=current_timestamp - interval '1 second' where "userId"=$1`,
          [fixtureAuthUserId]);
      }
      await isolated.runtime.pool.query(
        'update sync_extension_credentials set revoked_at=current_timestamp where revoked_at is null');
    },
    setPushFault(value) { pushFault = value; },
    async forceFixtureReplicaRecovery() {
      await isolated.runtime.pool.query(`UPDATE sync_replicas SET status='recovery_required',
        lifecycle_revision=lifecycle_revision+1,
        wire_json=jsonb_set(wire_json,'{status}','"recovery_required"'::jsonb,true)
        WHERE replica_id=$1`, [REPLICA_ID]);
    },
    async seedCanonicalFixture(nestedBookmark = false) {
      const authority = await getAuxiliaryAuthority();
      const folderTitle = 'Authority folder'; const bookmarkTitle = 'Authority bookmark';
      const bookmarkUrl = 'https://example.test/p3-31/authority';
      const folder = await auxiliaryPush(authority, { type: 'create_node', baseRevision: null,
        payload: { parentId: 'p3-27-root', node: { kind: 'folder', title: folderTitle } } });
      const bookmark = await auxiliaryPush(authority, { type: 'create_node', baseRevision: null,
        payload: { parentId: nestedBookmark ? folder.targetId : 'p3-27-root', node: { kind: 'bookmark', title: bookmarkTitle, url: bookmarkUrl } } });
      const revisions = await isolated.runtime.pool.query(`select id,resource_revision,children_revision from nodes
        where collection_id=$1 and id=any($2::text[])`, [COLLECTION_ID,
        ['p3-27-root', folder.targetId, bookmark.targetId]]);
      const byId = new Map(revisions.rows.map((row) => [String(row.id), row]));
      // Seeded native projections represent an established replica. Advance
      // its checkpoint through public Pull/Ack before the browser signs in.
      await acknowledgeCanonicalFixture();
      const root = requiredCanonicalNode(byId, 'p3-27-root'); const folderNode = requiredCanonicalNode(byId, folder.targetId);
      const bookmarkNode = requiredCanonicalNode(byId, bookmark.targetId);
      return { rootId: 'p3-27-root', rootRevision: requiredChildrenRevision(root, 'p3-27-root'), rootResourceRevision: String(root.resource_revision),
        folderId: folder.targetId, folderRevision: requiredChildrenRevision(folderNode, folder.targetId), folderResourceRevision: String(folderNode.resource_revision),
        bookmarkId: bookmark.targetId, bookmarkRevision: String(bookmarkNode.resource_revision), bookmarkParentId: nestedBookmark ? folder.targetId : 'p3-27-root',
        folderTitle, bookmarkTitle, bookmarkUrl };
    },
    async concurrentlyUpdateCanonicalBookmark(fixture) {
      const authority = await getAuxiliaryAuthority();
      await auxiliaryPush(authority, { type: 'update_node_content', targetId: fixture.bookmarkId,
        baseRevision: fixture.bookmarkRevision, payload: { base: { title: fixture.bookmarkTitle,
          url: fixture.bookmarkUrl }, value: { title: 'Concurrent authority update', url: fixture.bookmarkUrl } } });
    },
    async commitAfterDisconnect() { disconnectPushResponses = true; },
    async restorePushResponses() { disconnectPushResponses = false; },
    async listDeletedCanonicalNodes() {
      const rows = await isolated.runtime.pool.query(`select id,parent_id,resource_revision,deleted_at,title,kind
        from nodes where collection_id=$1 and deleted_at is not null order by deleted_at,id`, [COLLECTION_ID]);
      return rows.rows.map((row) => ({
        id: String(row.id), parentId: row.parent_id === null ? null : String(row.parent_id),
        revision: String(row.resource_revision), deletedAt: new Date(row.deleted_at).toISOString(),
        titlePresent: typeof row.title === 'string' && row.title.length > 0, kind: String(row.kind),
      }));
    },
    async restoreDeletedNode(nodeId: string) {
      const rows = await isolated.runtime.pool.query(`select id,parent_id,resource_revision from nodes
        where collection_id=$1 and id=$2 and deleted_at is not null`, [COLLECTION_ID, nodeId]);
      const row = rows.rows[0];
      if (!row) throw new Error('restore_target_missing');
      const authority = await getAuxiliaryAuthority();
      await auxiliaryPush(authority, { type: 'restore_node', targetId: nodeId,
        baseRevision: String(row.resource_revision), payload: {} });
      const live = await isolated.runtime.pool.query(`select parent_id,resource_revision from nodes
        where collection_id=$1 and id=$2 and deleted_at is null`, [COLLECTION_ID, nodeId]);
      const restored = live.rows[0];
      if (!restored) throw new Error('restore_did_not_revive');
      return { revision: String(restored.resource_revision), parentId: String(restored.parent_id ?? '') };
    },
    async listProductTrash() {
      if (!fixtureAccount) throw new Error('fixture_account_missing');
      const ports = productTrashPorts();
      const page = await ports.execute((trash) => trash.listTrash({
        accountId: fixtureAccount!.id, subjectId: fixtureAccount!.subjectId,
        collectionId: COLLECTION_ID, limit: 100,
      }));
      return page.items.map((item) => ({
        deletionId: item.deletionId, nodeId: item.nodeId, kind: item.kind,
        revision: item.revision, title: item.title,
      }));
    },
    async restoreProductTrashBatch(items) {
      if (!fixtureAccount) throw new Error('fixture_account_missing');
      const ports = productTrashPorts();
      const outcome = await ports.execute((trash) => trash.restoreTrashBatch({
        accountId: fixtureAccount!.id, subjectId: fixtureAccount!.subjectId,
        collectionId: COLLECTION_ID, items, commandId: randomUUID(), fingerprint: randomUUID(),
      }));
      if (outcome.kind !== 'committed') throw new Error(`product_trash_batch_${outcome.kind}`);
      return { results: outcome.result.results };
    },
    async restoreProductTrashSubtree(deletionId, expectedRevision) {
      if (!fixtureAccount) throw new Error('fixture_account_missing');
      const ports = productTrashPorts();
      const outcome = await ports.execute((trash) => trash.restoreTrashSubtree({
        accountId: fixtureAccount!.id, subjectId: fixtureAccount!.subjectId,
        deletionId, expectedRevision, commandId: randomUUID(), fingerprint: randomUUID(),
      }));
      if (outcome.kind !== 'committed') throw new Error(`product_trash_subtree_${outcome.kind}`);
      return { results: outcome.result.results };
    },
    async close() {
      await app.close();
      pullCursorKeys.destroy();
      await isolated.close();
      await rm(certificateDirectory, { recursive: true, force: true });
    },
  };

  function productTrashPorts() {
    return createPostgresProductSyncCenterUnitOfWork(isolated.runtime.db, {
      cursorSecret: 'p1-03-real-stack-product-sync-trash-cursor-secret',
      conflictPayloadKeyring: { active: { key: Buffer.alloc(32, 71), keyVersion: 7 }, retained: [] },
    });
  }

  async function getAuxiliaryAuthority() {
    if (auxiliaryAuthority) return auxiliaryAuthority;
    const accessToken = latestAccessToken ?? await mintAuxiliaryAccessToken();
    const response = await publicJson('/v1/session', {
      Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json',
      'Idempotency-Key': randomUUID(), Origin: EXTENSION_ORIGIN,
    }, replicaSessionRequest(P3_29_BINDINGS[0]));
    if (response.status !== 201 || typeof response.body.sessionId !== 'string') throw new Error('auxiliary_session_failed');
    auxiliaryAuthority = { sessionId: response.body.sessionId, nextSequence: 1 }; return auxiliaryAuthority;
  }

  async function bootstrapReplicaCheckpoint(binding: { readonly replicaId: string; readonly browserProfileId: string }) {
    const accessToken = latestAccessToken ?? await mintAuxiliaryAccessToken();
    const session = await publicJson('/v1/session', {
      Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json',
      'Idempotency-Key': randomUUID(), Origin: EXTENSION_ORIGIN,
    }, replicaSessionRequest(binding));
    if (session.status !== 201 || typeof session.body.sessionId !== 'string') {
      throw new Error(`harness_bootstrap_session_failed:${binding.replicaId}:${session.status}:`
        + JSON.stringify(session.body));
    }
    if (session.body.collection?.snapshotRequired !== true) {
      replicaCheckpoints.set(binding.replicaId, session.body.collection.serverCursor);
      return;
    }
    const sessionId = session.body.sessionId;
    let pageCursor: string | undefined;
    let syncCursor: string | undefined;
    let recoveryCapability: string | undefined;
    for (;;) {
      const query = `/v1/snapshot?sessionId=${encodeURIComponent(sessionId)}&limit=100`
        + (pageCursor ? `&pageCursor=${encodeURIComponent(pageCursor)}` : '');
      const snapshot = await publicHttps('GET', query, {
        Authorization: `Bearer ${accessToken}`, Origin: EXTENSION_ORIGIN,
      });
      if (snapshot.status !== 200 || typeof snapshot.body.syncCursor !== 'string') {
        throw new Error(`harness_bootstrap_snapshot_failed:${binding.replicaId}:${snapshot.status}:`
          + JSON.stringify(snapshot.body));
      }
      syncCursor = snapshot.body.syncCursor;
      if (typeof snapshot.body.recoveryCapability === 'string') recoveryCapability = snapshot.body.recoveryCapability;
      if (snapshot.body.page?.hasMore !== true) break;
      if (typeof snapshot.body.page?.nextCursor !== 'string') {
        throw new Error(`harness_bootstrap_snapshot_page_missing:${binding.replicaId}`);
      }
      pageCursor = snapshot.body.page.nextCursor;
    }
    const ack = await publicJson('/v1/ack', {
      Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json',
      'Idempotency-Key': randomUUID(), Origin: EXTENSION_ORIGIN, 'Known-Sync-Session': sessionId,
    }, {
      sessionId, cursor: syncCursor, warnings: [],
      ...(recoveryCapability ? { recoveryCapability } : {}),
    });
    if (ack.status !== 200 || ack.body.ackedCursor !== syncCursor) {
      throw new Error(`harness_bootstrap_ack_failed:${binding.replicaId}:${ack.status}:`
        + JSON.stringify(ack.body));
    }
    replicaCheckpoints.set(binding.replicaId, syncCursor!);
  }

  async function acknowledgeCanonicalFixture() {
    const binding = { replicaId: REPLICA_ID, browserProfileId: PROFILE_ID };
    const accessToken = latestAccessToken ?? await mintAuxiliaryAccessToken();
    const headers = { Authorization: `Bearer ${accessToken}`, Origin: EXTENSION_ORIGIN };
    const session = await publicJson('/v1/session', { ...headers, 'Content-Type': 'application/json',
      'Idempotency-Key': randomUUID() }, replicaSessionRequest(binding));
    if (session.status !== 201) throw new Error(`fixture_checkpoint_session_failed:${session.status}`);
    const sessionId = String(session.body.sessionId);
    let cursor = replicaCheckpoints.get(REPLICA_ID);
    if (!cursor) throw new Error('fixture_checkpoint_missing');
    for (;;) {
      const page = await publicHttps('GET', `/v1/pull?sessionId=${encodeURIComponent(sessionId)}`
        + `&cursor=${encodeURIComponent(cursor)}&limit=100`, headers);
      if (page.status !== 200 || typeof page.body.nextCursor !== 'string') {
        throw new Error(`fixture_checkpoint_pull_failed:${page.status}:${String(page.body.code)}`);
      }
      cursor = page.body.nextCursor;
      if (page.body.hasMore !== true) break;
    }
    const ack = await publicJson('/v1/ack', { ...headers, 'Content-Type': 'application/json',
      'Idempotency-Key': randomUUID(), 'Known-Sync-Session': sessionId }, { sessionId, cursor, warnings: [] });
    if (ack.status !== 200 || ack.body.ackedCursor !== cursor) throw new Error(`fixture_checkpoint_ack_failed:${ack.status}`);
    replicaCheckpoints.set(REPLICA_ID, cursor);
  }

  async function sessionReceiptCounts() {
    const sessions = await isolated.runtime.pool.query('select count(*)::int as count from sync_sessions');
    const receipts = await isolated.runtime.pool.query(
      'select count(*)::int as count from sync_session_idempotency_receipts');
    return { sessions: Number(sessions.rows[0]?.count ?? 0), receipts: Number(receipts.rows[0]?.count ?? 0) };
  }

  async function auxiliaryPush(authority: { readonly sessionId: string; nextSequence: number }, operation: {
    readonly source?: ReturnType<typeof subtreeDeleteSource>;
    readonly type: string; readonly targetId?: string; readonly baseRevision: string | null;
    readonly payload: Record<string, unknown> }) {
    if (!latestAccessToken) throw new Error('auxiliary_credential_unavailable');
    const sequence = authority.nextSequence; const opId = `setup-op-${sequence}-${randomUUID()}`;
    // F021 session-bound batchId (`sync-push-routes`): a batch is only accepted as
    // `batchId === sessionId` or `${sessionId}.<non-empty suffix>`. The extension's own
    // worker already binds it that way; this fixture sent a bare `setup-batch-…`, so every
    // auxiliary push answered 422 `invalid_document` with no visible cause - which is what
    // had been breaking mv3-pull-applier and mv3-outbound-push.
    const batchId = `${authority.sessionId}.setup-batch-${sequence}-${randomUUID()}`;
    const document = { sessionId: authority.sessionId, batchId, atomic: false, operations: [{ opId,
      replicaId: P3_29_BINDINGS[0].replicaId, sequence, collectionId: COLLECTION_ID, type: operation.type,
      ...(operation.targetId ? { targetId: operation.targetId } : {}), baseRevision: operation.baseRevision,
      occurredAt: new Date().toISOString(), dependencies: [], payload: operation.payload,
      ...(operation.source ? { source: operation.source } : {}) }] };
    const validation = createValidatorRegistry().validate('syncPush', document);
    if (!validation.valid) throw new Error(`auxiliary_push_contract_invalid:${JSON.stringify(validation.errors)}`);
    const response = await publicJson('/v1/push', { Authorization: `Bearer ${latestAccessToken}`,
      'Content-Type': 'application/json', 'Idempotency-Key': `setup-key-${sequence}-${randomUUID()}`,
      Origin: EXTENSION_ORIGIN }, document);
    if (response.status !== 200 || !Array.isArray(response.body.results)) {
      const problem = response.body && typeof response.body === 'object' ? response.body as Record<string, unknown> : {};
      throw new Error(`auxiliary_push_failed:${response.status}:${String(problem.code ?? 'invalid_body')}:`
        + JSON.stringify({ errors: problem.errors ?? null,
          applicationError: pushErrors.at(-1) ? { name: pushErrors.at(-1)!.name,
            code: pushErrors.at(-1)!.code, message: pushErrors.at(-1)!.message,
            detail: (pushErrors.at(-1) as { detail?: string }).detail ?? null } : null }));
    }
    const result = response.body.results[0] as Record<string, unknown> | undefined;
    if (!result || !['applied', 'rebased', 'noop'].includes(String(result.status))) {
      throw new Error(`auxiliary_push_not_applied:${String(result?.status)}`);
    }
    authority.nextSequence += 1;
    return { operationId: opId, targetId: typeof result.targetId === 'string' ? result.targetId : operation.targetId ?? '',
      revision: String(result.revision ?? '') };
  }

  async function publicJson(path: string, headers: Record<string, string>, body: unknown): Promise<{
    readonly status: number; readonly body: Record<string, any> }> {
    return publicHttps('POST', path, headers, body);
  }

  async function publicHttps(method: 'GET' | 'POST', path: string, headers: Record<string, string>,
    body?: unknown): Promise<{ readonly status: number; readonly body: Record<string, any> }> {
    const encoded = method === 'POST' ? JSON.stringify(body) : undefined;
    return new Promise((resolveRequest, rejectRequest) => {
      const request = httpsRequest({ host: '127.0.0.1', port: httpsPort, servername: 'known.example', path, method,
        rejectUnauthorized: false, headers: { ...headers, Host: 'known.example', Accept: 'application/json',
          ...(encoded === undefined ? {} : { 'Content-Length': Buffer.byteLength(encoded) }) } }, (response) => {
        const chunks: Buffer[] = []; response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => { try { resolveRequest({ status: response.statusCode ?? 0,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, any> }); }
        catch (error) { rejectRequest(error); } });
      });
      request.on('error', rejectRequest); request.end(encoded);
    });
  }
}

function replicaSessionRequest(binding: { readonly replicaId: string; readonly browserProfileId: string }) {
  return { protocolVersion: '0.2', replica: { replicaId: binding.replicaId,
    name: 'Chromium setup', kind: 'browser_extension', adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
    capabilities: { read: true, write: true, events: true, separator: false, alias: false,
      annotations: 'sidecar', maxBatchOperations: MAX_SYNC_BATCH_OPERATIONS }, binding: {
      browserProfileId: binding.browserProfileId, mountMode: 'whole-profile',
      mountNativeId: null, generation: '1' } }, scope: 'collection',
    collection: { collectionId: COLLECTION_ID, lastCursor: null, lastRevision: null, bootstrapMode: 'download' },
    clientTime: new Date().toISOString() };
}

async function listenOnLoopbackHttps(app: FastifyInstance): Promise<number> {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address: AddressInfo | string | null = app.server.address();
  if (!address || typeof address === 'string') throw new Error('e2e_https_address_unavailable');
  return address.port;
}

async function createIsolatedDatabase() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('P3-27 real-stack E2E requires DATABASE_URL');
  const schema = `p3_extension_auth_shell_${randomUUID().replaceAll('-', '_')}`;
  const administrator = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  await administrator.query(`create schema ${schema}`);
  const isolatedUrl = new URL(databaseUrl);
  isolatedUrl.searchParams.set('options', `-c search_path=${schema}`);
  const runtime = createDatabaseRuntime(isolatedUrl.toString(), {
    maxConnections: 8,
    applicationName: 'known-p3-27-real-stack',
    connectionTimeoutMs: 5_000,
    idleTimeoutMs: 1_000,
    statementTimeoutMs: 120_000,
  });
  return {
    runtime,
    close: async () => {
      await runtime.close();
      await administrator.query(`drop schema if exists ${schema} cascade`);
      await administrator.end();
    },
  };
}

async function seedDatabase(isolated: Awaited<ReturnType<typeof createIsolatedDatabase>>, freshLibrary = false) {
  // Task E3 (supervisor decision 3): the fixture account is created through the
  // REAL Better Auth flow — the production runtime boundary mounted on a
  // temporary Fastify app, business-account unit of work, Argon2id and a
  // narrow in-process auth-mail sender using the fixed test email/password;
  // the A2 hooks write auth_users + 1:1 mapping + accounts/profile/handle.
  // No direct accounts insert and no account_identities browser-login shortcut;
  // the identity row below stays ONLY as the Sync credential mapping (loadAuthority contract) pointing at the
  // BA-created account id.
  const created = await createFixtureAccountViaBetterAuth(isolated);
  fixtureAccount = created.account;
  fixtureAuthUserId = created.authUserId;
  fixtureAuthMailbox = created.authMailbox;
  await isolated.runtime.db.insertInto('account_identities').values({ id: 'p3-27-identity',
    account_id: created.account.id, issuer: ISSUER, subject: created.account.subjectId, created_at: new Date(),
  }).execute();
  if (freshLibrary) return created;
  const owner = { principalId: created.account.id, subjectId: created.account.subjectId };
  await createPostgresLibraryCollectionUnitOfWork(isolated.runtime.db).execute(owner, async ports => {
    await bootstrapCanonicalOwnedCollection(ports.bootstrap, {
      actor: { ...owner, principalType: 'account' }, collectionId: COLLECTION_ID, rootNodeId: 'p3-27-root',
      isLibrary: true, title: 'Bookmarks', summary: null, kind: 'bookmarks',
      operationId: randomUUID(), domainEventId: randomUUID(), outboxId: randomUUID(),
      resourceRevision: generateRevisionToken(), contentRevision: generateRevisionToken(), policyRevision: generateRevisionToken(),
      rootResourceRevision: generateRevisionToken(), rootChildrenRevision: generateRevisionToken(),
    });
    for (const [role, title] of [['bookmarks-bar', 'Bookmarks bar'], ['other-bookmarks', 'Other bookmarks']]) {
      await ports.mutate({ operationId: randomUUID(), collectionId: COLLECTION_ID,
        actor: { ...owner, principalType: 'account' }, automationContext: { origin: 'system' },
        mutation: { action: 'create', target: { collectionId: COLLECTION_ID, resourceId: 'p3-27-' + role, resourceKind: 'node' },
          parentId: 'p3-27-root', fields: { kindFields: { kind: 'folder', title: title!, folderRole: role!,
            description: null, tags: [], visibility: 'inherit' }, extensions: {} },
        },
      });
    }
  });
  await isolated.runtime.db.insertInto('sync_collection_purge_state').values({ collection_id: COLLECTION_ID })
    .onConflict(conflict => conflict.column('collection_id').doNothing()).execute();
  await seedReplica(isolated, { replicaId: REPLICA_ID, browserProfileId: PROFILE_ID, suffix: 'p3-27' });
  for (const binding of P3_29_BINDINGS) await seedReplica(isolated, binding);
  return created;
}

function betterAuthRuntimeInput(isolated: Awaited<ReturnType<typeof createIsolatedDatabase>>) {
  return {
    enabled: true as const,
    config: {
      baseURL: SERVER_ORIGIN,
      basePath: '/api/v1/auth',
      secret: FIXTURE_BA_SECRET,
      sessionTokenProtection: FIXTURE_BA_SESSION_TOKEN_PROTECTION,
      trustedOrigins: [EXTENSION_ORIGIN, SERVER_ORIGIN],
      cookieName: '__Host-known_session' as const,
      sessionExpiresInSeconds: 86_400,
      sessionUpdateAgeSeconds: 60,
      bodyLimitBytes: 1024 * 1024,
      emailOtp: null,
      social: null,
      passwordHash: createArgon2idPasswordHasher(),
    },
    database: { db: isolated.runtime.db, type: 'postgres' as const, transaction: true as const },
    authEmail: {
      async sendAuthEmail(input: { readonly to: string; readonly purpose: string }) {
        return {
          outcome: 'queued' as const,
          correlationId: `extension-e3-${input.to}`,
          providerMessageId: null,
        };
      },
    },
    businessAccount: { unitOfWork: createPostgresBusinessAccountUnitOfWork(isolated.runtime.db) },
    logger: { warn: () => undefined },
  };
}

/**
 * REAL Better Auth registration for the fixture account (supervisor decision
 * 3). The verification email lands in the fixture's narrow in-process auth
 * mail sender and is exposed through observations() as test material.
 */
async function createFixtureAccountViaBetterAuth(isolated: Awaited<ReturnType<typeof createIsolatedDatabase>>) {
  const registrationApp = Fastify({ logger: false });
  const mailboxEntries: Array<{ readonly to: string; readonly subject: string; readonly receivedAt: string }> = [];
  const runtime = createBetterAuthRuntime({
    ...betterAuthRuntimeInput(isolated),
    authEmail: {
      async sendAuthEmail(input) {
        mailboxEntries.push({ to: input.to, subject: input.purpose, receivedAt: new Date().toISOString() });
        return {
          outcome: 'queued',
          correlationId: `extension-e3-${mailboxEntries.length}`,
          providerMessageId: null,
        };
      },
    },
  });
  if (runtime === null) throw new Error('extension fixture Better Auth runtime is disabled');
  runtime.mount(registrationApp);
  try {
    const signUp = await registrationApp.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up/email',
      headers: { origin: EXTENSION_ORIGIN, 'content-type': 'application/json' },
      payload: { email: FIXTURE_BA_EMAIL, password: FIXTURE_BA_PASSWORD, name: 'P3-27 Extension Fixture' },
    });
    if (signUp.statusCode !== 200) {
      throw new Error(`extension fixture BA sign-up failed (${signUp.statusCode})`);
    }
  } finally {
    await registrationApp.close();
  }
  const authUser = await isolated.runtime.db.selectFrom('auth_users')
    .select(['id']).where('email', '=', FIXTURE_BA_EMAIL).executeTakeFirst();
  if (!authUser) throw new Error('extension fixture BA sign-up produced no auth user');
  // The runtime enforces requireEmailVerification; the fixture "clicks" its
  // verification link by marking the Better Auth user verified directly.
  await isolated.runtime.pool.query('update auth_users set "emailVerified" = true where id = $1', [authUser.id]);
  const mapping = await isolated.runtime.db.selectFrom('auth_user_account_map')
    .select(['account_id']).where('auth_user_id', '=', authUser.id).executeTakeFirst();
  if (!mapping) throw new Error('extension fixture BA sign-up produced no account mapping');
  const account = await isolated.runtime.db.selectFrom('accounts')
    .select(['id', 'subject_id']).where('id', '=', mapping.account_id).executeTakeFirst();
  if (!account) throw new Error('extension fixture BA account missing');
  return {
    account: { id: account.id, subjectId: account.subject_id },
    authUserId: authUser.id,
    authMailbox: mailboxEntries,
  };
}

async function seedReplica(isolated: Awaited<ReturnType<typeof createIsolatedDatabase>>, binding: {
  readonly replicaId: string; readonly browserProfileId: string; readonly suffix: string }) {
  if (!fixtureAccount) throw new Error('fixture account must be created before replica seeds');
  await createPostgresReplicaStore(isolated.runtime.db, { ids: {
    deviceId: () => `device-${binding.suffix}`, replicaId: () => binding.replicaId, leaseId: () => `lease-${binding.suffix}`,
  } }).create({ accountId: fixtureAccount.id, collectionId: COLLECTION_ID, deviceName: 'Chromium',
    replicaName: 'Chromium', kind: 'browser_extension', adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
    capabilities: { read: true, write: true, events: true, separator: false,
      alias: false, annotations: 'sidecar', maxBatchOperations: MAX_SYNC_BATCH_OPERATIONS },
    binding: { browserProfileId: binding.browserProfileId, mountMode: 'whole-profile', browserGeneration: '1' },
    leaseDurationSeconds: 3_600 }, { actorAccountId: fixtureAccount.id });
}

function manifest() {
  return { protocol: 'https://know-n.com/colp/spec/0.2', protocolVersions: ['0.1', '0.2'],
    syncEffectPages: `${SERVER_ORIGIN}/v1/effects/{effectId}/pages/{pageNumber}`,
    serverId: `${SERVER_ORIGIN}/`, serverUuid: '019f97ff-2727-7272-8272-272727272727', title: 'Known', mounts: [{
      id: 'known-sync-entry', baseUrl: `${SERVER_ORIGIN}/sync/`, profiles: ['core'], endpoints: {
        syncSessions: `${SERVER_ORIGIN}/v1/session`, syncSnapshot: `${SERVER_ORIGIN}/v1/snapshot`,
        syncPush: `${SERVER_ORIGIN}/v1/push`, syncPull: `${SERVER_ORIGIN}/v1/pull`,
        syncAck: `${SERVER_ORIGIN}/v1/ack`, syncConflict: `${SERVER_ORIGIN}/v1/conflicts/{conflictId}`,
      }, features: { bookmarkUrls: { acceptedSchemes: ['http', 'https'] } },
      auth: { anonymousRead: false, apiKeys: false, oauth: true,
        protectedResourceMetadata: `${SERVER_ORIGIN}/.well-known/oauth-protected-resource` },
      limits: { maxPageSize: 100, maxSnapshotNodes: 10000, minPollIntervalSeconds: 10,
        recommendedPollIntervalSeconds: 30, maxSyncBatchOperations: MAX_SYNC_BATCH_OPERATIONS,
        idempotencyRetentionSeconds: 86400, syncCursorRetentionSeconds: 2592000 },
      'https://known.example/extensions/sync-retire': { href: `${SERVER_ORIGIN}/extensions/sync-retire`,
        method: 'DELETE', requestBody: false, successStatus: 204,
        requiredHeaders: ['Authorization', 'Origin', 'Known-Sync-Session', 'Idempotency-Key'] },
    }] };
}

function requiredCanonicalNode(values: ReadonlyMap<string, Record<string, unknown>>, id: string) {
  const node = values.get(id); if (!node || typeof node.resource_revision !== 'string') {
    throw new Error(`canonical_revision_missing:${id}`);
  }
  return node;
}
function requiredChildrenRevision(node: Record<string, unknown>, id: string) {
  if (typeof node.children_revision !== 'string') throw new Error(`canonical_children_revision_missing:${id}`);
  return node.children_revision;
}
function redactSensitiveHeaders(headers: Readonly<Record<string, string | string[] | undefined>>) {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) =>
    [name, ['authorization', 'cookie'].includes(name.toLowerCase()) ? '[redacted]' : value]));
}

/** FO-04 favicon helper object store: real Map-backed store (memory boundary). */
function createMemoryFaviconObjectStore(): {
  readonly objects: ReadonlyMap<string, { readonly contentType: string; readonly body: Buffer }>;
  put(objectId: string, body: Buffer, contentType: string): Promise<void>;
  get(objectId: string): Promise<{ readonly contentType: string; readonly body: Buffer } | null>;
  delete(objectId: string): Promise<void>;
  readonly puts: string[];
  readonly deletes: string[];
} {
  const objects = new Map<string, { readonly contentType: string; readonly body: Buffer }>();
  const puts: string[] = [];
  const deletes: string[] = [];
  return {
    objects,
    puts,
    deletes,
    async put(objectId, body, contentType) {
      puts.push(objectId);
      objects.set(objectId, { contentType, body: Buffer.from(body) });
    },
    async get(objectId) {
      const row = objects.get(objectId);
      return row ? { contentType: row.contentType, body: Buffer.from(row.body) } : null;
    },
    async delete(objectId) {
      deletes.push(objectId);
      objects.delete(objectId);
    },
  };
}
