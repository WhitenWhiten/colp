/**
 * P4A-P03 shared helpers for the focused suites. This file is not a test file:
 * it matches no vitest test pattern and is never listed in a focused config.
 *
 * It provides:
 *  - `P03ObjectServer`: a REAL local HTTP/1.1 server with minimal create-only
 *    S3 semantics (PUT stores exactly one object and returns an ETag; HEAD
 *    returns ETag/Content-Length/Content-Type/x-amz-meta-*; If-Match 412;
 *    exact-key DELETE; per-key HEAD fault/delay scripting). The PRODUCTION R2
 *    adapter (`createR2GenerationStore`) is pointed at this server, so the
 *    presigned grant URL is signed by the real `@aws-sdk` presigner and the
 *    focused suite performs the PUT with an INDEPENDENT HTTP client through
 *    the real transport — no presigner mock, no in-process PUT;
 *  - `makeP03Config`: the module `AttachmentsFeatureConfig` fixture;
 *  - `seedP03Collection`: the production-migration fixture rows (resource
 *    ledger + collection + root node + members);
 *  - `buildP03App`: the PRODUCTION app composition (`buildApiApp`) with the
 *    REAL PostgreSQL attachments ports, the REAL R2 adapter over the local
 *    object server, the production admission switch store, and the production
 *    verification Outbox append — exactly the composition the P03 route deps
 *    consume.
 *
 * The focused suites NEVER read `.known-local/phase4a-r2.env`; real R2 is the
 * `evidence:phase4a-p03` subcommand's boundary.
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { loadConfig, type AppConfig } from './test-config.js';
import {
  createPostgresAccessPolicyFactsPort,
} from '../../src/infrastructure/access-policy/index.js';
import { createPostgresAttachmentsAdmissionSwitchStore, createPostgresAttachmentCanonicalMutationPorts, createPostgresAttachmentsPorts, createUnitOfWork, type DatabaseTransaction, type TransactionFaultInjector } from '../../src/infrastructure/database/index.js';
import { alwaysReady } from '../../src/infrastructure/health.js';
import {
  createGenerationObjectStoreAdapter,
  createR2GenerationStore,
  type BlobStorePort,
} from '../../src/infrastructure/object-storage/index.js';
import { appendAttachmentsVerificationOutbox } from '../../src/infrastructure/outbox/index.js';
import { buildApiApp } from '../../src/transport/app.js';
import type { AttachmentRoutesDependencies } from '../../src/transport/product/attachment-routes.js';
import type { AttachmentRouteRateLimitFacade } from '../../src/modules/attachments/index.js';
import type { BrowserSessionAuthority } from '../../src/modules/auth/index.js';
import {
  completeUpload,
  finalizeAttachment,
  issueUploadIntentWithAdmissionGate,
  issueReplacementIntent,
  nodeUploadIntentCrypto,
  readAttachmentStatus,
  retireAttachment,
  type AttachmentCanonicalFaultInjector,
  type AttachmentCanonicalMutationPort,
  type AttachmentCanonicalMutationPortOptions,
  type AttachmentsFeatureConfig,
  type AttachmentsR2Config,
  type FinalizeAttachmentInput,
  type FinalizeAttachmentResult,
  type GenerationObjectStorePort,
  type PhaseBarrier,
} from '../../src/modules/attachments/index.js';
import type { AttachmentDeliveryComposition } from '../../src/bootstrap/attachments-delivery-composition.js';
import type { IdentityUnitOfWork } from '../../src/modules/identity/index.js';
import { waitForRealTime } from './async-test-helpers.js';
import type { I07MigrationRuntime } from './phase4a-i07-test-helpers.js';

export const P03_ORIGIN = 'https://app.known.example';
export const P03_BUCKET = 'p03-test-bucket';
export const P03_LIVE_PREFIX = 'attachments/live/';
export const P03_PROBE_PREFIX = 'attachments/probe/';
export const P03_COLLECTION = 'p03-collection';
export const P03_ISSUER = 'https://issuer.example';

/**
 * Dummy but well-formed RW/RO credentials for the real adapter over the local
 * transport. Deliberately NOT frozen: the AWS SDK v3 credential-attribution
 * path writes `credentials.$source` onto the supplied object, so a frozen
 * credential object makes `issueCreateOnlyGrant` fail with
 * `Cannot set properties of undefined (setting 'CREDENTIALS_CODE')`.
 */
export const P03_RW_CREDENTIAL = {
  accessKeyId: 'p03rwaccesskeyid0000000000000000',
  secretAccessKey: 'p03-rw-secret-access-key-00000000000000000000',
};
export const P03_RO_CREDENTIAL = {
  accessKeyId: 'p03roaccesskeyid0000000000000000',
  secretAccessKey: 'p03-ro-secret-access-key-00000000000000000000',
};

export function sha256Hex(text: string | Uint8Array): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * `makeP03Config` overrides: the r2 member may be a PARTIAL r2 (the merge in
 * `makeP03Config` fills the P03 defaults for every missing field), so
 * callers like `p08Config` can swap only the live/probe prefix or endpoint.
 */
export type P03ConfigOverrides = Omit<Partial<AttachmentsFeatureConfig>, 'r2'> & {
  readonly r2?: Partial<AttachmentsR2Config>;
};

export function makeP03Config(overrides: P03ConfigOverrides = {}): AttachmentsFeatureConfig {
  const base: AttachmentsFeatureConfig = {
    enabled: true,
    r2: {
      endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
      region: 'auto',
      bucket: P03_BUCKET,
      livePrefix: P03_LIVE_PREFIX,
      probePrefix: P03_PROBE_PREFIX,
      rwSecretRef: 'known/p03/r2/rw',
      roSecretRef: 'known/p03/r2/ro',
    },
    grantTtlSeconds: 60,
    singlePutMaxBytes: 5 * 1024 * 1024,
    allowedMedia: ['image/png', 'application/pdf', 'text/plain'],
    verification: { leaseMs: 60_000, timeoutMs: 15_000, retryCount: 2 },
    retention: { intentRetentionHours: 24, storedRetentionDays: 30, retiredRetentionDays: 90 },
    cleanupBatchSize: 100,
    cleanup: { leaseMs: 60_000, retryCount: 2 },
    isolatedDeliveryOrigin: 'https://delivery.known.example',
    deliveryCapabilitySecretRef: 'known/p03/delivery/hmac',
    deliveryCapabilityTtlSeconds: 60,
  };
  return Object.freeze({ ...base, ...overrides, r2: { ...base.r2, ...overrides.r2 } });
}

// ---------------------------------------------------------------------------
// Real local object server (create-only single-PUT S3 semantics subset)
// ---------------------------------------------------------------------------

export interface P03RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: Buffer;
}

export interface P03StoredObject {
  readonly etag: string;
  readonly size: number;
  readonly contentType: string | null;
  readonly metadata: Readonly<Record<string, string>>;
  readonly body: Buffer;
}

/**
 * REAL HTTP transport stand-in for the R2 endpoint. The production adapter
 * signs real presigned URLs against this server; the server enforces the
 * create-only contract (second PUT on the same key is 412) and serves the
 * exact HEAD identity facts (ETag/Content-Length/x-amz-meta-*) the complete
 * use case attests. Per-key HEAD fault/delay scripting makes provider-unknown
 * and client-abort windows deterministic.
 */
export class P03ObjectServer {
  readonly objects = new Map<string, P03StoredObject>();
  readonly requests: P03RecordedRequest[] = [];
  /** Exact keys whose HEAD must fail with a retryable 500 (provider unknown). */
  readonly headFailures = new Set<string>();
  /** Exact keys whose HEAD response must be delayed (client-abort window). */
  readonly headDelays = new Map<string, number>();
  private readonly server = createServer((request, response) => {
    void this.handle(request, response);
  });
  url = '';

  async start(): Promise<string> {
    await new Promise<void>((resolvePromise) => this.server.listen(0, '127.0.0.1', resolvePromise));
    const address = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${address.port}`;
    return this.url;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections?.();
    await new Promise<void>((resolvePromise) => this.server.close(() => resolvePromise()));
  }

  has(key: string): boolean {
    return this.objects.has(key);
  }

  etagOf(key: string): string | undefined {
    return this.objects.get(key)?.etag;
  }

  keyCount(): number {
    return this.objects.size;
  }

  private async handle(
    request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse,
  ): Promise<void> {
    const parts: Buffer[] = [];
    for await (const chunk of request) {
      parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body = Buffer.concat(parts);
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const segments = url.pathname.split('/').filter(Boolean);
    // Path shape: /<bucket>/<key...>
    const key = segments.slice(1).join('/');
    const method = request.method ?? '';
    this.requests.push({ method, path: request.url ?? '', headers: request.headers, body });

    if (method === 'PUT') {
      if (this.objects.has(key)) {
        response.writeHead(412, { 'Content-Length': '0' });
        response.end();
        return;
      }
      const contentType = request.headers['content-type'];
      const metadata: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        if (name.startsWith('x-amz-meta-') && typeof value === 'string') {
          metadata[name.slice('x-amz-meta-'.length)] = value;
        }
      }
      const etag = `"${sha256Hex(body).slice(0, 32)}"`;
      this.objects.set(key, {
        etag,
        size: body.byteLength,
        contentType: typeof contentType === 'string' ? contentType : null,
        metadata: Object.freeze(metadata),
        body,
      });
      response.writeHead(200, { ETag: etag });
      response.end();
      return;
    }

    if (method === 'HEAD') {
      if (this.headFailures.has(key)) {
        response.writeHead(500, { 'Content-Length': '0' });
        response.end();
        return;
      }
      const delay = this.headDelays.get(key);
      if (delay !== undefined && delay > 0) {
        await waitForRealTime(delay, 'inject P03 object-store HEAD latency');
      }
      const object = this.objects.get(key);
      if (!object) {
        response.writeHead(404, { 'Content-Length': '0' });
        response.end();
        return;
      }
      const ifMatch = request.headers['if-match'];
      if (typeof ifMatch === 'string' && ifMatch !== object.etag) {
        response.writeHead(412, { 'Content-Length': '0' });
        response.end();
        return;
      }
      const headers: Record<string, string> = {
        ETag: object.etag,
        'Content-Length': String(object.size),
        'Content-Type': object.contentType ?? 'application/octet-stream',
      };
      for (const [name, value] of Object.entries(object.metadata)) {
        headers[`x-amz-meta-${name}`] = value;
      }
      response.writeHead(200, headers);
      response.end();
      return;
    }

    if (method === 'DELETE') {
      const deleted = this.objects.delete(key);
      response.writeHead(deleted ? 204 : 404, { 'Content-Length': '0' });
      response.end();
      return;
    }

    response.writeHead(405, { 'Content-Length': '0' });
    response.end();
  }
}

// ---------------------------------------------------------------------------
// Production-migration fixtures
// ---------------------------------------------------------------------------

export interface P03MemberSeed {
  readonly subjectId: string;
  readonly role: 'owner' | 'editor' | 'viewer';
}

export async function seedP03Collection(
  runtime: I07MigrationRuntime['runtime'],
  options: {
    readonly collectionId: string;
    readonly ownerSubjectId: string;
    readonly members?: readonly P03MemberSeed[];
    readonly policyRevision?: string;
  },
): Promise<void> {
  const rootId = `${options.collectionId}-root`;
  await createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
    await sql`
      insert into resource_id_ledger (resource_id, resource_type)
      values (${options.collectionId}, 'collection'), (${rootId}, 'node')
    `.execute(transaction);
    await sql`
      insert into collections
        (id, owner_subject_id, title, kind, root_node_id, resource_revision,
         content_revision, policy_revision, visibility, commit_ordinal,
         created_at, updated_at, deleted_at)
      values (${options.collectionId}, ${options.ownerSubjectId}, 'P03 collection', 'bookmarks', ${rootId},
        ${`resource-${options.collectionId}`}, ${`content-${options.collectionId}`},
        ${options.policyRevision ?? 'policy-r1'}, 'private', 1, now(), now(), null)
    `.execute(transaction);
    await sql`
      insert into nodes
        (id, collection_id, kind, is_root, title, resource_revision, children_revision, deleted_at)
      values (${rootId}, ${options.collectionId}, 'folder', true, 'Root', 'r1', 'ch1', null)
    `.execute(transaction);
  });
  for (const member of options.members ?? []) {
    await runtime.pool.query(
      'insert into collection_members (collection_id, subject_id, role, granted_at) values ($1, $2, $3, now())',
      [options.collectionId, member.subjectId, member.role],
    );
  }
}

// ---------------------------------------------------------------------------
// Production app composition for the focused suites
// ---------------------------------------------------------------------------

/**
 * P4A-P06 deterministic seams for the finalize composition. Every seam is a
 * production port option or a fault injector; when absent the finalize
 * closure is the plain production use case over the production canonical
 * port (the P03/P04 suites never pass seams).
 */
export interface P03FinalizeSeams {
  /** Canonical write-phase fault injection (rollback proofs). */
  readonly canonicalFaults?: AttachmentCanonicalFaultInjector;
  /** Unit-of-work fault injection (commit-unknown proofs). */
  readonly uowFaults?: TransactionFaultInjector;
  /** Barrier passed through to the canonical port options (race proofs). */
  readonly barrier?: PhaseBarrier;
  /**
   * Test-only canonical override (frozen mapping / retryable-class proofs);
   * defaults to the production port. The recovery re-read always stays on the
   * production port.
   */
  readonly canonicalOverride?: (
    transaction: DatabaseTransaction,
    input: FinalizeAttachmentInput,
    options?: AttachmentCanonicalMutationPortOptions,
  ) => Promise<FinalizeAttachmentResult>;
}

/**
 * P4A-P07 deterministic seams for the retire composition. Every seam is a
 * production port option or a fault injector; when absent the retire closure
 * is the plain production use case over the production canonical port.
 */
export interface P03RetireSeams {
  /** Canonical write-phase fault injection (rollback proofs). */
  readonly canonicalFaults?: AttachmentCanonicalFaultInjector;
  /** Unit-of-work fault injection (commit-unknown proofs). */
  readonly uowFaults?: TransactionFaultInjector;
  /** Barrier passed through to the canonical port options (race proofs). */
  readonly barrier?: PhaseBarrier;
}

export interface P03AppBundle {
  readonly app: FastifyInstance;
  /** Real production R2 adapter over the local object server (RW surface). */
  readonly store: BlobStorePort;
  /** Module-port adapter for the complete use case. */
  readonly moduleStore: GenerationObjectStorePort;
  readonly config: AppConfig;
  /** P4A-P08 production delivery composition when composed (admission port). */
  readonly delivery?: Pick<AttachmentDeliveryComposition, 'admitDownload'>;
}

export function buildP03App(options: {
  readonly runtime: I07MigrationRuntime['runtime'];
  readonly databaseUrl: string;
  readonly identityUnitOfWork: IdentityUnitOfWork;
  readonly objectServerUrl: string;
  readonly attachmentsConfig: AttachmentsFeatureConfig;
  /** E1: Better Auth session authority (test factory); absent keeps legacy auth. */
  readonly browserSessionAuthority?: BrowserSessionAuthority;
  readonly origin?: string;
  readonly now?: () => Date;
  readonly finalizeSeams?: P03FinalizeSeams;
  readonly retireSeams?: P03RetireSeams;
  /**
   * Injectable signing clock for the production R2 adapter (deterministic
   * re-signed grants in the P07 replay proofs; the adapter documents this
   * seam for tests).
   */
  readonly storeClock?: () => Date;
  /**
   * P4A-P08 production download-admission port (the composed
   * `authorizeOwnerDownload` closure). When absent the download route stays
   * closed (503 attachments_not_implemented).
   */
  readonly delivery?: Pick<AttachmentDeliveryComposition, 'admitDownload'>;
  /**
   * P4A-RL04 distributed admission facade. When composed the issue/complete/
   * download handlers check it after auth + cheap validation and before any
   * database/R2 work (absent = pre-RL04 behavior unchanged).
   */
  readonly rateLimit?: AttachmentRouteRateLimitFacade;
}): P03AppBundle {
  const origin = options.origin ?? P03_ORIGIN;
  const config = loadConfig({
    DATABASE_URL: options.databaseUrl,
    NODE_ENV: 'test',
    PRODUCT_ORIGIN: origin,
    ALLOWED_ORIGINS: origin,
    OIDC_ALLOW_TEST_PROVIDER: 'true',
    OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
    LOG_LEVEL: 'silent',
  });
  const store = createR2GenerationStore({
    endpoint: options.objectServerUrl,
    region: 'auto',
    bucket: options.attachmentsConfig.r2.bucket,
    livePrefix: options.attachmentsConfig.r2.livePrefix,
    probePrefix: P03_PROBE_PREFIX,
    rwCredential: P03_RW_CREDENTIAL,
    roCredential: P03_RO_CREDENTIAL,
    grantTtlSeconds: options.attachmentsConfig.grantTtlSeconds,
    singlePutMaxBytes: options.attachmentsConfig.singlePutMaxBytes,
    ...(options.storeClock === undefined ? {} : { clock: options.storeClock }),
  });
  const moduleStore = createGenerationObjectStoreAdapter(store);
  const ledger = createPostgresAttachmentsPorts();
  const uow = createUnitOfWork(options.runtime.db);
  const attachmentsConfig = options.attachmentsConfig;
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
        ...(options.now === undefined ? {} : { now: options.now }),
        admissionState: () => createPostgresAttachmentsAdmissionSwitchStore(options.runtime).read(),
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
        canonical: finalizeCanonical(options),
        accessPolicyFor: (transaction) => createPostgresAccessPolicyFactsPort(transaction),
        uow: createUnitOfWork(options.runtime.db, {
          ...(options.finalizeSeams?.uowFaults === undefined ? {} : { faultInjector: options.finalizeSeams.uowFaults }),
        }),
        // The recovery re-read must never be poisoned by a simulated lost
        // commit acknowledgement, so it uses a fault-free unit of work.
        recoveryUow: createUnitOfWork(options.runtime.db),
        ...(options.finalizeSeams?.barrier === undefined ? {} : { barrier: options.finalizeSeams.barrier }),
      }, input),
      replacement: (input) => issueReplacementIntent({
        ledger,
        accessPolicyFor: (transaction) => createPostgresAccessPolicyFactsPort(transaction),
        blobStore: store,
        uow,
        crypto: nodeUploadIntentCrypto,
        config: attachmentsConfig,
        ...(options.now === undefined ? {} : { now: options.now }),
      }, input),
      retire: (input) => retireAttachment({
        ledger,
        canonical: createPostgresAttachmentCanonicalMutationPorts({
          ...(options.retireSeams?.canonicalFaults === undefined ? {} : { faultInjector: options.retireSeams.canonicalFaults }),
        }),
        accessPolicyFor: (transaction) => createPostgresAccessPolicyFactsPort(transaction),
        uow: createUnitOfWork(options.runtime.db, {
          ...(options.retireSeams?.uowFaults === undefined ? {} : { faultInjector: options.retireSeams.uowFaults }),
        }),
        // The recovery re-read must never be poisoned by a simulated lost
        // commit acknowledgement, so it uses a fault-free unit of work.
        recoveryUow: createUnitOfWork(options.runtime.db),
        ...(options.retireSeams?.barrier === undefined ? {} : { barrier: options.retireSeams.barrier }),
      }, input),
      // P4A-P08: the production download admission (absent -> closed route).
      ...(options.delivery === undefined ? {} : { download: options.delivery.admitDownload }),
      // P4A-RL04: the distributed admission facade (absent -> pre-RL04 routes).
      ...(options.rateLimit === undefined ? {} : { rateLimit: options.rateLimit }),
    },
  };
  const app = buildApiApp({
    config,
    readiness: alwaysReady,
    identityUnitOfWork: options.identityUnitOfWork,
    ...(options.browserSessionAuthority === undefined
      ? {}
      : { browserSessionAuthority: options.browserSessionAuthority }),
    attachmentRoutes: routeDeps,
  });
  return {
    app,
    store,
    moduleStore,
    config,
    ...(options.delivery === undefined ? {} : { delivery: options.delivery }),
  };
}

/**
 * The canonical finalize port for the focused composition: the PRODUCTION
 * port (with the optional write-phase fault seam), or the test override for
 * the frozen mapping / retryable-class proofs. The commit-unknown recovery
 * re-read always stays on the production port.
 */
function finalizeCanonical(options: {
  readonly finalizeSeams?: P03FinalizeSeams;
}): AttachmentCanonicalMutationPort<DatabaseTransaction> {
  const production = createPostgresAttachmentCanonicalMutationPorts({
    ...(options.finalizeSeams?.canonicalFaults === undefined ? {} : { faultInjector: options.finalizeSeams.canonicalFaults }),
  });
  const override = options.finalizeSeams?.canonicalOverride;
  if (override === undefined) return production;
  // The finalize override replaces ONLY the finalize assembly; the retire and
  // recovery surfaces stay on the production port.
  return {
    ...production,
    finalizeAttachment: override,
  };
}
