/**
 * P4A-P11 shared helpers for the final owner-private acceptance (plan §9
 * P11; not a vitest test file).
 *
 * Provides `buildP11EvidenceApi`: the PRODUCTION product API composition the
 * acceptance drives — it mirrors `buildP10EvidenceApi` (production route
 * wiring + RL04 distributed rate-limit facade + configurable R2 store
 * binding so the CLI can point the product flow at real Cloudflare R2 or the
 * local object server) and additionally wires the PRODUCTION download-
 * admission closure from the P08 delivery composition, so the FULL
 * owner-private lifecycle (issue -> PUT -> complete -> verify -> status ->
 * finalize -> download -> replacement -> cleanup) runs through production
 * HTTP with the real Redis admission facade in front of every expensive
 * route.
 *
 * Every request through the API is delivered over Fastify `inject` (the
 * production `buildApiApp` composition — the P08/P10 evidence precedent);
 * the upload PUT and the isolated delivery GET are REAL HTTP fetches made by
 * an INDEPENDENT client (plan §4.1.7). The per-instance counting rate-limit
 * client factory is the RL04 seam: each API instance owns its own ioredis
 * client over the SAME Redis key prefix + HMAC secret, which is exactly the
 * production multi-replica contract the multi-instance phase proves.
 */
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { loadConfig } from './test-config.js';
import { composeAttachmentRateLimit } from '../../src/bootstrap/attachments-rate-limit-composition.js';
import { buildApiApp } from '../../src/transport/app.js';
import { alwaysReady } from '../../src/infrastructure/health.js';
import { createR2GenerationStore } from '../../src/infrastructure/object-storage/index.js';
import { createGenerationObjectStoreAdapter } from '../../src/infrastructure/object-storage/index.js';
import { InMemoryMetrics } from '../../src/infrastructure/telemetry/index.js';
import { createPostgresAccessPolicyFactsPort } from '../../src/infrastructure/access-policy/index.js';
import { createPostgresAttachmentsAdmissionSwitchStore, createPostgresAttachmentCanonicalMutationPorts, createPostgresAttachmentsPorts, createUnitOfWork } from '../../src/infrastructure/database/index.js';
import {
  appendAttachmentsVerificationOutbox,
} from '../../src/infrastructure/outbox/index.js';
import {
  completeUpload,
  evaluateAttachmentsCapabilityReadiness,
  finalizeAttachment,
  issueReplacementIntent,
  issueUploadIntentWithAdmissionGate,
  nodeUploadIntentCrypto,
  readAttachmentStatus,
  retireAttachment,
  type AttachmentsCapabilityReadiness,
  type AttachmentsFeatureConfig,
  type AttachmentRateLimitConfig,
  type AttachmentRateLimitLogEntry,
  type AttachmentRouteRateLimitFacade,
  type AuthorizeOwnerDownloadInput,
  type AuthorizeOwnerDownloadResult,
  type AttachmentsReadinessFacts,
} from '../../src/modules/attachments/index.js';
import type { IdentityUnitOfWork } from '../../src/modules/identity/index.js';
import type { DatabaseRuntime } from '../../src/infrastructure/database/index.js';
import type { AttachmentRoutesDependencies } from '../../src/transport/product/attachment-routes.js';
import type { P10MigrationRuntime } from './phase4a-p10-test-helpers.js';
import type { P10EvidenceStoreBinding } from './phase4a-p10-test-helpers.js';
import { rl04CountingClientFactory, type Rl04AppBundle } from './phase4a-rl04-test-helpers.js';
import { waitUntil } from './redis-runtime-test-helpers.js';
import { P03_ORIGIN } from './phase4a-p03-test-helpers.js';

export const P11_ISSUER = 'https://issuer.example';
export const P11_COLLECTION = 'p11-collection';
export const P11_COLLECTION_OTHER = 'p11-collection-other';

export interface P11ApiBundle {
  readonly name: string;
  readonly bundle: Rl04AppBundle;
  readonly app: FastifyInstance;
  /** Live readiness facts from REAL probes (PG ping, R2 probe, Redis verdict, origin HEAD). */
  readonly facts: () => Promise<AttachmentsReadinessFacts>;
  readonly readiness: () => Promise<AttachmentsCapabilityReadiness>;
  /** How many times the download USE CASE was invoked (zero on exhausted). */
  readonly downloadCalls: () => number;
  readonly close: () => Promise<void>;
}

export interface BuildP11ApiOptions {
  readonly name: string;
  readonly runtime: P10MigrationRuntime;
  readonly databaseUrl: string;
  readonly identityUnitOfWork: IdentityUnitOfWork;
  readonly attachmentsConfig: AttachmentsFeatureConfig;
  readonly rateLimitConfig: AttachmentRateLimitConfig;
  readonly keySecret: Buffer;
  /** The PRODUCTION download-admission closure (P08 delivery composition). */
  readonly admitDownload: (input: AuthorizeOwnerDownloadInput) => Promise<AuthorizeOwnerDownloadResult>;
  /** Store binding (real R2 or local object server). */
  readonly store: P10EvidenceStoreBinding;
  /** Pre-built store override (the evidence CLI counts real-R2 calls). */
  readonly prebuiltStore?: import('../../src/infrastructure/object-storage/index.js').BlobStorePort;
  /** Worker telemetry facts; undefined/throws while the worker is stopped. */
  readonly workerFacts: () => Promise<AttachmentsReadinessFacts | undefined>;
  /** Origin availability probe (real HEAD against the delivery host). */
  readonly deliveryProbe: () => Promise<boolean>;
}

/**
 * Builds ONE production API instance for the P11 acceptance. Mirrors
 * `buildP10EvidenceApi` and adds the download closure; the rate-limit facade
 * (own ioredis client via the RL04 counting factory) is shared by key prefix
 * + HMAC secret across instances — the multi-replica contract.
 */
export async function buildP11EvidenceApi(options: BuildP11ApiOptions): Promise<P11ApiBundle> {
  const logEntries: AttachmentRateLimitLogEntry[] = [];
  const metrics = new InMemoryMetrics();
  const counting = rl04CountingClientFactory();
  const rateLimit = await composeAttachmentRateLimit({
    config: options.rateLimitConfig,
    environment: 'test',
    resolveKeySecret: async () => options.keySecret,
    metrics,
    logger: (entry) => logEntries.push(entry),
    createClient: counting.factory,
  });
  // Health barrier: the lazy-connecting limiter must be healthy before the
  // first admission (the first request must never race the Redis connect).
  await waitUntil(async () => rateLimit.readiness().status === 'healthy',
    30_000, `p11 ${options.name} limiter connect ready`, 50);
  const store = options.prebuiltStore ?? createR2GenerationStore({
    endpoint: options.store.endpoint,
    region: 'auto',
    bucket: options.store.bucket,
    livePrefix: options.store.livePrefix,
    probePrefix: options.store.probePrefix,
    rwCredential: options.store.rwCredential,
    roCredential: options.store.roCredential,
    grantTtlSeconds: options.attachmentsConfig.grantTtlSeconds,
    singlePutMaxBytes: options.attachmentsConfig.singlePutMaxBytes,
  });
  const moduleStore = createGenerationObjectStoreAdapter(store);
  const ledger = createPostgresAttachmentsPorts();
  const uow = createUnitOfWork(options.runtime.runtime.db);
  const attachmentsConfig = options.attachmentsConfig;
  const config = loadConfig({
    DATABASE_URL: options.databaseUrl,
    NODE_ENV: 'test',
    PRODUCT_ORIGIN: P03_ORIGIN,
    ALLOWED_ORIGINS: P03_ORIGIN,
    OIDC_ALLOW_TEST_PROVIDER: 'true',
    OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
    LOG_LEVEL: 'silent',
  });
  let downloadInvocations = 0;
  const routeDeps: AttachmentRoutesDependencies = {
    config,
    identityUnitOfWork: options.identityUnitOfWork,
    attachments: {
      issue: (input) => issueUploadIntentWithAdmissionGate({
        ledger,
        accessPolicyFor: (transaction) => createPostgresAccessPolicyFactsPort(transaction),
        blobStore: store,
        uow,
        crypto: nodeUploadIntentCrypto,
        config: attachmentsConfig,
        admissionState: () => createPostgresAttachmentsAdmissionSwitchStore(options.runtime.runtime).read(),
      }, input),
      complete: (input) => completeUpload({
        ledger,
        blobStore: moduleStore,
        uow,
        enqueueVerification: async (transaction, payload) => {
          await appendAttachmentsVerificationOutbox(transaction, payload);
        },
        config: attachmentsConfig,
      }, input),
      status: (input) => readAttachmentStatus({
        ledger,
        accessPolicyFor: (transaction) => createPostgresAccessPolicyFactsPort(transaction),
        uow,
      }, input),
      finalize: (input) => finalizeAttachment({
        ledger,
        canonical: createPostgresAttachmentCanonicalMutationPorts(),
        accessPolicyFor: (transaction) => createPostgresAccessPolicyFactsPort(transaction),
        uow,
      }, input),
      replacement: (input) => issueReplacementIntent({
        ledger,
        accessPolicyFor: (transaction) => createPostgresAccessPolicyFactsPort(transaction),
        blobStore: store,
        uow,
        crypto: nodeUploadIntentCrypto,
        config: attachmentsConfig,
      }, input),
      retire: (input) => retireAttachment({
        ledger,
        canonical: createPostgresAttachmentCanonicalMutationPorts(),
        accessPolicyFor: (transaction) => createPostgresAccessPolicyFactsPort(transaction),
        uow,
      }, input),
      download: (input) => {
        downloadInvocations += 1;
        return options.admitDownload(input);
      },
      rateLimit: rateLimit.facade as AttachmentRouteRateLimitFacade,
    },
  };
  const app = buildApiApp({
    config,
    readiness: alwaysReady,
    identityUnitOfWork: options.identityUnitOfWork,
    attachmentRoutes: routeDeps,
  });
  let closed = false;
  const closeOnce = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await app.close();
    await store.close();
    await rateLimit.close();
  };
  const switchStore = createPostgresAttachmentsAdmissionSwitchStore(options.runtime.runtime);
  const facts = async (): Promise<AttachmentsReadinessFacts> => {
    let admission: { enabled: boolean } | undefined;
    let database: { status: 'healthy' | 'degraded' } | undefined;
    try {
      const state = await switchStore.read();
      admission = { enabled: state.admissionEnabled };
      database = { status: 'healthy' };
    } catch {
      database = { status: 'degraded' };
    }
    let objectStore: { status: 'healthy' | 'degraded' } | undefined;
    try {
      await store.probeCapability();
      objectStore = { status: 'healthy' };
    } catch {
      objectStore = { status: 'degraded' };
    }
    const rateLimitVerdict = rateLimit.readiness();
    let worker: AttachmentsReadinessFacts['worker'];
    try {
      const workerFacts = await options.workerFacts();
      if (workerFacts?.worker !== undefined) worker = workerFacts.worker;
    } catch {
      worker = undefined;
    }
    let delivery: { hostAvailable: boolean } | undefined;
    try {
      delivery = { hostAvailable: await options.deliveryProbe() };
    } catch {
      delivery = { hostAvailable: false };
    }
    return {
      ...(admission === undefined ? {} : { admission }),
      ...(database === undefined ? {} : { database }),
      ...(objectStore === undefined ? {} : { objectStore }),
      ...(worker === undefined ? {} : { worker }),
      ...(delivery === undefined ? {} : { delivery }),
      rateLimit: { status: rateLimitVerdict.status, blocksAttachments: rateLimitVerdict.blocksAttachments },
    };
  };
  const readiness = async (): Promise<AttachmentsCapabilityReadiness> =>
    evaluateAttachmentsCapabilityReadiness(attachmentsConfig, await facts());
  app.get('/ready/features/attachments', {
    config: { productTransport: { allowedQuery: [], cacheControl: 'no-store' } },
  }, async (_request, reply) => {
    const result = await readiness().catch(() => ({
      capability: 'attachments' as const, status: 'not-ready' as const,
      reason: 'dependency_unavailable' as const,
    }));
    return reply.code(result.status === 'ready' ? 200 : 503).send(result);
  });
  return {
    name: options.name,
    bundle: {
      bundle: { app, store, config } as unknown as Rl04AppBundle['bundle'],
      rateLimit,
      counts: counting.counts,
      logEntries,
      metrics,
      downloadCalls: () => 0,
      facade: rateLimit.facade,
      close: closeOnce,
    } as Rl04AppBundle,
    app,
    facts,
    readiness,
    downloadCalls: () => downloadInvocations,
    close: closeOnce,
  };
}

/**
 * Counts every BlobStorePort call (real-R2 mode provider counter): the
 * acceptance's R2 calls are the API/worker provider operations, not the
 * local object server's HTTP requests (P10 precedent).
 */
export function countingP11BlobStore(store: import('../../src/infrastructure/object-storage/index.js').BlobStorePort): {
  readonly store: import('../../src/infrastructure/object-storage/index.js').BlobStorePort;
  calls(): number;
} {
  let calls = 0;
  const wrapped = new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls += 1;
        return (value as (...callArgs: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as import('../../src/infrastructure/object-storage/index.js').BlobStorePort;
  return { store: wrapped, calls: () => calls };
}

/**
 * The PRODUCTION R2 adapter for an evidence store binding (real R2 or the
 * local object server) — re-export of the P10 builder so the P11 CLI does
 * not re-implement the binding (same adapter, same contract).
 */
export { buildP10EvidenceStore } from './phase4a-p10-test-helpers.js';

/** True when the raw Redis client answers PONG (used by outage recovery). */
export async function p11RedisPing(raw: Redis): Promise<boolean> {
  try {
    return (await raw.ping()) === 'PONG';
  } catch {
    return false;
  }
}

export { assert };
