import { loadConfig, assertPublicObjectPrefixesDoNotOverlap } from './config.js';
import {
  composeAttachmentRateLimit,
  resolveApiRateLimitKeySecret,
  type AttachmentRateLimitComposition,
} from './attachments-rate-limit-composition.js';
import {
  composeAttachmentsObjectStorage,
  type ResolvedR2Secret,
} from './attachments-object-storage-composition.js';
import {
  authorizeOwnerDownload,
  completeUpload,
  createHmacOwnerDeliveryCapabilitySigner,
  createPermissiveDeliveryRateLimiter,
  evaluateAttachmentsCapabilityReadiness,
  finalizeAttachment,
  issueReplacementIntent,
  issueUploadIntentWithAdmissionGate,
  nodeUploadIntentCrypto,
  readAttachmentStatus,
  retireAttachment,
  type AttachmentRateLimitLogEntry,
  type AttachmentsReadinessFacts,
  type AuthorizeOwnerDownloadInput,
} from '../modules/attachments/index.js';
import {
  assertAvatarPrefixesDoNotOverlap,
  type AvatarObjectStore,
  type IdentityUnitOfWork,
} from '../modules/identity/index.js';
import type { BookmarkFaviconObjectStore } from '../modules/collections/index.js';
import { createR2AvatarStore } from '../infrastructure/identity/index.js';
import { createR2FaviconStore } from '../infrastructure/collections/index.js';
import { composeLinkPreviewObjectStore } from './favicon-object-storage-composition.js';
import {
  createPostgresAttachmentCanonicalMutationPorts,
  createPostgresAttachmentsAdmissionSwitchStore,
  createPostgresAttachmentsPorts,
  createUnitOfWork,
  type DatabaseRuntime,
  type DatabaseTransaction,
} from '../infrastructure/database/index.js';
import { createPostgresAccessPolicyFactsPort } from '../infrastructure/access-policy/index.js';
import { appendAttachmentsVerificationOutbox } from '../infrastructure/outbox/index.js';
import {
  createGenerationObjectStoreAdapter,
  type BlobStorePort,
} from '../infrastructure/object-storage/index.js';
import type { AttachmentRoutesDependencies } from '../transport/product/attachment-routes.js';
import { createLogger, type Metrics } from '../infrastructure/telemetry/index.js';
import { settleBestEffort } from '../infrastructure/async/best-effort.js';

/**
 * P4A-RL04 API CLI secret resolvers (mirror the worker resolver pattern):
 * each configured secret REF names which env vars hold the VALUE (ref
 * `known/prod/r2/ro` reads `ATTACHMENTS_R2_RO_ACCESS_KEY_ID` /
 * `ATTACHMENTS_R2_RO_SECRET_ACCESS_KEY`; ref `known/prod/delivery/hmac`
 * reads `ATTACHMENTS_DELIVERY_CAPABILITY_HMAC`). Fails closed when the ref
 * is unknown or the values are missing; values are never logged.
 */
export async function resolveApiAttachmentSecret(ref: string): Promise<ResolvedR2Secret> {
  const suffix = ref.split('/').filter(Boolean).pop()
    ?.replace(/[^A-Za-z0-9]/g, '_').toUpperCase() ?? '';
  if (suffix.length === 0) throw new Error(`API composition refused: invalid R2 secret ref ${ref}`);
  const accessKeyId = process.env[`ATTACHMENTS_R2_${suffix}_ACCESS_KEY_ID`]?.trim();
  const secretAccessKey = process.env[`ATTACHMENTS_R2_${suffix}_SECRET_ACCESS_KEY`]?.trim();
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      `API composition refused: ATTACHMENTS_R2_${suffix}_ACCESS_KEY_ID / `
      + `ATTACHMENTS_R2_${suffix}_SECRET_ACCESS_KEY are required to resolve ${ref}`,
    );
  }
  return { accessKeyId, secretAccessKey };
}

export async function resolveApiDeliveryCapabilitySecret(ref: string): Promise<string> {
  const suffix = ref.split('/').filter(Boolean).pop()
    ?.replace(/[^A-Za-z0-9]/g, '_').toUpperCase() ?? '';
  if (suffix.length === 0) {
    throw new Error(`API composition refused: invalid delivery capability secret ref ${ref}`);
  }
  const value = process.env[`ATTACHMENTS_DELIVERY_CAPABILITY_${suffix}`]?.trim();
  if (!value) {
    throw new Error(
      `API composition refused: ATTACHMENTS_DELIVERY_CAPABILITY_${suffix} is required to resolve ${ref}`,
    );
  }
  return value;
}

export interface ApiAttachmentsComposition {
  readonly attachmentRateLimit: AttachmentRateLimitComposition | undefined;
  readonly attachmentsObjectStorage: BlobStorePort | undefined;
  readonly attachmentRoutes: AttachmentRoutesDependencies | undefined;
  readonly avatarStore: AvatarObjectStore | undefined;
  readonly faviconStore: BookmarkFaviconObjectStore | undefined;
  /** LP-04: present only while KNOWN_FEATURE_LINK_PREVIEW is enabled (fails closed without storage). */
  readonly linkPreviewStore: BookmarkFaviconObjectStore | undefined;
  /** Public object stores handed to the app and the lifecycle as one spread. */
  readonly publicObjectStores: {
    readonly faviconStore: BookmarkFaviconObjectStore | undefined;
    readonly linkPreviewStore: BookmarkFaviconObjectStore | undefined;
  };
  readonly attachmentsCapabilityReadiness: () => Promise<ReturnType<typeof evaluateAttachmentsCapabilityReadiness>>;
}

async function closePartialAttachmentsComposition(input: {
  readonly attachmentRateLimit: AttachmentRateLimitComposition | undefined;
  readonly attachmentsObjectStorage: BlobStorePort | undefined;
  readonly avatarStore: AvatarObjectStore | undefined;
  readonly faviconStore: BookmarkFaviconObjectStore | undefined;
  readonly linkPreviewStore?: BookmarkFaviconObjectStore | undefined;
}): Promise<void> {
  const closeables = [
    input.linkPreviewStore,
    input.faviconStore,
    input.avatarStore,
    input.attachmentsObjectStorage,
    input.attachmentRateLimit,
  ];
  for (const closeable of closeables) {
    if (closeable?.close !== undefined) {
      await settleBestEffort(
        closeable.close(),
        'the original API attachment composition failure remains authoritative',
      );
    }
  }
}

export async function composeApiAttachments(input: {
  readonly config: ReturnType<typeof loadConfig>;
  readonly database: DatabaseRuntime;
  readonly identityUnitOfWork: IdentityUnitOfWork;
  readonly metrics: Metrics;
  readonly metricsLogger: ReturnType<typeof createLogger>;
}): Promise<ApiAttachmentsComposition> {
  const { config, database, identityUnitOfWork, metrics, metricsLogger } = input;
  let attachmentRateLimit: AttachmentRateLimitComposition | undefined;
  let attachmentsObjectStorage: BlobStorePort | undefined;
  let attachmentRoutes: AttachmentRoutesDependencies | undefined;
  let avatarStore: AvatarObjectStore | undefined;
  let faviconStore: BookmarkFaviconObjectStore | undefined;
  let linkPreviewStore: BookmarkFaviconObjectStore | undefined;
  try {
  if (config.attachments !== undefined) {
    const attachmentConfig = config.attachments;
    attachmentRateLimit = await composeAttachmentRateLimit({
      config: config.attachmentsRateLimit,
      environment: config.nodeEnv,
      resolveKeySecret: resolveApiRateLimitKeySecret,
      metrics,
      logger: (entry: AttachmentRateLimitLogEntry) => {
        // Fixed route/mode/decision/failure-class log only (plan §2.3: never
        // a subject, principal, key, URL or HMAC).
        metricsLogger.info({ rateLimit: entry }, 'attachment rate-limit decision');
      },
    });
    attachmentsObjectStorage = await composeAttachmentsObjectStorage(
      attachmentConfig,
      resolveApiAttachmentSecret,
    );
    const [avatarRwCredential, avatarRoCredential] = await Promise.all([
      resolveApiAttachmentSecret(attachmentConfig.r2.rwSecretRef),
      resolveApiAttachmentSecret(attachmentConfig.r2.roSecretRef),
    ]);
    // F4: the avatar prefix shares the attachments bucket, so reject any
    // config that would let private attachment objects land under the public
    // avatar prefix. Keep the identity triple as defense-in-depth; favicon vs
    // avatar is covered by the bootstrap five-way guard (identity never sees
    // favicon or export).
    assertAvatarPrefixesDoNotOverlap(
      config.avatarR2Prefix,
      attachmentConfig.r2.livePrefix,
      attachmentConfig.r2.probePrefix,
    );
    assertPublicObjectPrefixesDoNotOverlap(
      config.avatarR2Prefix,
      config.faviconR2Prefix,
      attachmentConfig.r2.livePrefix,
      attachmentConfig.r2.probePrefix,
      config.exportJobs.prefix,
      config.linkPreview.r2Prefix,
    );
    avatarStore = createR2AvatarStore({
      endpoint: attachmentConfig.r2.endpoint,
      region: attachmentConfig.r2.region,
      bucket: attachmentConfig.r2.bucket,
      prefix: config.avatarR2Prefix,
      rwCredential: avatarRwCredential,
      roCredential: avatarRoCredential,
    });
    faviconStore = createR2FaviconStore({
      endpoint: attachmentConfig.r2.endpoint,
      region: attachmentConfig.r2.region,
      bucket: attachmentConfig.r2.bucket,
      prefix: config.faviconR2Prefix,
      rwCredential: avatarRwCredential,
      roCredential: avatarRoCredential,
    });
    const attachmentStore: BlobStorePort = attachmentsObjectStorage;
    const attachmentLedger = createPostgresAttachmentsPorts();
    const attachmentUow = createUnitOfWork(database.db);
    const attachmentAccessPolicyFor = (transaction: DatabaseTransaction) =>
      createPostgresAccessPolicyFactsPort(transaction);
    const attachmentAdmissionSwitch = createPostgresAttachmentsAdmissionSwitchStore(database);
    const deliveryCapabilitySecret = await resolveApiDeliveryCapabilitySecret(
      attachmentConfig.deliveryCapabilitySecretRef,
    );
    const deliverySigner = createHmacOwnerDeliveryCapabilitySigner({
      secret: deliveryCapabilitySecret,
      audienceOrigin: attachmentConfig.isolatedDeliveryOrigin,
    });
    // RL04: the route facade owns the bounded local reference decision for
    // download (off/shadow); the use case must never consume a second local
    // attempt, so it receives the permissive limiter.
    const admitDownload = (input: AuthorizeOwnerDownloadInput) => authorizeOwnerDownload({
      ledger: attachmentLedger,
      accessPolicyFor: attachmentAccessPolicyFor,
      uow: attachmentUow,
      capabilitySigner: deliverySigner,
      rateLimiter: createPermissiveDeliveryRateLimiter(),
      config: attachmentConfig,
      now: () => new Date(),
    }, input);
    const attachmentModuleStore = createGenerationObjectStoreAdapter(attachmentStore);
    attachmentRoutes = {
      config,
      identityUnitOfWork,
      attachments: {
        issue: (input) => issueUploadIntentWithAdmissionGate({
          ledger: attachmentLedger,
          accessPolicyFor: attachmentAccessPolicyFor,
          blobStore: attachmentStore,
          uow: attachmentUow,
          crypto: nodeUploadIntentCrypto,
          config: attachmentConfig,
          admissionState: () => attachmentAdmissionSwitch.read(),
        }, input),
        complete: (input) => completeUpload({
          ledger: attachmentLedger,
          blobStore: attachmentModuleStore,
          uow: attachmentUow,
          enqueueVerification: async (transaction, payload) => {
            await appendAttachmentsVerificationOutbox(transaction, payload);
          },
          config: attachmentConfig,
        }, input),
        status: (input) => readAttachmentStatus({
          ledger: attachmentLedger,
          accessPolicyFor: attachmentAccessPolicyFor,
          uow: attachmentUow,
        }, input),
        finalize: (input) => finalizeAttachment({
          ledger: attachmentLedger,
          canonical: createPostgresAttachmentCanonicalMutationPorts(),
          accessPolicyFor: attachmentAccessPolicyFor,
          uow: attachmentUow,
          recoveryUow: createUnitOfWork(database.db),
        }, input),
        replacement: (input) => issueReplacementIntent({
          ledger: attachmentLedger,
          accessPolicyFor: attachmentAccessPolicyFor,
          blobStore: attachmentStore,
          uow: attachmentUow,
          crypto: nodeUploadIntentCrypto,
          config: attachmentConfig,
        }, input),
        retire: (input) => retireAttachment({
          ledger: attachmentLedger,
          canonical: createPostgresAttachmentCanonicalMutationPorts(),
          accessPolicyFor: attachmentAccessPolicyFor,
          uow: attachmentUow,
          recoveryUow: createUnitOfWork(database.db),
        }, input),
        download: admitDownload,
        rateLimit: attachmentRateLimit.facade,
      },
    };
  }

  // Avatar-specific R2 store, independent of the full ATTACHMENTS_ENABLED
  // feature. This lets deployments that only want public avatar uploads use
  // Cloudflare R2 without enabling the private attachment/delivery surface.
  // Favicon GET uses the same bucket/endpoint/region/credentials with an
  // isolated prefix (FAVICON_R2_PREFIX, default favicon/).
  if (!avatarStore) {
    const endpoint = process.env.AVATAR_R2_ENDPOINT?.trim();
    const bucket = process.env.AVATAR_R2_BUCKET?.trim();
    const rwAccessKeyId = process.env.AVATAR_R2_ACCESS_KEY_ID?.trim();
    const rwSecretAccessKey = process.env.AVATAR_R2_SECRET_ACCESS_KEY?.trim();
    if (endpoint && bucket && rwAccessKeyId && rwSecretAccessKey) {
      const readAccessKeyId = process.env.AVATAR_R2_READ_ACCESS_KEY_ID?.trim() || rwAccessKeyId;
      const readSecretAccessKey = process.env.AVATAR_R2_READ_SECRET_ACCESS_KEY?.trim() || rwSecretAccessKey;
      const rwCredential = { accessKeyId: rwAccessKeyId, secretAccessKey: rwSecretAccessKey };
      const roCredential = { accessKeyId: readAccessKeyId, secretAccessKey: readSecretAccessKey };
      avatarStore = createR2AvatarStore({
        endpoint,
        region: process.env.AVATAR_R2_REGION?.trim() || 'auto',
        bucket,
        prefix: config.avatarR2Prefix,
        rwCredential,
        roCredential,
      });
      if (!faviconStore) {
        faviconStore = createR2FaviconStore({
          endpoint,
          region: process.env.AVATAR_R2_REGION?.trim() || 'auto',
          bucket,
          prefix: config.faviconR2Prefix,
          rwCredential,
          roCredential,
        });
      }
    }
  }
  if (config.linkPreview.enabled) {
    linkPreviewStore = await composeLinkPreviewObjectStore(config, resolveApiAttachmentSecret);
    if (linkPreviewStore === undefined) {
      throw new Error('API composition refused: KNOWN_FEATURE_LINK_PREVIEW enabled requires link preview object storage');
    }
  }
  } catch (error) {
    await closePartialAttachmentsComposition({
      attachmentRateLimit,
      attachmentsObjectStorage,
      avatarStore,
      faviconStore,
      linkPreviewStore,
    });
    throw error;
  }

  const attachmentsCapabilityReadiness = async () => {
    if (config.attachments === undefined) return evaluateAttachmentsCapabilityReadiness(undefined);
    const rateLimitVerdict = attachmentRateLimit?.readiness();
    let admission: { enabled: boolean } | undefined;
    let databaseFact: { status: 'healthy' | 'degraded' } | undefined;
    try {
      const switchState = await createPostgresAttachmentsAdmissionSwitchStore(database).read();
      admission = { enabled: switchState.admissionEnabled };
      databaseFact = { status: 'healthy' };
    } catch {
      databaseFact = { status: 'degraded' };
    }
    let objectStore: { status: 'healthy' | 'degraded' } | undefined;
    if (attachmentsObjectStorage !== undefined) {
      try {
        await attachmentsObjectStorage.probeCapability();
        objectStore = { status: 'healthy' };
      } catch {
        objectStore = { status: 'degraded' };
      }
    }
    const facts: AttachmentsReadinessFacts = {
      ...(admission === undefined ? {} : { admission }),
      ...(databaseFact === undefined ? {} : { database: databaseFact }),
      ...(objectStore === undefined ? {} : { objectStore }),
      ...(rateLimitVerdict === undefined
        ? {}
        : { rateLimit: { status: rateLimitVerdict.status, blocksAttachments: rateLimitVerdict.blocksAttachments } }),
    };
    return evaluateAttachmentsCapabilityReadiness(config.attachments, facts);
  };

  return {
    attachmentRateLimit,
    attachmentsObjectStorage,
    attachmentRoutes,
    avatarStore,
    faviconStore,
    linkPreviewStore,
    publicObjectStores: { faviconStore, linkPreviewStore },
    attachmentsCapabilityReadiness,
  };
}
