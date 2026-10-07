import type { JSONWebKeySet } from 'jose';
import { loadConfig } from './config.js';
import { createDatabaseRuntime } from '../infrastructure/database/index.js';
import {
  createPostgresSyncSessionHttpApplication,
  createPostgresSyncSessionIssuer,
  createPostgresReplicaRetentionWindowPort,
  createPostgresSyncBootstrapSnapshotApplication,
  createPostgresSyncPushApplication,
  createPostgresSyncConflictResolutionApplication,
  createPostgresSyncPullReadPort,
  createPostgresSyncEffectPageReadPort,
  createPostgresSyncAckApplication,
  createPostgresSyncRecoveryApplication,
  createPostgresReplicaRetirementApplication,
  isJoseSyncCredentialRevoked,
  createSyncRecoveryCapabilityKeyring,
  createSyncPullCursorKeyring,
  createSyncPullCursorLineageKeyring,
  defaultProductionServerBudget,
  defaultServerTransportBudget,
} from '../infrastructure/sync/index.js';
import { createPostgresExtensionIdentityBindingPort } from '../infrastructure/identity/index.js';
import {
  createCompositeExtensionCredentialVerifier,
  createExtensionCredentialEvidenceVerifier,
  createSessionBackedExtensionCredentialVerifier,
  type ExtensionBrowserSessionPort,
  type ExtensionCredentialEvidencePort,
} from '../modules/identity/index.js';
import {
  createSyncServerTelemetry,
  syncDurationBucket,
  type Metrics,
} from '../infrastructure/telemetry/index.js';
import type { EffectPageRateLimiter, SyncColpRateLimiter } from '../infrastructure/rate-limit/index.js';
import type { AttachmentExposurePolicyPort } from '../infrastructure/sync/index.js';
import { createHardenedEgressFetch } from '../infrastructure/egress/index.js';
import type { AuditPayloadColdSource } from '../infrastructure/database/index.js';
import type { ReportSourceInvalidationOutboxPort } from '../infrastructure/outbox/index.js';

export function destroySyncSessionRuntimeKeys(
  pullCursorKeys: { destroy(): void },
  pullLineageKeys: { destroy(): void },
): void {
  try {
    pullCursorKeys.destroy();
  } finally {
    pullLineageKeys.destroy();
  }
}

export function createSyncSessionRuntime(
  database: ReturnType<typeof createDatabaseRuntime>,
  config: NonNullable<ReturnType<typeof loadConfig>['syncSession']>,
  metrics: Metrics,
  snapshotUrl: string | undefined,
  overrides: {
    readonly credentialVerifier?: ExtensionCredentialEvidencePort;
    /**
     * Structured sink for sync telemetry and unexpected push failures. The
     * push route only needs `error`; the telemetry recorder only needs `info`.
     */
    readonly telemetryLogger?: Parameters<typeof createSyncServerTelemetry>[0]['logger']
      & { error(bindings: Record<string, unknown>, message: string): unknown };
    readonly effectPageOrigin?: string;
    readonly pullCursorNow?: () => number;
    /**
     * Better Auth browser session presented as a Bearer cookie value.
     * When set, COLP accepts both JOSE access tokens and session cookies.
     */
    readonly browserSession?: {
      readonly authenticate: ExtensionBrowserSessionPort['authenticate'];
      readonly identityIssuer: string;
    };
    /**
     * P-09: optional Sync COLP push/pull limiter. Production composition
     * injects Redis when SYNC_RATE_LIMIT_SHARED=true, otherwise the memory
     * adapter so the route always uses the port.
     */
    readonly rateLimiter?: SyncColpRateLimiter;
    /**
     * PERIPH-P1-c: optional effect-page limiter. Production composition
     * injects Redis when SYNC_EFFECT_PAGE_RATE_LIMIT_SHARED=true, otherwise
     * the memory adapter.
     */
    readonly effectPageRateLimiter?: EffectPageRateLimiter;
    /**
     * FIX-L-033 (SYNC-R17): the Sync attachment-projection policy port. The
     * composition adapter maps the attachments exposure-eligibility gate onto
     * it; a missing or throwing policy fails closed and the Snapshot
     * attachment projection stays empty.
     */
    readonly attachmentExposure: AttachmentExposurePolicyPort;
    /** Audit historical payload only. Ordinary Pull is hot-history and must not receive this. */
    readonly auditPayloadColdSource?: AuditPayloadColdSource;
    /** Optional report source-fence fan-out for Sync-owned Collection writes. */
    readonly reportSourceInvalidation?: ReportSourceInvalidationOutboxPort;
  },
  /**
   * FIX-M-008: explicit TRUSTED_INGRESS allowlist. Sync route guards accept
   * forwarded TLS evidence only from a socket peer inside this allowlist
   * (empty = peer-only direct TLS).
   */
  trustedIngress: readonly string[],
) {
  if (typeof overrides.attachmentExposure?.assertAttachmentsDenied !== 'function') {
    throw new Error('Sync session runtime requires an attachment exposure policy');
  }
  const jwksFetch = createHardenedEgressFetch({ label: 'Sync OAuth JWKS' });
  const joseVerifier = overrides.credentialVerifier ?? createExtensionCredentialEvidenceVerifier({
    config: config.extensionAuth,
    requiredScopes: ['known.sync'],
    jwks: {
      async getKeySet(): Promise<JSONWebKeySet> {
        const response = await jwksFetch(config.extensionAuth.jwksUri, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) throw new Error('Extension OAuth JWKS unavailable');
        const value: unknown = await response.json();
        if (typeof value !== 'object' || value === null
            || !Array.isArray((value as JSONWebKeySet).keys)) {
          throw new Error('Extension OAuth JWKS is invalid');
        }
        return value as JSONWebKeySet;
      },
    },
    async isRevoked(input) {
      return isJoseSyncCredentialRevoked(database.db, input);
    },
  });
  const credentialVerifier = overrides.browserSession === undefined
    ? joseVerifier
    : createCompositeExtensionCredentialVerifier(
      joseVerifier,
      createSessionBackedExtensionCredentialVerifier({
        config: config.extensionAuth,
        identityIssuer: overrides.browserSession.identityIssuer,
        sessions: { authenticate: overrides.browserSession.authenticate },
        identities: createPostgresExtensionIdentityBindingPort(database.db),
      }),
    );
  const pullCursorKeys = createSyncPullCursorKeyring({
    active: config.pull.cursorKeys.active, retained: config.pull.cursorKeys.retained,
    ttlMs: config.pull.cursorTtlMs, ...(overrides.pullCursorNow ? { now: overrides.pullCursorNow } : {}),
  });
  // FIX-L-035: purpose-separated lineage keyring; retained keys stay verifiable
  // for the lineage retention window independent of cursor key rotation.
  const pullLineageKeys = createSyncPullCursorLineageKeyring({
    active: config.pull.lineageKeys.active, retained: config.pull.lineageKeys.retained,
  });
  const issuer = createPostgresSyncSessionIssuer(database.db, {
    issuer: config.extensionAuth.issuer,
    acceptedIssuers: Object.freeze([...new Set([
      config.extensionAuth.issuer,
      ...(overrides.browserSession === undefined ? [] : [overrides.browserSession.identityIssuer]),
    ])]),
    audience: config.extensionAuth.audience,
    clientId: config.extensionAuth.clientId,
    replayEncryptionKey: config.replayEncryptionKey,
    replayEncryptionKeyVersion: config.replayEncryptionKeyVersion,
    sessionDurationSeconds: config.sessionDurationSeconds,
    replicaLeaseExtensionSeconds: config.replicaLeaseExtensionSeconds,
    tombstoneRetentionSeconds: config.tombstoneRetentionSeconds,
    maxBatchOperations: 1,
    endpointCapabilities: ['syncSnapshot', 'syncPush', 'syncPull', 'syncAck', 'syncConflict'],
    retentionWindow: createPostgresReplicaRetentionWindowPort(snapshotUrl ?? config.snapshot.path),
    pullCursorKeyring: pullCursorKeys,
    recoveryProofRetentionMs: config.pull.recoveryProofRetentionMs,
  });
  const recovery = createPostgresSyncRecoveryApplication(database.db, {
    capabilityKeys: createSyncRecoveryCapabilityKeyring({ active: config.ack.recoveryCapabilityKeys.active,
      retained: config.ack.recoveryCapabilityKeys.retained, ttlMs: config.ack.recoveryCapabilityTtlMs }),
    leaseExtensionSeconds: config.ack.leaseExtensionSeconds,
    maxLeaseLifetimeSeconds: config.ack.maxLeaseLifetimeSeconds,
    pullCursorKeyring: pullCursorKeys,
    recoveryProofRetentionMs: config.pull.recoveryProofRetentionMs,
  });
  const ordinaryAck = createPostgresSyncAckApplication(database.db, {
    leaseExtensionSeconds: config.ack.leaseExtensionSeconds,
    maxLeaseLifetimeSeconds: config.ack.maxLeaseLifetimeSeconds,
  });
  const retirement = createPostgresReplicaRetirementApplication(database.db);
  const recoveryTelemetry = overrides.telemetryLogger
    ? createSyncServerTelemetry({ metrics, logger: overrides.telemetryLogger }) : undefined;
  const effectPageAuthority = overrides.effectPageOrigin;
  const effectPageTemplate = effectPageAuthority
    ? `${effectPageAuthority}${config.pull.effectPagePath}` : undefined;
  return Object.freeze({
    session: Object.freeze({
      path: config.path, credentialVerifier,
      application: createPostgresSyncSessionHttpApplication(database.db, issuer, {
        registerUnknownGenerationOneReplica: true,
        registrationLeaseSeconds: config.replicaLeaseExtensionSeconds,
        serverBudget: defaultProductionServerBudget({
          pullResponseBytes: config.pull.responseBudgetBytes,
          snapshotPageBytes: defaultServerTransportBudget().snapshotPageBytes,
        }),
      }),
      allowedOrigins: config.allowedOrigins, rateLimit: config.rateLimit,
      allowInsecureLoopback: config.allowInsecureLoopback,
      trustedIngress,
    }),
    snapshot: Object.freeze({
      path: config.snapshot.path, credentialVerifier,
      application: createPostgresSyncBootstrapSnapshotApplication(database, {
        cursorSecret: config.snapshot.cursorSecret, cursorKeyId: config.snapshot.cursorKeyId,
        cursorTtlMs: config.snapshot.cursorTtlMs, recovery, pullCursorKeyring: pullCursorKeys,
        recoveryProofRetentionMs: config.pull.recoveryProofRetentionMs,
        attachmentExposure: overrides.attachmentExposure,
        maxSnapshotBytes: config.snapshot.maxBytes,
      }),
      allowedOrigins: config.allowedOrigins, rateLimit: config.snapshot.rateLimit,
      allowInsecureLoopback: config.allowInsecureLoopback,
      trustedIngress,
    }),
    push: Object.freeze({
      path: config.push.path,
      credentialVerifier,
      application: createPostgresSyncPushApplication(database.db, issuer, {
        managedBookmarkWrites: config.push.managedBookmarkWrites,
        tombstoneRetentionSeconds: config.tombstoneRetentionSeconds,
        conflictPayloadEncryption: config.conflictPayloadKeyring.active,
        metrics,
        ...(effectPageAuthority ? { effectPageAuthority } : {}),
        ...(effectPageTemplate ? { effectPageTemplate } : {}),
        ...(overrides.auditPayloadColdSource === undefined
          ? {} : { auditPayloadColdSource: overrides.auditPayloadColdSource }),
        ...(overrides.reportSourceInvalidation === undefined
          ? {} : { reportSourceInvalidation: overrides.reportSourceInvalidation }),
      }),
      allowedOrigins: config.allowedOrigins,
      rateLimit: config.push.rateLimit,
      maxBatchOperations: config.push.maxBatchOperations,
      allowInsecureLoopback: config.allowInsecureLoopback,
      trustedIngress,
      metrics,
      ...(overrides.telemetryLogger === undefined ? {} : { logger: overrides.telemetryLogger }),
      ...(overrides.rateLimiter === undefined ? {} : { rateLimiter: overrides.rateLimiter }),
    }),
    conflict: Object.freeze({
      pathTemplate: config.conflict.path,
      credentialVerifier,
      application: createPostgresSyncConflictResolutionApplication(database.db, issuer, {
        conflictPayloadKeyring: config.conflictPayloadKeyring,
        managedBookmarkWrites: config.push.managedBookmarkWrites,
        ...(effectPageAuthority ? { effectPageAuthority } : {}),
        ...(overrides.reportSourceInvalidation === undefined
          ? {} : { reportSourceInvalidation: overrides.reportSourceInvalidation }),
      }),
      allowedOrigins: config.allowedOrigins,
      rateLimit: config.conflict.rateLimit,
      allowInsecureLoopback: config.allowInsecureLoopback,
      trustedIngress,
    }),
    pull: Object.freeze({
      path: config.pull.path, credentialVerifier,
      reader: createPostgresSyncPullReadPort(database.db, pullCursorKeys,
        { ...(effectPageAuthority ? { effectPageAuthority } : {}),
          ...(effectPageTemplate ? { effectPageTemplate } : {}),
          responseBudgetBytes: config.pull.responseBudgetBytes,
          recoveryProofRetentionMs: config.pull.recoveryProofRetentionMs,
          lineageKeyring: pullLineageKeys,
          lineageRetentionMs: config.pull.lineageRetentionMs,
          ...(overrides.pullCursorNow ? { cursorNow: overrides.pullCursorNow } : {}) }),
      allowedOrigins: config.allowedOrigins, rateLimit: config.pull.rateLimit,
      maxLimit: config.pull.maxLimit, responseBudgetBytes: config.pull.responseBudgetBytes,
      requestTimeoutMs: config.pull.requestTimeoutMs,
      recommendedPullAfterSeconds: config.pull.recommendedPullAfterSeconds,
      ...(snapshotUrl ? { snapshotUrl } : {}),
      allowInsecureLoopback: config.allowInsecureLoopback,
      trustedIngress,
      ...(overrides.rateLimiter === undefined ? {} : { rateLimiter: overrides.rateLimiter }),
    }),
    effectPages: Object.freeze({
      pathTemplate: config.pull.effectPagePath, credentialVerifier,
      reader: createPostgresSyncEffectPageReadPort(database.db),
      allowedOrigins: config.allowedOrigins,
      rateLimit: config.pull.effectPageRateLimit,
      responseBudgetBytes: 262_144,
      allowInsecureLoopback: config.allowInsecureLoopback,
      trustedIngress,
      ...(overrides.effectPageRateLimiter === undefined ? {} : { rateLimiter: overrides.effectPageRateLimiter }),
    }),
    ack: Object.freeze({
      path: config.ack.path, credentialVerifier,
      application: Object.freeze({ async acknowledge(input: Parameters<typeof ordinaryAck.acknowledge>[0]) {
        // FIX-M-012: recovery Acks are routed by the explicit recoveryCapability protocol field.
        // Legacy 0.1 clients negotiated the old contract and still carry the capability in cursor;
        // the current wire semantics never depend on the src1 prefix.
        if (input.request.recoveryCapability === undefined && !input.request.cursor.startsWith('src1.')) {
          return ordinaryAck.acknowledge(input);
        }
        const started = performance.now();
        try {
          const result = await recovery.acknowledge(input);
          const durationMs = Math.max(0, performance.now() - started);
          recoveryTelemetry?.record({ endpoint: 'recovery', outcome: 'success', problem: 'none',
            bucket: syncDurationBucket(durationMs), durationMs });
          return result;
        } catch (error) {
          const durationMs = Math.max(0, performance.now() - started);
          recoveryTelemetry?.record({ endpoint: 'recovery', outcome: 'problem',
            problem: 'recovery_required', bucket: syncDurationBucket(durationMs), durationMs });
          throw error;
        }
      } }),
      allowedOrigins: config.allowedOrigins, rateLimit: config.ack.rateLimit,
      maxBodyBytes: config.ack.maxBodyBytes, maxWarnings: config.ack.maxWarnings,
      maxWarningBytes: config.ack.maxWarningBytes,
      allowInsecureLoopback: config.allowInsecureLoopback,
      trustedIngress,
    }),
    retire: Object.freeze({
      path: config.retire.path,
      credentialVerifier,
      application: retirement,
      allowedOrigins: config.allowedOrigins,
      rateLimit: config.retire.rateLimit,
      allowInsecureLoopback: config.allowInsecureLoopback,
      trustedIngress,
    }),
    destroy: () => {
      destroySyncSessionRuntimeKeys(pullCursorKeys, pullLineageKeys);
    },
  });
}
