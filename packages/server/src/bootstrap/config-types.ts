import type { ClassifyInboxFeatureConfig } from './config-classification.js';
export type { ClassifyInboxFeatureConfig } from './config-classification.js';
import type { EmailSkinMap } from '../infrastructure/email/index.js';
import type { McpReadFeatureConfig } from '../modules/mcp/index.js';
import type { ExtensionAuthConfig, OidcEncryptionKey } from '../modules/identity/index.js';
import type { LedgerArchiveRuntimeConfig, SanitizedLedgerArchiveRuntimeConfig } from './config-ledger-archive.js';

export interface RetainedFollowCursorKey {
  readonly id: string;
  readonly secret: string;
  readonly lastIssuedAt: string;
  readonly retainUntil: string;
}
export interface RetainedFeedCursorKey {
  readonly id: string;
  readonly secret: string;
  readonly lastIssuedAt: string;
  readonly retainUntil: string;
}
export interface RetainedPublicActivityCursorKey {
  readonly id: string;
  readonly secret: string;
  readonly lastIssuedAt: string;
  readonly retainUntil: string;
}
export interface RetainedNotificationInboxCursorKey {
  readonly id: string;
  readonly secret: string;
  readonly lastIssuedAt: string;
  readonly retainUntil: string;
}
export interface FeedOperationsConfig {
  readonly queueAgeNotReadyMs: number;
  readonly queueBacklogNotReady: number;
  readonly deadLetterNotReady: number;
  readonly fanoutProgressAgeNotReadyMs: number;
  readonly withdrawalBacklogNotReady: number;
  readonly rebuildMaxEvents: number;
  readonly rebuildMaxRecipientsPerEvent: number;
  readonly rebuildMaxTotalRecipients: number;
  readonly rebuildTimeoutMs: number;
  readonly purgeBatchSize: number;
  readonly retentionDays: number;
}
export interface NotificationOperationsConfig {
  readonly queueAgeNotReadyMs: number;
  readonly queueBacklogNotReady: number;
  readonly queueDeadLetterNotReady: number;
  readonly deliveryBacklogDegraded: number;
  readonly deliveryDeadLetterDegraded: number;
  readonly retentionDays: number;
  readonly purgeBatchSize: number;
  readonly recoveryBatchSize: number;
  readonly recoveryMaxEvents: number;
  readonly recoveryTimeoutMs: number;
}
/**
 * Explicit OIDC client authentication mode (OIDC Core §9 / RFC 6749 §2.3).
 * Never derived from OIDC_CLIENT_SECRET presence: mode/secret conflicts fail
 * closed at startup instead of surfacing as `invalid_client` at the callback.
 * `none` is the legal public-client + PKCE form and is the default.
 */
export type OidcClientAuthMode = 'none' | 'client_secret_post';

export interface OidcConfig {
  readonly issuer: string;
  readonly clientId: string;
  /**
   * Explicit client auth mode; defaults to `none` (public client + PKCE).
   * `none` requires an empty secret, `client_secret_post` a non-empty one.
   */
  readonly clientAuthMode: OidcClientAuthMode;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly audience: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string | null;
  /**
   * When true, accepts the in-process OIDC test double (authorization code
   * format known_test.*). Never enable in production.
   */
  readonly allowTestProvider: boolean;
  /**
   * HMAC secret that signs and verifies in-process `known_test.*` codes.
   * Never defaulted: non-empty only when allowTestProvider is true, and
   * config fails closed unless NODE_ENV=test explicitly supplies it.
   */
  readonly testProviderHmacSecret: string;
}

/** Server-side keys for OIDC login-transaction secret protection (never stored in DB). */
export interface OidcTransactionSecretsConfig {
  readonly hmacSecret: string;
  /** First entry is the current write key; remaining are decrypt-only rotation keys. */
  readonly encryptionKeys: readonly OidcEncryptionKey[];
}

export interface ProductEditorCursorConfig {
  /** Current issuance key. The public ID is included in, and authenticated by, each cursor. */
  readonly current: { readonly id: string; readonly key: string };
  /** Verification-only keys retained until every cursor they signed has expired. */
  readonly previous: readonly {
    readonly id: string;
    readonly key: string;
    readonly lastIssuedAt: string;
    readonly retainUntil: string;
  }[];
  /** Explicit staged rollout mode: legacy first, keyed only after N-1 binaries drain. */
  readonly issuanceFormat: 'legacy' | 'keyed';
  /** Exclusive, bounded deadline for accepting exact pre-key-ID cursor tokens. */
  readonly legacyAcceptUntil: string | undefined;
  /** Absolute TTL from first-page issue (15 minutes). */
  readonly ttlMs: number;
}
export interface ProductOwnedCollectionsCursorConfig {
  readonly current: { readonly id: string; readonly key: string };
  readonly previous: ProductEditorCursorConfig['previous'];
  readonly ttlMs: number;
}

export interface LinkHealthFeatureConfig {
  readonly enabled: boolean;
  readonly cursor: ProductOwnedCollectionsCursorConfig;
  readonly rateLimit: { readonly maxRequests: number; readonly windowMs: number };
  readonly timeoutMs: number;
  readonly probeTimeoutMs: number;
  readonly connectTimeoutMs: number;
  readonly workerConcurrency: number;
  readonly perHostGapMs: number;
  readonly workerPollIntervalMs: number;
  readonly workerLeaseDurationMs: number;
}

export interface ContentGovernanceFeatureConfig {
  readonly enabled: boolean; readonly cursorHmacKey: string | null;
  readonly evidenceMaxBytes: 65536; readonly evidenceRetentionDays: 365;
  readonly reportRate: { readonly maxRequests: 10; readonly windowMs: 3_600_000 };
  readonly actionRate: { readonly maxRequests: 60; readonly windowMs: 60_000 }; readonly appealRate: { readonly maxRequests: 10; readonly windowMs: 86_400_000 }; }

export interface OrganizePlansFeatureConfig {
  readonly enabled: boolean;
  readonly plannerId: string;
}

export interface ReadableReplicaFeatureConfig {
  /** Exposure control only; routes stay registered while false. */
  readonly enabled: boolean;
  /** Whole-probe AbortController budget (default 15s). Not an egress options field. */
  readonly probeTimeoutMs: number;
  /** Optional per-hop connect wrap (default 5s). Not an egress options field. */
  readonly connectTimeoutMs: number;
  /** Bounded HTML body cap (default 2 MiB). Not an egress options field. */
  readonly maxBodyBytes: number;
  /** Worker global concurrency cap (default 2, max 4). */
  readonly workerConcurrency: number;
  /** Minimum interval between fetches of the same normalized host (default 2s). */
  readonly perHostGapMs: number;
  readonly workerPollIntervalMs: number;
  readonly workerLeaseDurationMs: number;
  readonly enqueueCooldownMs: number;
}

export interface CollectionHistoryFeatureConfig {
  /** Exposure control only; collection-history routes stay registered while false (handlers 404). */
  readonly enabled: boolean;
  readonly cursor: ProductOwnedCollectionsCursorConfig;
}

export interface ExportR2Config {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly prefix: string;
  readonly rwCredential: { readonly accessKeyId: string; readonly secretAccessKey: string };
  readonly roCredential: { readonly accessKeyId: string; readonly secretAccessKey: string };
}

export interface ExportJobsFeatureConfig {
  /** Exposure control only; routes stay registered while false (handlers 404). */
  readonly enabled: boolean;
  /**
   * Object-key prefix (`EXPORT_R2_PREFIX`). Default `export/`. Always asserted
   * against avatar/favicon/attachments live/probe even when the flag is false.
   */
  readonly prefix: string;
  /** Private R2 settings; present only when the flag is true. */
  readonly r2: ExportR2Config | null;
  readonly rateLimit: { readonly maxRequests: number; readonly windowMs: number };
  readonly timeoutMs: number;
  readonly workerConcurrency: number;
  readonly workerPollIntervalMs: number;
  readonly workerLeaseDurationMs: number;
}

export interface PublishingInsightsConfig {
  /** HMAC pepper for visitor_hash. Rotation resets visitor identity (no previous keys). */
  readonly visitorHmacKey: Buffer;
  /** Independent HMAC pepper for ingest rate-limit keys. Must not equal visitorHmacKey. */
  readonly rateLimitHmacKey: Buffer;
  /**
   * Cross-instance shared ingest rate-limit adapter. When enabled, the
   * production composition injects Redis. HMAC pepper stays
   * `rateLimitHmacKey` (`PUBLISHING_INSIGHTS_RATELIMIT_HMAC_KEY`), never
   * search/auth peppers. Redis URL may reuse search's URL.
   */
  readonly rateLimitShared: PublishingInsightsRateLimitSharedConfig;
}

/**
 * Cross-instance shared Publishing Insights ingest rate-limit adapter (S-02).
 *
 * Mirrors SEARCH_RATE_LIMIT_SHARED (URL, timeouts, prefix). There is no
 * independent key-secret env: pepper is always
 * PUBLISHING_INSIGHTS_RATELIMIT_HMAC_KEY. Redis failures fail closed (503).
 */
export interface PublishingInsightsRateLimitSharedConfig {
  /** Shared Redis adapter enabled (PUBLISHING_INSIGHTS_RATE_LIMIT_SHARED=true). */
  readonly enabled: boolean;
  /** redis:// or rediss:// endpoint; null when disabled without a URL. */
  readonly redisUrl: string | null;
  /** Redis key namespace prefix; default 'known'. */
  readonly keyPrefix: string;
  /** Per-command timeout (ms); default 75, hard ceiling 5000. */
  readonly commandTimeoutMs: number;
  /** Connect timeout (ms); default 1000, hard ceiling 30000. */
  readonly connectTimeoutMs: number;
  /** Bounded retries per request; default 1, range 0..10. */
  readonly maxRetriesPerRequest: number;
}

/**
 * Cross-instance shared collaboration-invite rate-limit adapter (S-04).
 *
 * Mirrors SEARCH_RATE_LIMIT_SHARED (URL, timeouts, prefix) with an
 * independent HMAC pepper (`COLLABORATION_INVITE_RATE_LIMIT_KEY_SECRET`).
 * Redis URL may reuse search's URL. Redis failures fail closed (503).
 */
export interface CollaborationInviteRateLimitSharedConfig {
  /** Shared Redis adapter enabled (COLLABORATION_INVITE_RATE_LIMIT_SHARED=true). */
  readonly enabled: boolean;
  /** redis:// or rediss:// endpoint; null when disabled without a URL. */
  readonly redisUrl: string | null;
  /** Collaboration-invite codec HMAC key secret bytes; always present after load. */
  readonly keySecret: Buffer;
  /** Redis key namespace prefix; default 'known'. */
  readonly keyPrefix: string;
  /** Per-command timeout (ms); default 75, hard ceiling 5000. */
  readonly commandTimeoutMs: number;
  /** Connect timeout (ms); default 1000, hard ceiling 30000. */
  readonly connectTimeoutMs: number;
  /** Bounded retries per request; default 1, range 0..10. */
  readonly maxRetriesPerRequest: number;
}

/**
 * Background overdue collaboration-invite expiry (P-06). GET lists are
 * read-only; the worker expires pending rows in a bounded batch.
 *
 * Env: COLLABORATION_INVITE_CLEANUP_INTERVAL_MS (default 60000),
 * COLLABORATION_INVITE_CLEANUP_BATCH_SIZE (default 5000, max 10000).
 */
export interface CollaborationInviteCleanupConfig {
  readonly cleanupIntervalMs: number;
  readonly cleanupBatchSize: number;
}

/**
 * Cross-instance shared Explore / COLP Directory rate-limit adapter (P-04).
 *
 * Reuses the Search limiter port as a second instance: distinct Redis
 * `keyPrefix` (default `known-explore`) and an independent HMAC pepper
 * (`EXPLORE_DIRECTORY_RATE_LIMIT_KEY_SECRET`). Redis URL may reuse
 * search's. Redis failures fail closed (503). Search-level default budget
 * (30 anonymous / 120 account / 60s) is copied from Search so the two
 * surfaces stay at the same admission level without sharing counters.
 */
export interface ExploreDirectoryRateLimitSharedConfig {
  /** Shared Redis adapter enabled (EXPLORE_DIRECTORY_RATE_LIMIT_SHARED=true). */
  readonly enabled: boolean;
  /** redis:// or rediss:// endpoint; null when disabled without a URL. */
  readonly redisUrl: string | null;
  /** Explore/directory codec HMAC key secret bytes; null when omitted. */
  readonly keySecret: Buffer | null;
  /** Redis key namespace prefix; default 'known-explore'. */
  readonly keyPrefix: string;
  /** Per-command timeout (ms); default 75, hard ceiling 5000. */
  readonly commandTimeoutMs: number;
  /** Connect timeout (ms); default 1000, hard ceiling 30000. */
  readonly connectTimeoutMs: number;
  /** Bounded retries per request; default 1, range 0..10. */
  readonly maxRetriesPerRequest: number;
}

export interface ExploreDirectoryRateLimitConfig {
  /** Anonymous Explore/Directory budget per window (trusted client IP). */
  readonly anonymousMaxRequests: number;
  /** Authenticated Directory budget per window (account id). */
  readonly accountMaxRequests: number;
  readonly windowMs: number;
  readonly shared: ExploreDirectoryRateLimitSharedConfig;
}

/**
 * Cross-instance shared Sync COLP push/pull rate-limit adapter (P-09).
 *
 * Independent Redis family from Search/Explore (distinct prefix default
 * `known-sync` and HMAC pepper `SYNC_RATE_LIMIT_KEY_SECRET`). Redis URL may
 * reuse search's. Redis failures fail closed (COLP `service_unavailable`
 * 503). Budgets stay on `syncSession.push.rateLimit` / `pull.rateLimit`.
 */
export interface SyncColpRateLimitSharedConfig {
  /** Shared Redis adapter enabled (SYNC_RATE_LIMIT_SHARED=true). */
  readonly enabled: boolean;
  /** redis:// or rediss:// endpoint; null when disabled without a URL. */
  readonly redisUrl: string | null;
  /** Sync COLP codec HMAC key secret bytes; null when omitted. */
  readonly keySecret: Buffer | null;
  /** Redis key namespace prefix; default 'known-sync'. */
  readonly keyPrefix: string;
  /** Per-command timeout (ms); default 75, hard ceiling 5000. */
  readonly commandTimeoutMs: number;
  /** Connect timeout (ms); default 1000, hard ceiling 30000. */
  readonly connectTimeoutMs: number;
  /** Bounded retries per request; default 1, range 0..10. */
  readonly maxRetriesPerRequest: number;
}

export interface SyncColpRateLimitConfig {
  readonly shared: SyncColpRateLimitSharedConfig;
}

/**
 * PERIPH-P1-c shared Redis adapter for one independent quota family
 * (follow / feed / notification / effect-page). Mirrors Explore/COLP:
 * distinct prefix + HMAC pepper, Redis URL may reuse search's, Redis
 * failures fail closed. Required in production multi-replica only when the
 * corresponding surface is actually enabled (Follow/Feed/Notifications
 * flags, or Sync Sessions for effect-page) — Explore remains the
 * always-on replica gate.
 */
export interface RedisRateLimitFamilySharedConfig {
  readonly enabled: boolean;
  readonly redisUrl: string | null;
  readonly keySecret: Buffer | null;
  readonly keyPrefix: string;
  readonly commandTimeoutMs: number;
  readonly connectTimeoutMs: number;
  readonly maxRetriesPerRequest: number;
}

export interface SyncEffectPageRateLimitConfig {
  readonly shared: RedisRateLimitFamilySharedConfig;
}

/**
 * Cross-instance shared auth rate-limit adapter (FIX-M-001).
 *
 * When enabled, the production composition injects a Redis fixed-window
 * adapter (auth codec: trusted client IP + route family) so N API replicas
 * share ONE quota and restarts never reset it. The HMAC key secret VALUE is
 * resolved here and stored as bytes (never logged or serialized; excluded
 * from `sanitizedRuntimeCapacity`). Redis failures fail closed (503).
 */
export interface AuthRateLimitSharedConfig {
  /** Shared Redis adapter enabled (AUTH_RATE_LIMIT_SHARED=true). */
  readonly enabled: boolean;
  /** redis:// or rediss:// endpoint; null when disabled without a URL. */
  readonly redisUrl: string | null;
  /** Auth codec HMAC key secret bytes; null when disabled. */
  readonly keySecret: Buffer | null;
  /** Redis key namespace prefix (auth codec); default 'known'. */
  readonly keyPrefix: string;
  /** Per-command timeout (ms); default 75, hard ceiling 5000. */
  readonly commandTimeoutMs: number;
  /** Connect timeout (ms); default 1000, hard ceiling 30000. */
  readonly connectTimeoutMs: number;
  /** Bounded retries per request; default 1, range 0..10. */
  readonly maxRetriesPerRequest: number;
}

/**
 * Cross-instance shared Search rate-limit adapter (FIX-M-006, mirrors the
 * auth adapter contract).
 *
 * When enabled, the production composition injects a Redis fixed-window
 * adapter (search codec: trusted client IP or account id + sealed family) so
 * N API replicas share ONE quota and restarts never reset it. The HMAC key
 * secret VALUE is resolved here and stored as bytes (never logged or
 * serialized). Redis failures fail closed (503).
 */
export interface SearchRateLimitSharedConfig {
  /** Shared Redis adapter enabled (SEARCH_RATE_LIMIT_SHARED=true). */
  readonly enabled: boolean;
  /** redis:// or rediss:// endpoint; null when disabled without a URL. */
  readonly redisUrl: string | null;
  /** Search codec HMAC key secret bytes; null when disabled. */
  readonly keySecret: Buffer | null;
  /** Redis key namespace prefix (search codec); default 'known'. */
  readonly keyPrefix: string;
  /** Per-command timeout (ms); default 75, hard ceiling 5000. */
  readonly commandTimeoutMs: number;
  /** Connect timeout (ms); default 1000, hard ceiling 30000. */
  readonly connectTimeoutMs: number;
  /** Bounded retries per request; default 1, range 0..10. */
  readonly maxRetriesPerRequest: number;
}

/**
 * Cross-instance shared MCP rate-limit adapter (FIX-M-018, mirrors the auth
 * adapter contract).
 *
 * When enabled, the production composition injects one Redis fixed-window
 * adapter behind the unified MCP rate-limit port with three named policies
 * (request / approval / commit-distinct-plan; MCP codec: HMAC over stable
 * principal/client/binding facts) so N API replicas share ONE quota per
 * policy and restarts never reset it. The HMAC key secret VALUE is resolved
 * here and stored as bytes (never logged or serialized). Redis failures
 * fail closed (request/approval 503, commit denied).
 */
export interface McpRateLimitSharedConfig {
  /** Shared Redis adapter enabled (MCP_RATE_LIMIT_SHARED=true). */
  readonly enabled: boolean;
  /** redis:// or rediss:// endpoint; null when disabled without a URL. */
  readonly redisUrl: string | null;
  /** MCP codec HMAC key secret bytes; null when disabled. */
  readonly keySecret: Buffer | null;
  /** Redis key namespace prefix (mcp codec); default 'known'. */
  readonly keyPrefix: string;
  /** Per-command timeout (ms); default 75, hard ceiling 5000. */
  readonly commandTimeoutMs: number;
  /** Connect timeout (ms); default 1000, hard ceiling 30000. */
  readonly connectTimeoutMs: number;
  /** Bounded retries per request; default 1, range 0..10. */
  readonly maxRetriesPerRequest: number;
}

/**
 * FIX-L-061 shared Redis adapter config for the email callback ingress
 * trusted-IP budget (audit KA-P5-SOC-16). Mirrors the MCP shared config:
 * when enabled, the API composition injects ONE Redis fixed-window adapter
 * behind the `EmailCallbackRateLimiter` port (email-callback codec: HMAC
 * over the trusted client IP) so N API replicas share ONE quota per IP and
 * restarts never reset it. The HMAC key secret VALUE is resolved here and
 * stored as bytes (never logged or serialized). Redis failures fail closed
 * (route 503, never silent unlimited admit).
 */
export interface EmailCallbackRateLimitSharedConfig {
  /** Shared Redis adapter enabled (EMAIL_CALLBACK_RATE_LIMIT_SHARED=true). */
  readonly enabled: boolean;
  /** redis:// or rediss:// endpoint; null when disabled without a URL. */
  readonly redisUrl: string | null;
  /** Email-callback codec HMAC key secret bytes; null when disabled. */
  readonly keySecret: Buffer | null;
  /** Redis key namespace prefix (email-callback codec); default 'known'. */
  readonly keyPrefix: string;
  /** Per-command timeout (ms); default 75, hard ceiling 5000. */
  readonly commandTimeoutMs: number;
  /** Connect timeout (ms); default 1000, hard ceiling 30000. */
  readonly connectTimeoutMs: number;
  /** Bounded retries per request; default 1, range 0..10. */
  readonly maxRetriesPerRequest: number;
}

/**
 * Production HTTP security baseline settings.
 * Rate limiting defaults to single-process memory; multi-replica deployments
 * MUST configure the shared adapters (AUTH_RATE_LIMIT_SHARED=true,
 * SEARCH_RATE_LIMIT_SHARED=true,
 * PUBLISHING_INSIGHTS_RATE_LIMIT_SHARED=true,
 * COLLABORATION_INVITE_RATE_LIMIT_SHARED=true,
 * EXPLORE_DIRECTORY_RATE_LIMIT_SHARED=true,
 * PUBLIC_ACTIVITY_RATE_LIMIT_SHARED=true, and
 * PRODUCT_ROUTE_RATE_LIMIT_SHARED=true), enforced by the startup gate below.
 * Follow / Feed / Notifications / effect-page each fail closed
 * when THEIR shared flag is true without an adapter; production
 * AUTH_API_REPLICAS>1 requires those flags only when the surface is enabled
 * (Sync COLP already has SYNC_RATE_LIMIT_SHARED).
 */
export interface HttpSecurityConfig {
  /**
   * Number of trusted reverse-proxy hops. 0 = do not trust X-Forwarded-*.
   * Only the peer address (or the hop within this bound) feeds request.ip.
   *
   * FIX-M-006: production MUST declare the explicit ingress allowlist
   * (`TRUSTED_INGRESS`) instead — the hop count is kept only as a
   * non-production fallback (readiness fails a production deployment that
   * relies on hops alone).
   */
  readonly trustedProxyHops: number;
  /**
   * Explicit trusted-ingress allowlist (TRUSTED_INGRESS): CIDRs / exact
   * addresses whose socket peers may contribute X-Forwarded-For entries to
   * `request.ip`. Empty = no trusted peer (forwarded headers ignored).
   * `declared` is true when the operator set the variable (even empty) —
   * production readiness requires the explicit declaration.
   */
  readonly trustedIngress: readonly string[];
  readonly trustedIngressDeclared: boolean;
  /** Global raw body ceiling (bytes). Route-level limits may be lower. */
  readonly bodyLimitBytes: number;
  /** Fastify request timeout (ms). 0 disables. */
  readonly requestTimeoutMs: number;
  /** Incoming socket inactivity timeout (ms). 0 disables. */
  readonly connectionTimeoutMs: number;
  /** HTTP keep-alive timeout (ms). */
  readonly keepAliveTimeoutMs: number;
  /** Auth/session rate limit budget (IP × route family); shared across replicas when enabled. */
  readonly authRateLimit: {
    readonly maxRequests: number;
    readonly windowMs: number;
    /** Cross-instance shared Redis adapter (FIX-M-001). */
    readonly shared: AuthRateLimitSharedConfig;
  };
  /**
   * Search Product rate limit budget (FIX-M-006): the anonymous budget is
   * IP-keyed and INDEPENDENT from the auth parameters; the account budget
   * is account-keyed. Shared across replicas when enabled.
   */
  readonly searchRateLimit: {
    /** Anonymous Search budget per window (trusted client IP). */
    readonly anonymousMaxRequests: number;
    /** Authenticated Search budget per window (account id). */
    readonly accountMaxRequests: number;
    readonly windowMs: number;
    /** Cross-instance shared Redis adapter (FIX-M-006). */
    readonly shared: SearchRateLimitSharedConfig;
  };
  /**
   * Declared API replica count (AUTH_API_REPLICAS). A production
   * multi-replica declaration without the shared adapter fails startup.
   */
  readonly authApiReplicas: number;
  /** Emit Strict-Transport-Security (production HTTPS edge). */
  readonly enableHsts: boolean;
}

/**
 * PostgreSQL pool capacity and statement/lock timeouts.
 * Values are safe integers with explicit upper bounds (no unbounded pools).
 */
export interface DatabasePoolConfig {
  /** Maximum concurrent clients in the pg pool. */
  readonly maxConnections: number;
  /** Time to wait for a free pool client before failing (backpressure). */
  readonly connectionTimeoutMs: number;
  /** Idle client reaping threshold. */
  readonly idleTimeoutMs: number;
  /** PostgreSQL statement_timeout applied on connect. */
  readonly statementTimeoutMs: number;
  /** PostgreSQL lock_timeout applied on connect. */
  readonly lockTimeoutMs: number;
  /** PostgreSQL idle_in_transaction_session_timeout applied on connect. */
  readonly idleTransactionTimeoutMs: number;
}

/**
 * Outbox worker claim/lease and bounded parallelism settings.
 * Concurrency is always capped by database pool capacity at load time.
 */
export interface WorkerConcurrencyConfig {
  /** Max events claimed/processed per poll batch (never unbounded). */
  readonly batchSize: number;
  /** Sleep between empty claim polls. */
  readonly pollIntervalMs: number;
  /** Lease duration granted on claim / heartbeat renew. */
  readonly leaseDurationMs: number;
  /** Heartbeat period; must be strictly less than leaseDurationMs. */
  readonly heartbeatIntervalMs: number;
  /** Hard handler deadline; defaults to lease duration. */
  readonly handlerTimeoutMs: number;
  /** Max concurrent in-flight handlers (≤ database.maxConnections). */
  readonly concurrency: number;
}

export interface PublisherReceiptRetentionConfig {
  /** Background cleanup cadence. Cleanup never runs in a request transaction. */
  readonly cleanupIntervalMs: number;
  /** Maximum completed receipts deleted by one cleanup transaction. */
  readonly cleanupBatchSize: number;
}

/**
 * Background publication-insight retention (P-01). Cleanup never runs in an
 * ingest request transaction. Defaults match publisher-style cadence; batch
 * default is PUBLICATION_INSIGHT_PURGE_LIMIT (5000) so one tick stays bounded.
 *
 * Env: PUBLICATION_INSIGHT_CLEANUP_INTERVAL_MS (default 60000),
 * PUBLICATION_INSIGHT_CLEANUP_BATCH_SIZE (default 5000, max 10000).
 */
export interface PublicationInsightRetentionConfig {
  /** Background cleanup cadence. Cleanup never runs in an ingest transaction. */
  readonly cleanupIntervalMs: number;
  /** Maximum expired event rows and daily rows deleted per table per tick. */
  readonly cleanupBatchSize: number;
}

export interface PublicationConfig {
  readonly origin: string;
  readonly mountPath: '/colp/v0.1/';
  readonly serverUuid: string;
  readonly title: string;
  readonly maxPageSize: number;
  readonly maxSnapshotNodes: number;
  readonly endpoints: {
    readonly directory: string;
    readonly collection: string;
    readonly snapshot: string;
    readonly syncSessions?: string;
    readonly syncSnapshot?: string;
    readonly syncPush?: string;
    readonly syncPull?: string;
    readonly syncEffectPages?: string;
    readonly syncAck?: string;
    readonly syncConflict?: string;
  };
  readonly syncRetire?: { readonly href: string };
  readonly sync?: {
    readonly multiCollectionSessions: false;
    readonly maxBatchOperations: 1;
    readonly cursorRetentionSeconds: number;
  };
  readonly cursorKeys: {
    readonly active: { readonly id: string; readonly secret: string };
    readonly retained: readonly { readonly id: string; readonly secret: string }[];
  };
  readonly indexNow: { readonly enabled: false } | { readonly enabled: true; readonly key: string; readonly timeoutMs: 5_000 };
  /** Vendor-neutral purge gateway used by the Worker; tests may inject the provider port. */
  readonly cachePurge?: {
    readonly endpoint: string;
    readonly bearerToken?: string;
    readonly timeoutMs: number;
  };
}

/**
 * MCP-W10 Write host config. Present only when both the MCP Read feature and
 * the Write feature flag are on. The requestState key is canonical base64 key
 * material, never a plaintext credential; the approval URI stays on the
 * Product origin.
 */
export interface McpWriteFeatureConfig {
  readonly enabled: true;
  readonly requestStateKey: string;
  readonly approvalBaseUri: string;
  readonly planTtlMilliseconds: number;
  /** Bounded per-binding distinct Plan commit budget; production requires explicit env. */
  readonly commitRateLimit: {
    readonly maxPlans: number;
    readonly windowMs: number;
  };
  /** Bounded background maintenance interval; no separate production flag. */
  readonly maintenanceIntervalMs: number;
}

/**
 * T01 Redis hot-data cache configuration contract (plan §5/§6.4).
 * This section is pure configuration: nothing here creates or connects a Redis
 * client. T01 only adds types, defaults, range checks and production-missing
 * rules; connection/readiness behavior arrives in later tasks (T03/T10/T11).
 * Credentials live exclusively inside `RedisConnectionConfig.url` and are
 * excluded from `sanitizedRuntimeCapacity`.
 */
export type CacheMode = 'off' | 'shadow' | 'serve';

export interface RedisConnectionConfig {
  /** off = no client/reads; shadow = write+digest compare, always return DB; serve = cache-aside. */
  readonly mode: CacheMode;
  /**
   * Readiness fact only (KNOWN_CACHE_REQUIRED, default false). Whether Redis
   * unavailability blocks readiness is enforced by T10/T11, never at parse time.
   */
  readonly required: boolean;
  /**
   * Opaque full REDIS_URL (redis:// or rediss://). Null when mode is off and no
   * URL was supplied. Never emitted by sanitizedRuntimeCapacity and never
   * interpolated into validation error messages.
   */
  readonly url: string | null;
  /** Per-command timeout (ms); default 75, max 5000 (bounded request budget). */
  readonly commandTimeoutMs: number;
  /** Connect timeout (ms); default 1000, max 30000 (bounded startup). */
  readonly connectTimeoutMs: number;
  /** Bounded retries per request; default 1, range 0..10 (offline queue off in T03). */
  readonly maxRetriesPerRequest: number;
  /** Redis key namespace prefix; default 'known', 1-64 chars of [A-Za-z0-9_.:-]. */
  readonly keyPrefix: string;
}

export interface CacheEntryLimitsConfig {
  /** Maximum cacheable envelope bytes; default 524288 (512 KiB), capped at 524288. */
  readonly maxEntryBytes: number;
  /** Short distributed-lock TTL (ms); default 1500, max 60000. */
  readonly lockTtlMs: number;
}

export interface CacheTtlConfig {
  readonly softTtlMs: number;
  readonly hardTtlMs: number;
}

export interface PublicationCacheConfig {
  /** Metadata domain TTL pair; default soft 10000 / hard 30000. */
  readonly metadata: CacheTtlConfig;
  /** Snapshot domain TTL pair; default soft 10000 / hard 30000. */
  readonly snapshot: CacheTtlConfig;
  /** Directory domain TTL pair; default soft 5000 / hard 15000. */
  readonly directory: CacheTtlConfig;
  /** Independent grayable domain switches; default all false. */
  readonly metadataEnabled: boolean;
  readonly directoryEnabled: boolean;
  readonly snapshotEnabled: boolean;
}

export interface CollectionCacheConfig {
  /** Bookmark-count domain TTL pair; default soft 60000 / hard 300000. */
  readonly bookmarkCount: CacheTtlConfig;
  /** Independent grayable domain switch; default false. Takes effect only under shadow|serve. */
  readonly bookmarkCountEnabled: boolean;
}

export interface CacheConfig {
  readonly redis: RedisConnectionConfig;
  readonly limits: CacheEntryLimitsConfig;
  readonly publication: PublicationCacheConfig;
  readonly collection: CollectionCacheConfig; readonly reports: import('./config-reports.js').ReportsCacheConfig;
}

/** Default commit distinct-plan budget for development/test only; production must set env explicitly. */
export interface AppConfig {
  readonly bookmarkSubscriptions?: { readonly enabled: boolean; readonly protocolReady: boolean };
  readonly nodeEnv: string;
  readonly host: string;
  readonly port: number;
  readonly databaseUrl: string;
  /**
   * Postgres TLS requirement (`DATABASE_SSL_MODE`): true = require
   * `ssl: { rejectUnauthorized: true }` (production default); false = plain
   * connection for Postgres inside the same compose network.
   */
  readonly databaseSsl: boolean;
  readonly logLevel: string;
  /** Exact Product origin used for returnTo validation and CORS (e.g. https://app.example). */
  readonly productOrigin: string;
  /** Exact allowed browser Origins for CSRF/CORS (same-site). */
  readonly allowedOrigins: readonly string[];
  readonly oidc: OidcConfig;
  /** Explicit browser-test identity seam. Valid only with NODE_ENV=test. */
  readonly testIdentityProviderEnabled: boolean;
  /**
   * E3 test-only auth-mailbox query surface (KNOWN_AUTH_MAILBOX_HTTP +
   * KNOWN_AUTH_MAILBOX_HTTP_TOKEN): exposes the API process's in-process C1
   * mailbox sink (test material only — purpose/email/OTP/expiry/idempotency
   * key) to the separate real-stack harness process over HTTP. Valid only
   * with NODE_ENV=test; every default/production combination registers
   * nothing, so the route stays a natural 404 (F3 zero-call evidence).
   */
  readonly testAuthMailboxHttp: Readonly<{ enabled: boolean; token: string }>;
  readonly oidcTransactionSecrets: OidcTransactionSecretsConfig;
  readonly sessionCookieName: '__Host-known_session';
  readonly productEditorCursor: ProductEditorCursorConfig;
  readonly productOwnedCollectionsCursor: ProductOwnedCollectionsCursorConfig;
  readonly linkHealth: LinkHealthFeatureConfig;
  readonly classification: ReturnType<typeof import('./config-classification.js').loadClassificationConfig>;
  readonly organizePlans: OrganizePlansFeatureConfig;
  readonly readableReplica: ReadableReplicaFeatureConfig;
  readonly linkPreview: import('./config-link-preview.js').LinkPreviewFeatureConfig;
  readonly classifyInbox: ClassifyInboxFeatureConfig;
  readonly collectionHistory: CollectionHistoryFeatureConfig;
  readonly exportJobs: ExportJobsFeatureConfig;
  readonly ledgerArchive: LedgerArchiveRuntimeConfig;
  readonly ledgerArchiveReader: import('./config-ledger-archive-reader.js').LedgerArchiveReaderRuntimeConfig;
  readonly publishingInsights: PublishingInsightsConfig;
  /** Cross-instance shared collaboration-invite limiter (S-04). */
  readonly collaborationInviteRateLimit: CollaborationInviteRateLimitSharedConfig;
  /** Cross-instance Explore / COLP Directory limiter (P-04); independent from Search. */
  readonly exploreDirectoryRateLimit: ExploreDirectoryRateLimitConfig;
  /**
   * Cross-instance public Profile Activity limiter (PA-01); independent from
   * Search and Explore. It is always mounted by production composition, so a
   * production multi-replica declaration requires the shared adapter.
   */
  readonly publicActivityRateLimit: ExploreDirectoryRateLimitConfig;
  /**
   * Shared backing for library-order, link-health, classify-inbox,
   * export-job, organize-plan, collection-version, readable-replica and
   * public-object admission. Their Redis keys remain purpose-isolated.
   */
  readonly productRouteRateLimitShared: RedisRateLimitFamilySharedConfig;
  /**
   * Cross-instance Sync COLP push/pull limiter (P-09); independent from
   * Search/Explore. Required in production only when Sync Sessions are
   * enabled AND AUTH_API_REPLICAS > 1.
   */
  readonly syncRateLimit: SyncColpRateLimitConfig;
  /**
   * Cross-instance Sync effect-page limiter (PERIPH-P1-c); independent from
   * SYNC_RATE_LIMIT_SHARED push/pull. Required in production only when Sync
   * Sessions are enabled AND AUTH_API_REPLICAS > 1.
   */
  readonly syncEffectPageRateLimit: SyncEffectPageRateLimitConfig;
  /** Worker overdue-invite expiry cadence (P-06). */
  readonly collaborationInviteCleanup: CollaborationInviteCleanupConfig;
  readonly httpSecurity: HttpSecurityConfig;
  readonly database: DatabasePoolConfig;
  /** Redis hot-data cache contract (T01); always present, defaults to mode off. */
  readonly cache: CacheConfig; readonly reports: import('./config-reports.js').ReportsFeatureConfig;
  readonly contentGovernance: ContentGovernanceFeatureConfig;
  readonly worker: WorkerConcurrencyConfig;
  readonly publisherReceipts: PublisherReceiptRetentionConfig;
  readonly publicationInsightRetention: PublicationInsightRetentionConfig;
  readonly syncTombstonePurge: SyncTombstonePurgeConfig;
  readonly syncEvidenceMaintenance: SyncEvidenceMaintenanceConfig;
  readonly publication: PublicationConfig;
  readonly syncSession?: SyncSessionConfig;
  readonly follow?: FollowFeatureConfig;
  readonly collectionFollow: CollectionFollowFeatureConfig;
  readonly community: CommunityFeatureConfig;
  /** Admission budget for GET/PUT /me/library-order. */
  readonly libraryOrder: LibraryOrderAdmissionConfig;
  /** FO-01 favicon policy/source admission (KNOWN_FEATURE_FAVICON_POLICY). */
  readonly faviconPolicy: FaviconPolicyAdmissionConfig;
  readonly feed?: FeedFeatureConfig;
  readonly publicActivity: PublicActivityFeatureConfig;
  readonly notifications?: NotificationFeatureConfig;
  readonly email?: EmailFeatureConfig;
  /**
   * Better Auth feature section (A1; G1 §6/§16). Always present with closed
   * defaults: `enabled=false` (production default) registers zero Better Auth
   * surface and keeps the legacy OIDC chain unchanged.
   */
  readonly betterAuth: BetterAuthFeatureConfig;
  /**
   * C1 auth email delivery section (AUTH_EMAIL_*). Always present with closed
   * defaults: `enabled=false` (rollback flag) composes the unavailable sender;
   * test mode uses the in-process mailbox sink; any other environment requires
   * DirectMail credentials at composition (fail closed).
   */
  readonly authEmail: AuthEmailFeatureConfig;
  /**
   * SC-04 transactional collection invite email (COLLABORATION_INVITE_EMAIL_*).
   * Always present with closed defaults: `enabled=false` inserts delivery rows
   * as suppressed/not_configured. Test mode uses the in-process mailbox sink;
   * any other environment requires DirectMail AccountName (this key or
   * AUTH_EMAIL_DM_ACCOUNT_NAME fallback) at composition (fail closed).
   */
  readonly collaborationInviteEmail: CollaborationInviteEmailConfig;
  /**
   * MAIL-01 selectable skins (`EMAIL_SKIN_DEFAULT` + `EMAIL_SKIN_<PURPOSE>`).
   * Always present; default every purpose to `purpose` (today's inner copy).
   */
  readonly emailSkins: EmailSkinMap;
  /**
   * Public avatar object-key prefix (`AVATAR_R2_PREFIX`). Default `avatar/`.
   * Must not overlap favicon or the reserved attachment prefixes (§2.10).
   */
  readonly avatarR2Prefix: string;
  /**
   * Public bookmark favicon object-key prefix (`FAVICON_R2_PREFIX`).
   * Default `favicon/`. Isolated from identity; GET keys are `{prefix}{uuid}`.
   */
  readonly faviconR2Prefix: string;
  /**
   * FIX-M-018 cross-instance shared MCP rate-limit adapter (unified port:
   * request / approval / commit-distinct-plan); always present, defaults to
   * disabled (zero Redis connections, in-process adapters). Orthogonal to
   * `cache.redis` and the auth/search/attachment limiters.
   */
  readonly mcpRateLimit: McpRateLimitSharedConfig;
  /** Phase 4B MCP Read (Modern 2026-07-28 only); present only when KNOWN_FEATURE_MCP_READ=true. Nested compat is present only when KNOWN_FEATURE_MCP_COMPAT=true. */
  readonly mcp?: McpReadFeatureConfig;
  /** MCP-W09 operational Write surface; defaults off and never claims mcp-write. */
  readonly mcpWriteEnabled: boolean;
  /** MCP-W10 real Write host composition; present only with Read + Write flags. */
  readonly mcpWrite?: McpWriteFeatureConfig;
  /** Origin-injected public collection/Profile shells; independently default off. */
  readonly publicShellMeta: PublicShellMetaConfig;
  /** M-09 `/u/:handle` shell switch; shares only WEB_SHELL_ORIGIN/cache mechanics. */
  readonly publicProfileShell: PublicShellMetaConfig; readonly accountCredentials: import('./config-account-credentials.js').AccountCredentialsFeatureConfig;
}

export interface PublicShellMetaConfig {
  readonly enabled: boolean;
  /** Exact origin used to GET /index.html. Null when the flag is off. */
  readonly webShellOrigin: string | null;
}

export interface FollowFeatureConfig {
  /** Exposure control only; authority, migrations and ports remain production-wired while false. */
  readonly enabled: boolean;
  readonly cursorKeys: {
    readonly active: { readonly id: string; readonly secret: string };
    readonly retained: readonly RetainedFollowCursorKey[];
  };
  readonly rateLimit: { readonly maxRequests: number; readonly windowMs: number };
  /** Cross-instance shared Redis adapter (FOLLOW_RATE_LIMIT_SHARED). */
  readonly rateLimitShared: RedisRateLimitFamilySharedConfig;
  readonly timeoutMs: number;
}

export interface LibraryOrderAdmissionConfig {
  readonly rateLimit: { readonly maxRequests: number; readonly windowMs: number };
  readonly timeoutMs: number;
}

export interface CommunityFeatureConfig {
  /** Exposure control only; authority, migrations and ports remain production-wired while false. */
  readonly enabled: boolean;
  /**
   * COMMUNITY_CURSOR_HMAC_KEY (base64, at least 32 bytes). Keyed derivation
   * material for community ETags now and opaque cursors in later slices;
   * never logged.
   */
  readonly cursorHmacKey: Buffer;
  /**
   * Contract COMMUNITY_RATE_LIMITS: four independent admission families —
   * vote attempts, comment writes, curation/settings operations, and public
   * reads. Each family has its own counter; they never share a budget.
   * Vote/comment/curation consume per authenticated account (anonymous
   * callers consume per trusted client so the family stays bounded);
   * publicReads consumes per account when signed in, per trusted client
   * otherwise.
   */
  readonly rateLimit: {
    readonly vote: { readonly maxRequests: number; readonly windowMs: number };
    readonly comment: { readonly maxRequests: number; readonly windowMs: number };
    readonly curation: { readonly maxRequests: number; readonly windowMs: number };
    readonly publicReads: { readonly maxRequests: number; readonly windowMs: number };
  };
  readonly timeoutMs: number;
}

/**
 * FO-01/FO-02 favicon policy/admission + durable job worker configuration.
 * The feature gate KNOWN_FEATURE_FAVICON_POLICY defaults to false; the
 * FAVICON_* values follow the frozen contract `x-config` (const values are
 * enforced exactly, ranges are clamped-fail-closed at startup).
 */
export interface FaviconPolicyAdmissionConfig {
  readonly shared?: import('./config-favicon-shared.js').SharedFaviconConfig;
  readonly enabled: boolean;
  readonly timeoutMs: number;
  /**
   * FAVICON_CURSOR_HMAC_KEY (base64url-32-byte-secret). Required (startup
   * fails) when KNOWN_FEATURE_FAVICON_POLICY=true; stable across API
   * instances so cursors issued by one instance verify on another. When the
   * feature is disabled the value is optional and never used (every route
   * returns 404).
   */
  readonly cursorHmacKey: string;
  /** FAVICON_FETCH_TIMEOUT_MS (10000; 1000..30000). */
  readonly fetchTimeoutMs: number;
  /** FAVICON_FETCH_MAX_BYTES (const 65536). */
  readonly fetchMaxBytes: number;
  /** FAVICON_FETCH_MAX_REDIRECTS (const 3). */
  readonly fetchMaxRedirects: number;
  /** FAVICON_JOB_BATCH_SIZE (const 100). */
  readonly jobBatchSize: number;
  /** FAVICON_JOB_MAX_ATTEMPTS (const 5). */
  readonly jobMaxAttempts: number;
  /** FAVICON_HISTORY_RETENTION_SECONDS (const 31536000). */
  readonly historyRetentionSeconds: number;
  /** FAVICON_JOB_CONCURRENCY (const 2). */
  readonly jobConcurrency: number;
  /** FAVICON_RETRY_BACKOFF_SECONDS (const [1,2,4,8,16]). */
  readonly retryBackoffSeconds: readonly number[];
  /** Worker loop poll interval (fixed 1s; internal cadence, not a contract knob). */
  readonly workerPollIntervalMs: number;
  /** Worker lease duration (fixed 60s; internal cadence, not a contract knob). */
  readonly workerLeaseDurationMs: number;
  /** GC poll interval (fixed 60s; internal cadence, not a contract knob). */
  readonly gcPollIntervalMs: number;
}

export interface CollectionFollowFeatureConfig {
  /** Exposure control only; authority, migrations and ports remain production-wired while false. */
  readonly enabled: boolean;
  readonly cursorKeys: {
    readonly active: { readonly id: string; readonly secret: string };
    readonly retained: readonly {
      readonly id: string;
      readonly secret: string;
      readonly lastIssuedAt: string;
      readonly retainUntil: string;
    }[];
  };
  readonly rateLimit: { readonly maxRequests: number; readonly windowMs: number };
  /** Cross-instance shared Redis adapter (COLLECTION_FOLLOW_RATE_LIMIT_SHARED). */
  readonly rateLimitShared: RedisRateLimitFamilySharedConfig;
  readonly timeoutMs: number;
}

export interface FeedFeatureConfig {
  /** Exposure control only; the projection, current-authority query, and ports remain wired while false. */
  readonly enabled: boolean;
  readonly cursorKeys: {
    readonly active: { readonly id: string; readonly secret: string };
    readonly retained: readonly RetainedFeedCursorKey[];
  };
  readonly rateLimit: { readonly maxRequests: number; readonly windowMs: number };
  /** Cross-instance shared Redis adapter (FEED_RATE_LIMIT_SHARED). */
  readonly rateLimitShared: RedisRateLimitFamilySharedConfig;
  readonly timeoutMs: number;
  /** Live Feed fan-out page size (`FEED_FANOUT_PAGE_SIZE`); default 500, range 1..1000. */
  readonly fanoutPageSize: number;
  readonly operations: FeedOperationsConfig;
}

export interface PublicActivityFeatureConfig {
  readonly cursorKeys: {
    readonly active: { readonly id: string; readonly secret: string };
    readonly retained: readonly RetainedPublicActivityCursorKey[];
  };
}

export interface NotificationFeatureConfig {
  readonly enabled: boolean;
  readonly cursorKeys: {
    readonly active: { readonly id: string; readonly secret: string };
    readonly retained: readonly RetainedNotificationInboxCursorKey[];
  };
  readonly rateLimit: { readonly maxRequests: number; readonly windowMs: number };
  /** Cross-instance shared Redis adapter (NOTIFICATION_RATE_LIMIT_SHARED). */
  readonly rateLimitShared: RedisRateLimitFamilySharedConfig;
  readonly timeoutMs: number;
  readonly operations: NotificationOperationsConfig;
}

/**
 * Feature-scoped email delivery config (P5-28). `enabled` is exposure control
 * only (KNOWN_FEATURE_EMAIL, default false). The section carries no provider
 * credentials: ALIBABA_CLOUD_ACCESS_KEY_ID/SECRET load via environment/secret
 * reference at composition. When disabled the section may be absent entirely
 * (follow/feed/notifications pattern); required values are enforced only when
 * enabled (fail closed).
 */
export interface EmailFeatureConfig {
  /** Exposure control only; the adapter and ports remain production-wired while false. */
  readonly enabled: boolean;
  /** DirectMail RPC endpoint (EMAIL_DM_ENDPOINT, default https://dm.aliyuncs.com/). */
  readonly endpoint: string;
  /** DirectMail console/EventBridge region (EMAIL_DM_REGION_ID, default cn-hangzhou). */
  readonly regionId: string;
  /** Verified DirectMail sender AccountName; required when enabled. */
  readonly accountName: string | null;
  /** Per-request provider timeout (EMAIL_DM_TIMEOUT_MS, bounded 500..60000). */
  readonly timeoutMs: number;
  /** TagName prefix for the stable delivery_id idempotency key (EMAIL_DM_TAG_PREFIX). */
  readonly tagPrefix: string;
  /** Maximum TagName chars (EMAIL_DM_MAX_TAG_CHARS, bounded 16..128; frozen max 128). */
  readonly maxTagChars: number;
  readonly callback: {
    /** Shared secret for the frozen X-Known-DM-* HMAC envelope; optional (null when absent). */
    readonly hmacSecret: string | null;
    /** X-Known-DM-Timestamp replay window (EMAIL_DM_CALLBACK_TIMESTAMP_WINDOW_MS, bounded 1000..600000). */
    readonly timestampReplayWindowMs: number;
  };
  readonly opsToken: string | null;
  /** Ops suppression surface rate limit (EMAIL_OPS_RATE_LIMIT_MAX/WINDOW_MS). */
  readonly opsRateLimit: { readonly maxRequests: number; readonly windowMs: number };
  /**
   * FIX-L-061 callback ingress per-trusted-IP budget
   * (EMAIL_CALLBACK_RATE_LIMIT_MAX/WINDOW_MS); default 600/min — generous
   * for legitimate provider redelivery retries, bounded for floods.
   */
  readonly callbackRateLimit: { readonly maxRequests: number; readonly windowMs: number };
  /**
   * FIX-L-061 cross-instance shared Redis adapter for the callback budget
   * (EMAIL_CALLBACK_RATE_LIMIT_SHARED/REDIS_URL/KEY_SECRET); defaults to
   * disabled (zero Redis connections, in-process adapter).
   */
  readonly callbackRateLimitShared: EmailCallbackRateLimitSharedConfig;
  readonly worker: EmailDeliveryWorkerConfig;
}

/** Log-safe view of the email config: never exposes accountName, hmacSecret or credentials. */
/** P5-29 feature-scoped email delivery worker timing/retry bounds. */
export interface EmailDeliveryWorkerConfig {
  /** Bounded total send attempts per delivery (>= 2); the last failing attempt dead-letters. */
  readonly maxAttempts: number;
  /** Exponential backoff base for next_attempt_at (ms). */
  readonly baseBackoffMs: number;
  /** Exponential backoff ceiling (ms). */
  readonly maxBackoffMs: number;
  /** Delivery poll interval (ms). */
  readonly pollIntervalMs: number;
  /** Per-attempt delivery lease (ms); heartbeatIntervalMs must be smaller. */
  readonly leaseDurationMs: number;
  /** Lease heartbeat interval (ms). */
  readonly heartbeatIntervalMs: number;
  /** Max claims per poll cycle. */
  readonly batchSize: number;
}

/**
 * C1 auth email delivery config (AUTH_EMAIL_*). `enabled` is exposure control
 * only (AUTH_EMAIL_ENABLED, default false) and is the auth email rollback
 * flag; the section carries no provider credentials (ALIBABA_CLOUD_ACCESS_KEY_ID/
 * SECRET load via environment/secret reference at composition, exactly like
 * the email feature). When disabled the section keeps closed defaults;
 * required values are enforced only when enabled (fail closed).
 */
export interface AuthEmailFeatureConfig {
  /** Exposure control only (AUTH_EMAIL_ENABLED, default false); rollback flag for the auth email surface. */
  readonly enabled: boolean;
  /** DirectMail RPC endpoint (AUTH_EMAIL_DM_ENDPOINT, default https://dm.aliyuncs.com/). */
  readonly endpoint: string;
  /** DirectMail console/EventBridge region (AUTH_EMAIL_DM_REGION_ID, default cn-hangzhou). */
  readonly regionId: string;
  /** Verified DirectMail sender AccountName; required when enabled (fail closed). */
  readonly accountName: string | null;
  /** Per-request provider timeout (AUTH_EMAIL_DM_TIMEOUT_MS, bounded 500..60000). */
  readonly timeoutMs: number;
  /** TagName prefix for the auth email idempotency key (AUTH_EMAIL_DM_TAG_PREFIX, default known-auth-). */
  readonly tagPrefix: string;
  /** Maximum TagName chars (AUTH_EMAIL_DM_MAX_TAG_CHARS, bounded 16..128; frozen max 128). */
  readonly maxTagChars: number;
}

export interface CollaborationInviteEmailConfig {
  /** COLLABORATION_INVITE_EMAIL_ENABLED; default false. */
  readonly enabled: boolean;
  readonly endpoint: string;
  readonly regionId: string;
  /**
   * DirectMail AccountName from COLLABORATION_INVITE_EMAIL_DM_ACCOUNT_NAME
   * or AUTH_EMAIL_DM_ACCOUNT_NAME. Required when enabled outside test.
   */
  readonly accountName: string | null;
  readonly timeoutMs: number;
  readonly tagPrefix: string;
  readonly maxTagChars: number;
}

export interface EmailFeatureConfigSanitized {
  readonly enabled: boolean;
  readonly endpoint: string;
  readonly regionId: string;
  readonly timeoutMs: number;
  readonly tagPrefix: string;
  readonly maxTagChars: number;
  readonly callbackTimestampReplayWindowMs: number;
  /** P5-29 worker timing/retry bounds (never secrets). */
  readonly worker: EmailDeliveryWorkerConfig;
}
export interface SyncTombstonePurgeConfig {
  readonly enabled: boolean;
  readonly intervalMs: number;
  readonly batchSize: number;
  readonly leaseDurationMs: number;
}

export interface SyncEvidenceMaintenanceConfig {
  readonly enabled: boolean;
  readonly intervalMs: number;
  readonly batchSize: number;
  readonly leaseDurationMs: number;
}

export interface SyncSessionConfig {
  readonly path: string;
  readonly allowedOrigins: readonly string[];
  readonly extensionAuth: ExtensionAuthConfig;
  readonly replayEncryptionKey: Buffer;
  readonly replayEncryptionKeyVersion: number;
  /**
   * FIX-M-011 (SYNC-R06): active encryption key plus retained decryption
   * keyring for Conflict private payloads. New Conflicts always use `active`;
   * `retained` versions still decrypt historical open Conflicts until they
   * are resolved or drained (SYNC_CONFLICT_RETAINED_KEYS).
   */
  readonly conflictPayloadKeyring: {
    readonly active: { readonly key: Buffer; readonly keyVersion: number };
    readonly retained: readonly { readonly key: Buffer; readonly keyVersion: number }[];
  };
  readonly sessionDurationSeconds: number;
  readonly replicaLeaseExtensionSeconds: number;
  readonly tombstoneRetentionSeconds: number;
  readonly rateLimit: { readonly maxRequests: number; readonly windowMs: number };
  /** The built-in limiter is process-local, so this surface is single-instance only. */
  readonly apiInstanceCount: 1;
  readonly allowInsecureLoopback: boolean;
  readonly snapshot: {
    readonly path: string;
    readonly cursorKeyId: string;
    readonly cursorSecret: Buffer;
    readonly cursorTtlMs: number; readonly maxBytes: number;
    readonly rateLimit: { readonly maxRequests: number; readonly windowMs: number };
  };
  readonly push: {
    readonly path: string;
    readonly maxBatchOperations: 1;
    readonly managedBookmarkWrites: boolean;
    readonly rateLimit: { readonly maxRequests: number; readonly windowMs: number };
  };
  readonly conflict: {
    readonly path: string;
    readonly rateLimit: { readonly maxRequests: number; readonly windowMs: number };
  };
  readonly pull: {
    readonly path: string;
    readonly cursorKeys: {
      readonly active: { readonly id: string; readonly secret: string };
      readonly retained: readonly { readonly id: string; readonly secret: string }[];
    };
    readonly cursorTtlMs: number;
    readonly recoveryProofRetentionMs: number;
    /** FIX-L-035: purpose-separated keys for the digest-only cursor lineage receipts. */
    readonly lineageKeys: {
      readonly active: { readonly id: string; readonly secret: string };
      readonly retained: readonly { readonly id: string; readonly secret: string }[];
    };
    /** FIX-L-035: how long signed lineage outlives cursor evidence and recovery proofs. */
    readonly lineageRetentionMs: number;
    readonly maxLimit: number;
    readonly responseBudgetBytes: number;
    readonly requestTimeoutMs: number;
    readonly recommendedPullAfterSeconds: number;
    readonly rateLimit: { readonly maxRequests: number; readonly windowMs: number };
    readonly effectPagePath: string;
    /**
     * FIX-M-013 (SYNC-R08): effect-page admission budgets — subject total
     * bucket (trusted client + session + replica), per-effect sub-bucket, and
     * the low-cost trusted-client IP budget that also bounds error and
     * unauthorized requests.
     */
    readonly effectPageRateLimit: {
      readonly subjectMaxRequests: number;
      readonly effectMaxRequests: number;
      readonly ipMaxRequests: number;
      readonly windowMs: number;
    };
  };
  readonly ack: {
    readonly path: string;
    readonly leaseExtensionSeconds: number;
    readonly maxLeaseLifetimeSeconds: number;
    readonly maxBodyBytes: number;
    readonly maxWarnings: number;
    readonly maxWarningBytes: number;
    readonly rateLimit: { readonly maxRequests: number; readonly windowMs: number };
    readonly recoveryCapabilityKeys: {
      readonly active: { readonly id: string; readonly secret: string };
      readonly retained: readonly { readonly id: string; readonly secret: string }[];
    };
    readonly recoveryCapabilityTtlMs: number;
  };
  readonly retire: {
    readonly path: string;
    readonly rateLimit: { readonly maxRequests: number; readonly windowMs: number };
  };
}

/** Credential-free cache capacity snapshot — excludes the REDIS_URL entirely. */
export interface SanitizedCacheCapacity {
  readonly mode: CacheMode;
  readonly required: boolean;
  readonly keyPrefix: string;
  readonly commandTimeoutMs: number;
  readonly connectTimeoutMs: number;
  readonly maxRetriesPerRequest: number;
  readonly maxEntryBytes: number;
  readonly lockTtlMs: number;
  readonly publication: {
    readonly metadataEnabled: boolean;
    readonly directoryEnabled: boolean;
    readonly snapshotEnabled: boolean;
    readonly metadata: CacheTtlConfig;
    readonly snapshot: CacheTtlConfig;
    readonly directory: CacheTtlConfig;
  };
  readonly collectionBookmarkCountEnabled: boolean;
  readonly collectionBookmarkCount: CacheTtlConfig; readonly reports: import('./config-reports.js').ReportsCacheConfig;
}

/** Sanitized runtime capacity snapshot — never includes credentials or URLs. */
export interface SanitizedRuntimeCapacity {
  readonly database: DatabasePoolConfig;
  readonly worker: WorkerConcurrencyConfig;
  readonly cache: SanitizedCacheCapacity;
  /** Explicit OIDC client auth mode — never the client secret. */
  readonly oidcClientAuthMode: OidcClientAuthMode;
  readonly ledgerArchive: SanitizedLedgerArchiveRuntimeConfig;
  readonly ledgerArchiveReader: import('./config-ledger-archive-reader.js').SanitizedLedgerArchiveReaderRuntimeConfig;
}
/**
 * ADR cutover enum (`shadow` | `canary` | `on`). AUTH-P1-b: parsed so illegal
 * env values still fail startup; unused at runtime. Runtime auth is only
 * `BETTER_AUTH_ENABLED` off/on. Do not implement ADR shadow from this field.
 */
export type BetterAuthCutoverMode = 'shadow' | 'canary' | 'on';

export interface BetterAuthSocialProviderConfig {
  readonly clientId: string;
  readonly clientSecret: string;
}

/**
 * Better Auth feature section (G1 §6/§16, frozen by the migration ADR).
 * `enabled=false` (production default) registers ZERO Better Auth surface;
 * the section carries no credentials in that state. All values come from
 * BETTER_AUTH_* env vars; illegal values fail startup here.
 *
 * AUTH-P1-b: runtime routing is only `enabled` (`BETTER_AUTH_ENABLED`).
 * `cutoverMode` / `canaryAllowlist` stay on the typed section for mapping and
 * fail-closed parse; nothing in `src/` outside these config types may read them.
 */
export interface BetterAuthFeatureConfig {
  /** BETTER_AUTH_ENABLED; false = BA handler not mounted, legacy OIDC chain unchanged. */
  readonly enabled: boolean;
  /**
   * BETTER_AUTH_CUTOVER_MODE; `off` is expressed by enabled=false.
   * AUTH-P1-b unused at runtime (parsed only; ADR shadow/canary is not wired).
   */
  readonly cutoverMode: BetterAuthCutoverMode;
  /**
   * BETTER_AUTH_CANARY_ALLOWLIST; comma-separated emails/account IDs.
   * AUTH-P1-b unused at runtime (parsed only so duplicates still fail startup).
   */
  readonly canaryAllowlist?: readonly string[];
  /** BETTER_AUTH_EMAIL_OTP_ENABLED; email OTP capability switch. */
  readonly emailOtpEnabled: boolean;
  /** BETTER_AUTH_SOCIAL_ENABLED; true requires configured providers (fail closed). */
  readonly socialEnabled: boolean;
  /** BA baseURL; PRODUCT_ORIGIN. */
  readonly baseUrl: string;
  /** BA basePath; allowlisted routes are mounted under this prefix. */
  readonly basePath: string;
  /** BETTER_AUTH_SECRET; non-null only when enabled (>= 32 chars). */
  readonly secret: string | null;
  /**
   * Versioned keys for encrypting Better Auth browser-session tokens at rest.
   * The first entry is active; remaining entries are decrypt/query-only until
   * every session written under them has expired.
   */
  readonly sessionTokenProtection: Readonly<{
    readonly keys: readonly Readonly<{ readonly version: number; readonly key: Buffer }>[];
    /** Test/rollout-only compatibility window for pre-protection plaintext rows. */
    readonly legacyPlaintextReadUntil: Date | null;
  }> | null;
  /**
   * Exact origins trusted by BA (G1 §9): ALLOWED_ORIGINS plus optional
   * chrome-extension:// IDs from SYNC_EXTENSION_IDS when Better Auth is enabled.
   * Global Product CSRF stays on allowedOrigins. Classification explicitly
   * opts into these Extension origins; do not add them to ALLOWED_ORIGINS.
   */
  readonly trustedOrigins: readonly string[];
  /** Frozen single-cookie name; any other value fails startup (G1 §4). */
  readonly cookieName: '__Host-known_session';
  /** BA sliding session expiry in seconds (default 86_400 = idle TTL 24h, G1 §7 P1). */
  readonly sessionExpiresInSeconds: number;
  /** BA refresh window in seconds; must be < sessionExpiresInSeconds. */
  readonly sessionUpdateAgeSeconds: number;
  /** Email OTP TTL in seconds (default 300, G1 §8). */
  readonly otpTtlSeconds: number;
  /** Email OTP max attempts (default 3, G1 §8). */
  readonly otpMaxAttempts: number;
  /** Body size bound for the BA bridge routes. */
  readonly bodyLimitBytes: number;
  /** Social providers; present only when socialEnabled (partial/missing credentials then fail startup). */
  readonly social: Readonly<{
    readonly google?: BetterAuthSocialProviderConfig;
    readonly github?: BetterAuthSocialProviderConfig;
  }>;
  /**
   * BETTER_AUTH_OAUTH_ISSUER_ENABLED. Requires BETTER_AUTH_ENABLED=true.
   * Production + issuer on is legal; default is false.
   */
  readonly oauthIssuerEnabled: boolean;
  /**
   * Built-in MCP OAuth issuer settings. Non-null only when
   * BETTER_AUTH_OAUTH_ISSUER_ENABLED=true (resource = MCP_OAUTH_AUDIENCE).
   */
  readonly oauthIssuer: BetterAuthOauthIssuerFeatureConfig | null;
}

/** MCP OAuth built-in issuer settings parsed from env (T-04 / ADR P3). */
export interface BetterAuthOauthIssuerFeatureConfig {
  readonly resource: string;
  readonly scopes: readonly string[];
  readonly accessTokenExpiresInSeconds: 3600;
  /** Cross-replica hard cap for anonymous RFC 7591 client registrations. */
  readonly dcrMaxAnonymousClients: number;
  /** Reclaim registrations that never gain authorization evidence after this age. */
  readonly dcrUnusedClientRetentionSeconds: number;
  /** Per-user hard cap for session-owned RFC 7591 client registrations. */
  readonly dcrMaxOwnedClientsPerUser: number;
  /** Cross-replica hard cap for all session/token-owned RFC 7591 clients. */
  readonly dcrMaxOwnedClients: number;
}
