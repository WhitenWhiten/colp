/**
 * P4A-P08 production composition for the owner-private delivery surface.
 *
 * This module is the production wiring that connects the I10 admission use
 * case, the I11 isolated delivery host and the shared capability secret into
 * ONE composition the Product API and the delivery process both consume:
 *
 *  - `admitDownload` is the production route port over
 *    `authorizeOwnerDownload`: EVERY admission re-reads the current owner,
 *    logical state, generation state and binding from PostgreSQL (no cached
 *    authorization), rate-limits the attempt through the bounded
 *    `DeliveryRateLimiter` port (the Redis-backed limiter is RL04's task;
 *    this composition keeps the contract slot and never caches an
 *    authorization), and signs a short-lived, audience-bound capability whose
 *    audience is EXACTLY `config.isolatedDeliveryOrigin`;
 *  - `deliveryHost` is the session-free, R2-RO, DB-read-only isolated host
 *    composed through `composeProductionDeliveryHost` with the RO-only R2
 *    credential and the SAME capability secret; the host itself holds no
 *    Known session, no session-database credential and no R2 RW secret (the
 *    delivery process additionally holds a dedicated read-only PostgreSQL
 *    role only through its generation resolver);
 *  - `createPostgresDeliveryGenerationResolver` is the version-fenced
 *    generation resolver the composition injects: the exact physical key is
 *    resolved ONLY while the generation is still the CURRENT ACTIVE
 *    generation of the blob. After a replacement or retirement commits, an
 *    old capability resolves to nothing (zero-body 404) — the old capability
 *    fails by version policy, and the fixed short TTL bounds every other
 *    exposure. The resolver is the RO ledger read path; the delivery host
 *    route itself never connects to the session database.
 *
 * The audience is always `config.isolatedDeliveryOrigin` (the i05 contract
 * guarantees it is an exact https origin on a registrable domain different
 * from the application origin), so a capability can never be consumed on the
 * Known origin.
 */
import type { Pool } from 'pg';
import type { AccessPolicyFactsPort } from '../modules/access-policy/index.js';
import {
  authorizeOwnerDownload,
  createDeliveryRateLimiter,
  createHmacOwnerDeliveryCapabilitySigner,
  type AttachmentsFeatureConfig,
  type AttachmentsLedgerPort,
  type AuthorizeOwnerDownloadInput,
  type AuthorizeOwnerDownloadResult,
  type DeliveryGenerationResolver,
  type DeliveryRateLimiter,
  type IntentUnitOfWork,
  type OwnerDownloadLogger,
} from '../modules/attachments/index.js';
import type { DatabaseTransaction } from '../infrastructure/database/index.js';
import {
  composeProductionDeliveryHost,
  type DeliveryHost,
  type DeliverySecretResolver,
} from './delivery.js';

/**
 * Version-fenced exact-key resolution for the session-free, R2-RO,
 * DB-read-only host. The capability claims carry the blob/generation
 * identity; this resolver maps that identity to the exact physical key ONLY
 * while the generation is still the CURRENT ACTIVE generation of the blob
 * (plan §6 P08: an old capability fails by the fixed short-window/version
 * policy after replacement or revocation; the delivery host never accepts a
 * key from client input). The resolver runs over the delivery process's
 * dedicated READ-ONLY PostgreSQL role (SELECT only).
 */
export function createPostgresDeliveryGenerationResolver(pool: Pool): DeliveryGenerationResolver {
  return async (claims) => {
    const rows = await pool.query<{ key: string }>(
      `select bg.key
         from blob_generations bg
         join blob_records br on br.blob_id = bg.blob_id
        where bg.generation_id = $1
          and bg.blob_id = $2
          and bg.generation_state = 'active'
          and br.current_generation_id = bg.generation_id`,
      [claims.generationId, claims.blobId],
    );
    if (rows.rowCount !== 1) return { found: false };
    return { found: true, handle: { generationId: claims.generationId, key: rows.rows[0]!.key } };
  };
}

export interface ComposeAttachmentDeliveryOptions {
  /** Module config; the capability audience is `config.isolatedDeliveryOrigin`. */
  readonly config: AttachmentsFeatureConfig;
  readonly ledger: AttachmentsLedgerPort<DatabaseTransaction>;
  readonly uow: IntentUnitOfWork<DatabaseTransaction>;
  /** Binds the access-policy facts port to the caller-provided transaction. */
  readonly accessPolicyFor: (transaction: DatabaseTransaction) => AccessPolicyFactsPort;
  /** Version-fenced exact-key resolution for the session-free, R2-RO, DB-read-only host. */
  readonly resolveGeneration: DeliveryGenerationResolver;
  /**
   * Resolves the R2 RO credential and the delivery-capability HMAC secret
   * from their opaque references. The RW secret reference is never
   * consulted: the delivery host structurally holds no write credential.
   */
  readonly resolveSecret: DeliverySecretResolver;
  /** Bounded per-principal admission limiter (RL04 swaps in the Redis port). */
  readonly rateLimiter?: DeliveryRateLimiter;
  /** Fixed-class admission audit logger (never URLs/keys/credentials). */
  readonly log?: OwnerDownloadLogger;
  /** Deterministic test seam shared by signer/admission/verifier. */
  readonly clock?: () => Date;
  readonly hostname?: string;
  readonly port?: number;
  readonly upstreamTimeoutMs?: number;
}

export interface AttachmentDeliveryComposition {
  /** Production download-admission route port (`authorizeOwnerDownload`). */
  readonly admitDownload: (input: AuthorizeOwnerDownloadInput) => Promise<AuthorizeOwnerDownloadResult>;
  /** The isolated delivery host (RO credential only, no session DB). */
  readonly deliveryHost: DeliveryHost;
  readonly rateLimiter: DeliveryRateLimiter;
  close(): Promise<void>;
}

/**
 * Production composition: resolves the capability HMAC secret once, builds
 * the audience-bound signer and the bounded admission limiter, composes the
 * RO-only isolated host, and wires the admission closure. A mismatch between
 * the signer audience and the configured delivery origin fails closed inside
 * `authorizeOwnerDownload` (fixed programming/config error).
 */
export async function composeAttachmentDelivery(
  options: ComposeAttachmentDeliveryOptions,
): Promise<AttachmentDeliveryComposition> {
  const config = options.config;
  const secretValue = await options.resolveSecret(config.deliveryCapabilitySecretRef);
  if (typeof secretValue !== 'string' && !(secretValue instanceof Uint8Array)) {
    throw new Error('delivery_capability_secret_invalid');
  }
  const clock = options.clock;
  const signer = createHmacOwnerDeliveryCapabilitySigner({
    secret: secretValue,
    audienceOrigin: config.isolatedDeliveryOrigin,
    ...(clock === undefined ? {} : { now: clock }),
  });
  const rateLimiter = options.rateLimiter ?? createDeliveryRateLimiter();
  const admitDownload = (input: AuthorizeOwnerDownloadInput): Promise<AuthorizeOwnerDownloadResult> =>
    authorizeOwnerDownload({
      ledger: options.ledger,
      accessPolicyFor: options.accessPolicyFor,
      uow: options.uow,
      capabilitySigner: signer,
      rateLimiter,
      config,
      ...(options.log === undefined ? {} : { log: options.log }),
      ...(clock === undefined ? {} : { now: clock }),
    }, input);

  const deliveryHost = await composeProductionDeliveryHost({
    config,
    resolveGeneration: options.resolveGeneration,
    resolveSecret: options.resolveSecret,
    ...(clock === undefined ? {} : { clock }),
    ...(options.hostname === undefined ? {} : { hostname: options.hostname }),
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.upstreamTimeoutMs === undefined ? {} : { upstreamTimeoutMs: options.upstreamTimeoutMs }),
  });

  return {
    admitDownload,
    deliveryHost,
    rateLimiter,
    async close() {
      await deliveryHost.close();
    },
  };
}
