import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { readPhase2SourceIdentity } from './phase2-source-identity.mjs';
import pg from 'pg';
import { loadConfig } from '../src/bootstrap/config.js';
import { createPostgresAccessPolicyFactsPort } from '../src/infrastructure/access-policy/index.js';
import { createDatabaseRuntime, createPostgresSharedExposureFactsPort, runMigrations } from '../src/infrastructure/database/index.js';
import { createPostgresIdentityUnitOfWork } from '../src/infrastructure/identity/index.js';
import {
  createKnownPhase2DeploymentProbeSuite,
} from './acceptance/phase2-publication-acceptance.js';
import {
  startPhase2FastifyDeploymentTarget,
} from './acceptance/phase2-fastify-deployment-target.js';
import {
  POSTGRES_PUBLICATION_ENTRY_TARGET,
  loadPostgresPublicationEntryThresholds,
  seedPostgresPublicationEntryFixture,
} from './evidence/postgres-publication-entry.js';
import {
  createPhase2ProfileConformanceTarget,
} from './evidence/phase2-profile-conformance-target.js';
import {
  createPostgresProductPublicCollectionLocatorReadPort,
  createPostgresProductPublicCollectionViewCountReadPort,
  createPostgresPublicationDirectoryReadPort,
  createPostgresPublicationMetadataReadPort,
  createPostgresPublicationSnapshotReadPort,
} from '../src/infrastructure/publication/index.js';
import {
  createPhase2PublicationProfileClaimController,
  createPublicationCursorKeyring,
  type Phase2PublicationProfileClaims,
  type VerifiedPhase2PublicationEvidence,
} from '../src/modules/publication/index.js';
import {
  createSession,
  ensureAccountFromOidcIdentity,
} from '../src/modules/identity/index.js';
import { buildApiApp } from '../src/transport/app.js';
import { createMemorySearchRateLimiter } from '../src/transport/http-security.js';
import { SESSION_COOKIE_NAME } from '../src/transport/session-cookie.js';
import { InMemoryMetrics } from '../src/infrastructure/telemetry/index.js';

export async function createPhase2AcceptanceDeployment(input: {
  readonly env: NodeJS.ProcessEnv;
}) {
  const databaseUrl = input.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('Phase 2 acceptance adapter requires DATABASE_URL');
  const source = readPhase2SourceIdentity(fileURLToPath(new URL('../../..', import.meta.url)));
  const administrator = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const schema = `phase2_acceptance_${randomUUID().replaceAll('-', '_')}`;
  await administrator.query(`create schema ${schema}`);
  const isolatedDatabaseUrl = new URL(databaseUrl);
  isolatedDatabaseUrl.searchParams.set('options', `-c search_path=${schema}`);
  const runtime = createDatabaseRuntime(isolatedDatabaseUrl.href, {
    maxConnections: 10,
    applicationName: 'known-phase2-acceptance-adapter',
  });
  let deployment: Awaited<ReturnType<typeof startPhase2FastifyDeploymentTarget>> | undefined;
  let profileConformance: Awaited<ReturnType<typeof createPhase2ProfileConformanceTarget>> | undefined;
  try {
    await runMigrations(runtime.db, 'latest');
    const thresholds = loadPostgresPublicationEntryThresholds();
    await seedPostgresPublicationEntryFixture(runtime, thresholds.nodeCount);
    // Allocate immediately before composing/listening so the released-port handoff
    // is not exposed during migrations and the 10k-node fixture seed.
    const port = await reserveTcpPort();
    const origin = `http://127.0.0.1:${port}`;
    const acceptanceFetch = createRetryingLoopbackFetch(globalThis.fetch);
    const config = loadConfig({ KNOWN_FEATURE_EXPORT_JOBS: 'false',
      ...input.env,
      DATABASE_URL: isolatedDatabaseUrl.href,
      PRODUCT_ORIGIN: origin,
      PUBLICATION_ORIGIN: origin,
      PUBLICATION_MAX_PAGE_SIZE: '500',
      NODE_ENV: 'test',
      OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      LOG_LEVEL: 'silent',
    });
    const metrics = new InMemoryMetrics();
    const cursors = createPublicationCursorKeyring({
      active: { id: 'phase2-acceptance-v2', secret: Buffer.alloc(32, 81).toString('base64') },
      retained: [
        { id: 'phase2-acceptance-v1', secret: Buffer.alloc(32, 80).toString('base64') },
      ],
    });
    const snapshot = {
      reads: createPostgresPublicationSnapshotReadPort(runtime),
      accessPolicy: createPostgresAccessPolicyFactsPort(runtime.db),
      cursors,
      origin,
      sharedExposure: createPostgresSharedExposureFactsPort(runtime),
    };
    const identityUnitOfWork = createPostgresIdentityUnitOfWork(runtime.db);
    const member = await issueAcceptanceSession({
      identityUnitOfWork,
      issuer: 'https://issuer.example.test',
      subject: 'phase2-acceptance-member',
      handle: 'phase2-acceptance-member',
    });
    await runtime.pool.query(
      `insert into collection_members(collection_id, subject_id, role)
       values ($1, $2, 'viewer')`,
      [POSTGRES_PUBLICATION_ENTRY_TARGET.collectionId, member.subjectId],
    );
    const profileClaims = createPhase2PublicationProfileClaimController();
    const app = buildApiApp({
      config,
      readiness: runtime,
      exploreDirectoryRateLimiter: createMemorySearchRateLimiter({
        anonymousMaxRequests: 10_000,
        accountMaxRequests: 10_000,
        windowMs: 60_000,
      }),
      identityUnitOfWork,
      publicationProfileClaimController: profileClaims,
      publicationSnapshotQuery: snapshot,
      publicationDirectoryQuery: {
        reads: createPostgresPublicationDirectoryReadPort(runtime),
        cursors,
        origin,
        maxPageSize: 500,
      },
      publicationMetadataQuery: {
        reads: createPostgresPublicationMetadataReadPort(runtime),
        origin,
      },
      productPublicCollectionQuery: {
        locators: createPostgresProductPublicCollectionLocatorReadPort(runtime),
        viewCounts: createPostgresProductPublicCollectionViewCountReadPort(runtime),
        snapshot,
        cursors,
      },
      metrics,
    });
    app.addHook('onClose', async () => {
      cursors.destroy();
      await runtime.close();
    });
    const probeSuite = createKnownPhase2DeploymentProbeSuite({
      runtime,
      config,
      origin,
      collectionId: POSTGRES_PUBLICATION_ENTRY_TARGET.collectionId,
      publicationSlug: POSTGRES_PUBLICATION_ENTRY_TARGET.publicationSlug,
      memberHeaders: { cookie: member.cookie },
      fetch: acceptanceFetch,
    });
    deployment = await startPhase2FastifyDeploymentTarget({
      app,
      database: runtime,
      listen: { host: '127.0.0.1', port },
      manifestUrl: `${origin}/.well-known/collection-protocol`,
      sourceRevision: source.sourceRevision,
      sourceDigest: source.sourceDigest,
      collectionId: POSTGRES_PUBLICATION_ENTRY_TARGET.collectionId,
      probeSuite,
      fetch: acceptanceFetch,
    });
    profileConformance = await createPhase2ProfileConformanceTarget({
      databaseUrl: isolatedDatabaseUrl.href,
      manifestUrl: deployment.target.manifestUrl,
      collectionId: POSTGRES_PUBLICATION_ENTRY_TARGET.collectionId,
      fetch: deployment.target.fetch,
    });
    let closePromise: Promise<void> | undefined;
    return Object.freeze({
      target: deployment.target,
      profileConformanceTarget: profileConformance.target,
      manifestUrl: deployment.target.manifestUrl,
      databaseUrl: isolatedDatabaseUrl.href,
      fetch: deployment.target.fetch,
      activateProfileClaims(claims: Phase2PublicationProfileClaims) {
        profileClaims.activate(claims);
      },
      expectations: Object.freeze({
        expectedSnapshotNodes: thresholds.nodeCount + 1,
        maxRequestP95Ms: thresholds.pageP95Ms,
        maxSnapshotTraversalMs: thresholds.fullTraversalMs,
      }),
      close() {
        closePromise ??= closeIsolatedDeployment(
          deployment!,
          profileConformance!,
          administrator,
          schema,
        );
        return closePromise;
      },
    });
  } catch (error: unknown) {
    await profileConformance?.close().catch(() => undefined);
    await deployment?.close().catch(() => undefined);
    if (!deployment) {
      await runtime.close().catch(() => undefined);
    }
    await dropAcceptanceSchema(administrator, schema).catch(() => undefined);
    await administrator.end().catch(() => undefined);
    throw error;
  }
}

/** Release adapter: a fresh real stack, bound to the already verified P2-16 artifact. */
export async function createPhase2ProfileConformanceDeployment(input: {
  readonly acceptanceEvidence: VerifiedPhase2PublicationEvidence;
  readonly env: NodeJS.ProcessEnv;
}) {
  if (input.acceptanceEvidence.evidence.target.collectionId
      !== POSTGRES_PUBLICATION_ENTRY_TARGET.collectionId) {
    throw new TypeError('Phase 2 evidence targets a different acceptance Collection');
  }
  const deployment = await createPhase2AcceptanceDeployment({ env: input.env });
  return Object.freeze({
    target: deployment.profileConformanceTarget,
    manifestUrl: deployment.manifestUrl,
    fetch: deployment.fetch,
    activateProfileClaims: (claims: Phase2PublicationProfileClaims) => {
      deployment.activateProfileClaims(claims);
    },
    close: () => deployment.close(),
  });
}

async function issueAcceptanceSession(input: {
  readonly identityUnitOfWork: ReturnType<typeof createPostgresIdentityUnitOfWork>;
  readonly issuer: string;
  readonly subject: string;
  readonly handle: string;
}) {
  const issued = await input.identityUnitOfWork.execute(async (ports) => {
    const ensured = await ensureAccountFromOidcIdentity(ports, {
      issuer: input.issuer,
      subject: input.subject,
      email: `${input.subject}@example.test`,
      displayName: input.subject,
      handle: input.handle,
    });
    const secrets = await createSession(ports, { accountId: ensured.account.id });
    return {
      rawSessionToken: secrets.rawSessionToken,
      subjectId: ensured.account.subjectId,
    };
  });
  return Object.freeze({
    cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(issued.rawSessionToken)}`,
    subjectId: issued.subjectId,
  });
}

async function closeIsolatedDeployment(
  deployment: Awaited<ReturnType<typeof startPhase2FastifyDeploymentTarget>>,
  profileConformance: Awaited<ReturnType<typeof createPhase2ProfileConformanceTarget>>,
  administrator: pg.Pool,
  schema: string,
): Promise<void> {
  try {
    await profileConformance.close();
    await deployment.close();
    await dropAcceptanceSchema(administrator, schema);
  } finally {
    await administrator.end();
  }
}

async function dropAcceptanceSchema(administrator: pg.Pool, schema: string): Promise<void> {
  if (!/^phase2_acceptance_[0-9a-f_]{36}$/u.test(schema)) {
    throw new Error('Refusing to drop an invalid Phase 2 acceptance schema');
  }
  await administrator.query(`drop schema ${schema} cascade`);
}

async function reserveTcpPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Phase 2 acceptance could not reserve a loopback port');
  }
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
  return address.port;
}

function createRetryingLoopbackFetch(implementation: typeof globalThis.fetch): typeof globalThis.fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const retryableMethod = request.method === 'GET' || request.method === 'HEAD';
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
    const delays = retryableMethod && loopback ? [0, 25, 100] : [0];
    let lastError: unknown;
    for (const delay of delays) {
      if (delay > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
      try {
        return await implementation(request.clone());
      } catch (error: unknown) {
        if (request.signal.aborted
            || !(error instanceof TypeError)
            || !/fetch failed/iu.test(error.message)) throw error;
        lastError = error;
      }
    }
    throw lastError;
  };
}
