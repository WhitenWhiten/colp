import { parseExtensionAuthConfig } from '../modules/identity/index.js';
import { REPLICA_LEASE_BOUNDS, TOMBSTONE_RETENTION_BOUNDS } from '../infrastructure/sync/index.js';
import {
  parsePositiveInt,
  requireNonEmpty,
  DEV_EDITOR_CURSOR_KEY,
  DEV_PUBLICATION_CURSOR_SECRET,
} from './config-parse-helpers.js';
import { assertOidcEndpointUrl } from './oidc-endpoint-policy.js';
import type {
  SyncEvidenceMaintenanceConfig,
  SyncSessionConfig,
  SyncTombstonePurgeConfig,
} from './config-types.js';

export function loadSyncSessionConfig(env: NodeJS.ProcessEnv): SyncSessionConfig | undefined {
  const enabled = (env.SYNC_SESSION_ENABLED ?? 'false').toLowerCase();
  if (enabled !== 'true' && enabled !== 'false') {
    throw new Error('SYNC_SESSION_ENABLED must be true or false');
  }
  if (enabled === 'false') return undefined;
  const extensionIds = requireNonEmpty(env, 'SYNC_EXTENSION_IDS').split(',').map((item) => item.trim());
  const allowedOrigins = Object.freeze(extensionIds.map((id) => `chrome-extension://${id}`));
  const issuer = requireNonEmpty(env, 'SYNC_OAUTH_ISSUER');
  const clientId = requireNonEmpty(env, 'SYNC_OAUTH_CLIENT_ID');
  const jwksUri = requireNonEmpty(env, 'SYNC_OAUTH_JWKS_URI');
  // Self-hosted points the JWKS at its own origin, which may be loopback or a
  // LAN name (config-auth.ts relaxes OIDC_* the same way).
  assertOidcEndpointUrl(
    'SYNC_OAUTH_JWKS_URI',
    jwksUri,
    env.KNOWN_EDITION === 'self-hosted' || (env.NODE_ENV ?? 'development') !== 'production'
      ? 'relaxed'
      : 'strict',
  );
  const extensionAuth = parseExtensionAuthConfig({
    issuer,
    clientId,
    audience: requireNonEmpty(env, 'SYNC_OAUTH_AUDIENCE'),
    authorizationEndpoint: requireNonEmpty(env, 'SYNC_OAUTH_AUTHORIZATION_ENDPOINT'),
    tokenEndpoint: requireNonEmpty(env, 'SYNC_OAUTH_TOKEN_ENDPOINT'),
    jwksUri,
    redirectUri: requireNonEmpty(env, 'SYNC_OAUTH_REDIRECT_URI'),
    extensionIds,
    redirectOrigins: extensionIds.map((id) => `https://${id}.chromiumapp.org`),
    scopes: (env.SYNC_OAUTH_SCOPES ?? 'openid known.sync').split(/\s+/u).filter(Boolean),
    algorithms: (env.SYNC_OAUTH_ALGORITHMS ?? 'RS256').split(',').map((item) => item.trim()),
    clockSkewSeconds: parsePositiveInt(env.SYNC_OAUTH_CLOCK_SKEW_SECONDS, 30,
      'SYNC_OAUTH_CLOCK_SKEW_SECONDS', { max: 300 }),
    evidenceTtlSeconds: parsePositiveInt(env.SYNC_OAUTH_EVIDENCE_TTL_SECONDS, 30,
      'SYNC_OAUTH_EVIDENCE_TTL_SECONDS', { max: 60 }),
  }, {
    // Same rule as the product origin (config.ts): loopback http outside
    // production, or in production with COLP_INSECURE_HTTP (D26).
    allowLoopbackHttp: env.COLP_INSECURE_HTTP === 'true' || (env.NODE_ENV ?? 'development') !== 'production',
  });
  const encodedReplayKey = requireNonEmpty(env, 'SYNC_SESSION_REPLAY_KEY');
  if (!/^(?:[A-Za-z0-9+/]{4}){10}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)$/u.test(encodedReplayKey)) {
    throw new Error('SYNC_SESSION_REPLAY_KEY must be canonical base64');
  }
  const replayEncryptionKey = Buffer.from(encodedReplayKey, 'base64');
  if (replayEncryptionKey.length !== 32) throw new Error('SYNC_SESSION_REPLAY_KEY must decode to 32 bytes');
  const replayEncryptionKeyVersion = parsePositiveInt(env.SYNC_SESSION_REPLAY_KEY_VERSION, 1,
    'SYNC_SESSION_REPLAY_KEY_VERSION', { max: 2_147_483_647 });
  const conflictRetainedKeys = parseSyncConflictRetainedKeys(env.SYNC_CONFLICT_RETAINED_KEYS?.trim() ?? '');
  for (const [index, key] of conflictRetainedKeys.entries()) {
    if (key.keyVersion === replayEncryptionKeyVersion) {
      throw new Error(`SYNC_CONFLICT_RETAINED_KEYS[${index}] must not reuse the active key version`);
    }
    if (key.key.toString('base64') === encodedReplayKey) {
      throw new Error(`SYNC_CONFLICT_RETAINED_KEYS[${index}] must not reuse the active key material`);
    }
  }
  const apiInstanceCount = parsePositiveInt(env.SYNC_API_INSTANCE_COUNT, 1,
    'SYNC_API_INSTANCE_COUNT', { max: 1 });
  const path = env.SYNC_SESSION_PATH?.trim() || '/colp/v0.1/sync/sessions';
  if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/u.test(path)) {
    throw new Error('SYNC_SESSION_PATH must be a static absolute path');
  }
  const snapshotPath = env.SYNC_SNAPSHOT_PATH?.trim() || '/colp/v0.1/sync/snapshot';
  if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/u.test(snapshotPath) || snapshotPath === path) {
    throw new Error('SYNC_SNAPSHOT_PATH must be a distinct static absolute path');
  }
  const pushPath = env.SYNC_PUSH_PATH?.trim() || '/colp/v0.1/sync/push';
  if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/u.test(pushPath)
      || pushPath === path || pushPath === snapshotPath) {
    throw new Error('SYNC_PUSH_PATH must be a distinct static absolute path');
  }
  const conflictPath = env.SYNC_CONFLICT_PATH?.trim()
    || '/colp/v0.1/sync/conflicts/{conflictId}/resolve';
  if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*\{conflictId\}[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/u.test(conflictPath)
      || conflictPath.replace('{conflictId}', 'value') === path
      || conflictPath.replace('{conflictId}', 'value') === snapshotPath
      || conflictPath.replace('{conflictId}', 'value') === pushPath) {
    throw new Error('SYNC_CONFLICT_PATH must be a distinct path with exactly {conflictId}');
  }
  const maxBatchOperations = parsePositiveInt(env.SYNC_MAX_BATCH_OPERATIONS, 1,
    'SYNC_MAX_BATCH_OPERATIONS', { max: 1 });
  const managedBookmarkWritesValue = (env.SYNC_MANAGED_BOOKMARK_WRITES ?? 'false').toLowerCase();
  if (managedBookmarkWritesValue !== 'true' && managedBookmarkWritesValue !== 'false') {
    throw new Error('SYNC_MANAGED_BOOKMARK_WRITES must be true or false');
  }
  const encodedSnapshotKey = requireNonEmpty(env, 'SYNC_SNAPSHOT_CURSOR_KEY');
  if (!/^(?:[A-Za-z0-9+/]{4}){10}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)$/u.test(encodedSnapshotKey)) throw new Error('SYNC_SNAPSHOT_CURSOR_KEY must be canonical base64');
  const snapshotCursorSecret = Buffer.from(encodedSnapshotKey, 'base64');
  if (snapshotCursorSecret.length !== 32) throw new Error('SYNC_SNAPSHOT_CURSOR_KEY must decode to 32 bytes');
  const snapshotCursorKeyId = requireNonEmpty(env, 'SYNC_SNAPSHOT_CURSOR_KEY_ID');
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(snapshotCursorKeyId)) throw new Error('SYNC_SNAPSHOT_CURSOR_KEY_ID must be URL-safe');
  const pullPath = env.SYNC_PULL_PATH?.trim() || '/colp/v0.1/sync/pull';
  if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/u.test(pullPath)
      || [path, snapshotPath, pushPath].includes(pullPath)
      || conflictPath.replace('{conflictId}', 'value') === pullPath) {
    throw new Error('SYNC_PULL_PATH must be a distinct static absolute path');
  }
  const effectPagePath = env.SYNC_EFFECT_PAGE_PATH?.trim()
    || '/colp/v0.1/sync/effects/{effectId}/pages/{pageNumber}';
  if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*\{effectId\}[A-Za-z0-9._~!$&'()*+,;=:@%/-]*\{pageNumber\}$/u.test(effectPagePath)) {
    throw new Error('SYNC_EFFECT_PAGE_PATH must contain {effectId} and {pageNumber}');
  }
  const pullCursorKeyId = requireNonEmpty(env, 'SYNC_PULL_CURSOR_KEY_ID');
  const pullCursorSecret = requireNonEmpty(env, 'SYNC_PULL_CURSOR_KEY');
  const pullRetainedKeys = parseSyncPullRetainedKeys(env.SYNC_PULL_CURSOR_KEYS?.trim() ?? '');
  const pullKeys = [{ id: pullCursorKeyId, secret: pullCursorSecret }, ...pullRetainedKeys];
  for (const [index, key] of pullKeys.entries()) {
    const bytes = Buffer.from(key.secret, 'base64');
    const canonical = bytes.length >= 32 && bytes.toString('base64') === key.secret;
    bytes.fill(0);
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(key.id) || !canonical) {
      throw new Error(`SYNC_PULL_CURSOR_KEY${index === 0 ? '' : 'S'} has invalid key material`);
    }
  }
  if (new Set(pullKeys.map((key) => key.id)).size !== pullKeys.length
      || new Set(pullKeys.map((key) => key.secret)).size !== pullKeys.length) {
    throw new Error('SYNC_PULL cursor key ids and material must be unique');
  }
  const forbiddenCursorSecrets = [encodedSnapshotKey, replayEncryptionKey.toString('base64'),
    env.PUBLICATION_CURSOR_ACTIVE_SECRET ?? DEV_PUBLICATION_CURSOR_SECRET,
    env.PRODUCT_EDITOR_CURSOR_HMAC_KEY ?? DEV_EDITOR_CURSOR_KEY];
  if (pullKeys.some((key) => forbiddenCursorSecrets.includes(key.secret))) {
    throw new Error('SYNC_PULL cursor keys must be independent from publication, editor, snapshot, and replay keys');
  }
  const ackPath = env.SYNC_ACK_PATH?.trim() || '/colp/v0.1/sync/ack';
  if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/u.test(ackPath)
      || [path, snapshotPath, pushPath, pullPath].includes(ackPath)
      || conflictPath.replace('{conflictId}', 'value') === ackPath) {
    throw new Error('SYNC_ACK_PATH must be a distinct static absolute path');
  }
  const retirePath = env.SYNC_RETIRE_PATH?.trim() || '/colp/v0.1/sync/replica';
  if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/u.test(retirePath)
      || [path, snapshotPath, pushPath, pullPath, ackPath].includes(retirePath)
      || conflictPath.replace('{conflictId}', 'value') === retirePath) {
    throw new Error('SYNC_RETIRE_PATH must be a distinct static absolute path');
  }
  const recoveryKeyId = requireNonEmpty(env, 'SYNC_RECOVERY_CAPABILITY_KEY_ID');
  const recoverySecret = requireNonEmpty(env, 'SYNC_RECOVERY_CAPABILITY_KEY');
  const recoveryRetained = parseSyncPullRetainedKeys(env.SYNC_RECOVERY_CAPABILITY_KEYS?.trim() ?? '');
  const recoveryKeys = [{ id: recoveryKeyId, secret: recoverySecret }, ...recoveryRetained];
  for (const key of recoveryKeys) {
    const bytes = Buffer.from(key.secret, 'base64');
    const canonical = bytes.length >= 32 && bytes.toString('base64') === key.secret;
    bytes.fill(0);
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(key.id) || /(?:sync[-_]?pull|publication|editor|snapshot)/iu.test(key.id)
        || !canonical) throw new Error('SYNC_RECOVERY_CAPABILITY keys have invalid or cross-purpose material');
  }
  if (new Set(recoveryKeys.map((key) => key.id)).size !== recoveryKeys.length
      || new Set(recoveryKeys.map((key) => key.secret)).size !== recoveryKeys.length
      || recoveryKeys.some((key) => [...forbiddenCursorSecrets, ...pullKeys.map((item) => item.secret)]
        .includes(key.secret))) throw new Error('SYNC_RECOVERY_CAPABILITY keys must be unique and independent');
  const lineageKeyId = requireNonEmpty(env, 'SYNC_PULL_LINEAGE_KEY_ID');
  const lineageSecret = requireNonEmpty(env, 'SYNC_PULL_LINEAGE_KEY');
  const lineageRetainedKeys = parseSyncPullRetainedKeys(env.SYNC_PULL_LINEAGE_KEYS?.trim() ?? '');
  const lineageKeys = [{ id: lineageKeyId, secret: lineageSecret }, ...lineageRetainedKeys];
  for (const [index, key] of lineageKeys.entries()) {
    const bytes = Buffer.from(key.secret, 'base64');
    const canonical = bytes.length >= 32 && bytes.toString('base64') === key.secret;
    bytes.fill(0);
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(key.id) || /(?:recovery|publication|editor|snapshot)/iu.test(key.id)
        || !canonical) throw new Error(`SYNC_PULL_LINEAGE_KEY${index === 0 ? '' : 'S'} has invalid or cross-purpose key material`);
  }
  if (new Set(lineageKeys.map((key) => key.id)).size !== lineageKeys.length
      || new Set(lineageKeys.map((key) => key.secret)).size !== lineageKeys.length
      || lineageKeys.some((key) => [...forbiddenCursorSecrets, ...pullKeys.map((item) => item.secret),
        ...recoveryKeys.map((item) => item.secret)].includes(key.secret))) {
    throw new Error('SYNC_PULL_LINEAGE keys must be unique and independent');
  }
  const sessionDurationSeconds = parsePositiveInt(env.SYNC_SESSION_DURATION_SECONDS, 900,
    'SYNC_SESSION_DURATION_SECONDS', { max: 86_400 });
  const pullCursorTtlMs = parsePositiveInt(env.SYNC_PULL_CURSOR_TTL_MS, 900_000,
    'SYNC_PULL_CURSOR_TTL_MS', { max: 86_400_000 });
  const recoveryProofRetentionMs = parsePositiveInt(env.SYNC_PULL_RECOVERY_PROOF_RETENTION_MS,
    2_592_000_000, 'SYNC_PULL_RECOVERY_PROOF_RETENTION_MS', { max: 31_536_000_000 });
  if (recoveryProofRetentionMs < pullCursorTtlMs + sessionDurationSeconds * 1_000) {
    throw new Error('SYNC_PULL_RECOVERY_PROOF_RETENTION_MS must cover cursor TTL plus one Session handoff window');
  }
  const lineageRetentionMs = parsePositiveInt(env.SYNC_PULL_LINEAGE_RETENTION_MS,
    31_536_000_000, 'SYNC_PULL_LINEAGE_RETENTION_MS', { max: 126_144_000_000 });
  if (lineageRetentionMs < recoveryProofRetentionMs + pullCursorTtlMs + sessionDurationSeconds * 1_000) {
    throw new Error('SYNC_PULL_LINEAGE_RETENTION_MS must cover recovery proof retention plus cursor TTL and one Session handoff window');
  }
  return Object.freeze({
    path,
    allowedOrigins,
    extensionAuth,
    replayEncryptionKey,
    replayEncryptionKeyVersion,
    conflictPayloadKeyring: Object.freeze({
      active: Object.freeze({ key: replayEncryptionKey, keyVersion: replayEncryptionKeyVersion }),
      retained: conflictRetainedKeys,
    }),
    sessionDurationSeconds,
    replicaLeaseExtensionSeconds: parsePositiveInt(env.SYNC_REPLICA_LEASE_EXTENSION_SECONDS, 86_400,
      'SYNC_REPLICA_LEASE_EXTENSION_SECONDS',
      { min: REPLICA_LEASE_BOUNDS.minSeconds, max: REPLICA_LEASE_BOUNDS.maxSeconds }),
    tombstoneRetentionSeconds: parsePositiveInt(env.SYNC_TOMBSTONE_RETENTION_SECONDS,
      TOMBSTONE_RETENTION_BOUNDS.minSeconds, 'SYNC_TOMBSTONE_RETENTION_SECONDS',
      { min: TOMBSTONE_RETENTION_BOUNDS.minSeconds }),
    rateLimit: Object.freeze({
      maxRequests: parsePositiveInt(env.SYNC_SESSION_RATE_LIMIT_MAX, 20,
        'SYNC_SESSION_RATE_LIMIT_MAX', { max: 10_000 }),
      windowMs: parsePositiveInt(env.SYNC_SESSION_RATE_LIMIT_WINDOW_MS, 60_000,
        'SYNC_SESSION_RATE_LIMIT_WINDOW_MS', { max: 3_600_000 }),
    }),
    apiInstanceCount: apiInstanceCount as 1,
    allowInsecureLoopback: (env.NODE_ENV ?? 'development') !== 'production',
    snapshot: Object.freeze({
      path: snapshotPath,
      cursorKeyId: snapshotCursorKeyId,
      cursorSecret: snapshotCursorSecret,
      cursorTtlMs: parsePositiveInt(env.SYNC_SNAPSHOT_CURSOR_TTL_MS, 900_000, 'SYNC_SNAPSHOT_CURSOR_TTL_MS', { max: 3_600_000 }),
      maxBytes: parsePositiveInt(env.SYNC_SNAPSHOT_MAX_BYTES, 2_097_152, 'SYNC_SNAPSHOT_MAX_BYTES', { max: 16_777_216 }),
      rateLimit: Object.freeze({
        maxRequests: parsePositiveInt(env.SYNC_SNAPSHOT_RATE_LIMIT_MAX, 120, 'SYNC_SNAPSHOT_RATE_LIMIT_MAX', { max: 10_000 }),
        windowMs: parsePositiveInt(env.SYNC_SNAPSHOT_RATE_LIMIT_WINDOW_MS, 60_000, 'SYNC_SNAPSHOT_RATE_LIMIT_WINDOW_MS', { max: 3_600_000 }),
      }),
    }),
    push: Object.freeze({
      path: pushPath,
      maxBatchOperations: maxBatchOperations as 1,
      managedBookmarkWrites: managedBookmarkWritesValue === 'true',
      rateLimit: Object.freeze({
        maxRequests: parsePositiveInt(env.SYNC_PUSH_RATE_LIMIT_MAX, 120,
          'SYNC_PUSH_RATE_LIMIT_MAX', { max: 10_000 }),
        windowMs: parsePositiveInt(env.SYNC_PUSH_RATE_LIMIT_WINDOW_MS, 60_000,
          'SYNC_PUSH_RATE_LIMIT_WINDOW_MS', { max: 3_600_000 }),
      }),
    }),
    conflict: Object.freeze({
      path: conflictPath,
      rateLimit: Object.freeze({
        maxRequests: parsePositiveInt(env.SYNC_CONFLICT_RATE_LIMIT_MAX, 60,
          'SYNC_CONFLICT_RATE_LIMIT_MAX', { max: 10_000 }),
        windowMs: parsePositiveInt(env.SYNC_CONFLICT_RATE_LIMIT_WINDOW_MS, 60_000,
          'SYNC_CONFLICT_RATE_LIMIT_WINDOW_MS', { max: 3_600_000 }),
      }),
    }),
    pull: Object.freeze({
      path: pullPath,
      effectPagePath,
      cursorKeys: Object.freeze({ active: Object.freeze({ id: pullCursorKeyId, secret: pullCursorSecret }),
        retained: pullRetainedKeys }),
      cursorTtlMs: pullCursorTtlMs,
      recoveryProofRetentionMs,
      lineageKeys: Object.freeze({ active: Object.freeze({ id: lineageKeyId, secret: lineageSecret }),
        retained: lineageRetainedKeys }),
      lineageRetentionMs,
      maxLimit: parsePositiveInt(env.SYNC_PULL_MAX_LIMIT, 200, 'SYNC_PULL_MAX_LIMIT', { max: 1_000 }),
      responseBudgetBytes: parsePositiveInt(env.SYNC_PULL_RESPONSE_BUDGET_BYTES, 524_288,
        'SYNC_PULL_RESPONSE_BUDGET_BYTES', { max: 16_777_216 }),
      requestTimeoutMs: parsePositiveInt(env.SYNC_PULL_REQUEST_TIMEOUT_MS, 15_000,
        'SYNC_PULL_REQUEST_TIMEOUT_MS', { max: 600_000 }),
      recommendedPullAfterSeconds: parsePositiveInt(env.SYNC_PULL_RECOMMENDED_AFTER_SECONDS, 30,
        'SYNC_PULL_RECOMMENDED_AFTER_SECONDS', { allowZero: true, max: 86_400 }),
      rateLimit: Object.freeze({
        maxRequests: parsePositiveInt(env.SYNC_PULL_RATE_LIMIT_MAX, 240,
          'SYNC_PULL_RATE_LIMIT_MAX', { max: 10_000 }),
        windowMs: parsePositiveInt(env.SYNC_PULL_RATE_LIMIT_WINDOW_MS, 60_000,
          'SYNC_PULL_RATE_LIMIT_WINDOW_MS', { max: 3_600_000 }),
      }),
      effectPageRateLimit: Object.freeze({
        subjectMaxRequests: parsePositiveInt(env.SYNC_EFFECT_PAGE_RATE_LIMIT_MAX, 240,
          'SYNC_EFFECT_PAGE_RATE_LIMIT_MAX', { max: 10_000 }),
        effectMaxRequests: parsePositiveInt(env.SYNC_EFFECT_PAGE_RATE_LIMIT_EFFECT_MAX, 120,
          'SYNC_EFFECT_PAGE_RATE_LIMIT_EFFECT_MAX', { min: 20, max: 10_000 }),
        ipMaxRequests: parsePositiveInt(env.SYNC_EFFECT_PAGE_RATE_LIMIT_IP_MAX, 480,
          'SYNC_EFFECT_PAGE_RATE_LIMIT_IP_MAX', { min: 20, max: 10_000 }),
        windowMs: parsePositiveInt(env.SYNC_EFFECT_PAGE_RATE_LIMIT_WINDOW_MS, 60_000,
          'SYNC_EFFECT_PAGE_RATE_LIMIT_WINDOW_MS', { max: 3_600_000 }),
      }),
    }),
    ack: Object.freeze({
      path: ackPath,
      leaseExtensionSeconds: parsePositiveInt(env.SYNC_ACK_LEASE_EXTENSION_SECONDS, 86_400,
        'SYNC_ACK_LEASE_EXTENSION_SECONDS', { max: 2_592_000 }),
      maxLeaseLifetimeSeconds: parsePositiveInt(env.SYNC_ACK_MAX_LEASE_LIFETIME_SECONDS, 2_592_000,
        'SYNC_ACK_MAX_LEASE_LIFETIME_SECONDS', { max: 31_536_000 }),
      maxBodyBytes: parsePositiveInt(env.SYNC_ACK_MAX_BODY_BYTES, 16_384,
        'SYNC_ACK_MAX_BODY_BYTES', { max: 1_048_576 }),
      maxWarnings: parsePositiveInt(env.SYNC_ACK_MAX_WARNINGS, 8, 'SYNC_ACK_MAX_WARNINGS', { max: 128 }),
      maxWarningBytes: parsePositiveInt(env.SYNC_ACK_MAX_WARNING_BYTES, 2_048,
        'SYNC_ACK_MAX_WARNING_BYTES', { max: 65_536 }),
      rateLimit: Object.freeze({
        maxRequests: parsePositiveInt(env.SYNC_ACK_RATE_LIMIT_MAX, 120,
          'SYNC_ACK_RATE_LIMIT_MAX', { max: 10_000 }),
        windowMs: parsePositiveInt(env.SYNC_ACK_RATE_LIMIT_WINDOW_MS, 60_000,
          'SYNC_ACK_RATE_LIMIT_WINDOW_MS', { max: 3_600_000 }),
      }),
      recoveryCapabilityKeys: Object.freeze({ active: Object.freeze({ id: recoveryKeyId,
        secret: recoverySecret }), retained: Object.freeze(recoveryRetained) }),
      recoveryCapabilityTtlMs: parsePositiveInt(env.SYNC_RECOVERY_CAPABILITY_TTL_MS, 300_000,
        'SYNC_RECOVERY_CAPABILITY_TTL_MS', { max: 3_600_000 }),
    }),
    retire: Object.freeze({
      path: retirePath,
      rateLimit: Object.freeze({
        maxRequests: parsePositiveInt(env.SYNC_RETIRE_RATE_LIMIT_MAX, 20,
          'SYNC_RETIRE_RATE_LIMIT_MAX', { max: 10_000 }),
        windowMs: parsePositiveInt(env.SYNC_RETIRE_RATE_LIMIT_WINDOW_MS, 60_000,
          'SYNC_RETIRE_RATE_LIMIT_WINDOW_MS', { max: 3_600_000 }),
      }),
    }),
  });
}

export function parseSyncConflictRetainedKeys(raw: string): readonly { readonly key: Buffer; readonly keyVersion: number }[] {
  if (!raw) return Object.freeze([]);
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('SYNC_CONFLICT_RETAINED_KEYS must be a JSON array'); }
  if (!Array.isArray(value) || value.length > 8) {
    throw new Error('SYNC_CONFLICT_RETAINED_KEYS must be a JSON array with at most 8 entries');
  }
  const parsed = Object.freeze(value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`SYNC_CONFLICT_RETAINED_KEYS[${index}] must be an object`);
    }
    const record = item as Record<string, unknown>;
    if (Object.keys(record).sort().join('\0') !== 'key\0keyVersion'
        || typeof record.key !== 'string' || !Number.isSafeInteger(record.keyVersion)) {
      throw new Error(`SYNC_CONFLICT_RETAINED_KEYS[${index}] must contain only key and keyVersion`);
    }
    const bytes = Buffer.from(record.key, 'base64');
    const canonical = bytes.length === 32 && bytes.toString('base64') === record.key;
    bytes.fill(0);
    if (!canonical) {
      throw new Error(`SYNC_CONFLICT_RETAINED_KEYS[${index}] key must be canonical base64 and decode to 32 bytes`);
    }
    const keyVersion = record.keyVersion as number;
    if (keyVersion < 1 || keyVersion > 2_147_483_647) {
      throw new Error(`SYNC_CONFLICT_RETAINED_KEYS[${index}] keyVersion must be a positive integer`);
    }
    return Object.freeze({ key: Buffer.from(record.key, 'base64'), keyVersion });
  }));
  const versions = parsed.map((key) => key.keyVersion);
  if (new Set(versions).size !== versions.length) {
    throw new Error('SYNC_CONFLICT_RETAINED_KEYS key versions must be unique');
  }
  const material = parsed.map((key) => key.key.toString('base64'));
  if (new Set(material).size !== material.length) {
    throw new Error('SYNC_CONFLICT_RETAINED_KEYS key material must be unique');
  }
  return parsed;
}

export function parseSyncPullRetainedKeys(raw: string): readonly { readonly id: string; readonly secret: string }[] {
  if (!raw) return Object.freeze([]);
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('SYNC_PULL_CURSOR_KEYS must be a JSON array'); }
  if (!Array.isArray(value) || value.length > 8) throw new Error('SYNC_PULL_CURSOR_KEYS must be a JSON array with at most 8 entries');
  return Object.freeze(value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`SYNC_PULL_CURSOR_KEYS[${index}] must be an object`);
    const record = item as Record<string, unknown>;
    if (Object.keys(record).sort().join('\0') !== 'id\0secret'
        || typeof record.id !== 'string' || typeof record.secret !== 'string') {
      throw new Error(`SYNC_PULL_CURSOR_KEYS[${index}] must contain only id and secret`);
    }
    return Object.freeze({ id: record.id, secret: record.secret });
  }));
}

export function loadSyncTombstonePurgeConfig(env: NodeJS.ProcessEnv): SyncTombstonePurgeConfig {
  const purgeEnabled = (env.SYNC_TOMBSTONE_PURGE_ENABLED ?? 'false').toLowerCase();
  if (purgeEnabled !== 'true' && purgeEnabled !== 'false') {
    throw new Error('SYNC_TOMBSTONE_PURGE_ENABLED must be true or false');
  }
  return Object.freeze({
    enabled: purgeEnabled === 'true',
    intervalMs: parsePositiveInt(env.SYNC_TOMBSTONE_PURGE_INTERVAL_MS, 60_000,
      'SYNC_TOMBSTONE_PURGE_INTERVAL_MS', { max: 3_600_000 }),
    batchSize: parsePositiveInt(env.SYNC_TOMBSTONE_PURGE_BATCH_SIZE, 20_000,
      'SYNC_TOMBSTONE_PURGE_BATCH_SIZE', { max: 20_000 }),
    leaseDurationMs: parsePositiveInt(env.SYNC_TOMBSTONE_PURGE_LEASE_DURATION_MS, 30_000,
      'SYNC_TOMBSTONE_PURGE_LEASE_DURATION_MS', { max: 600_000 }),
  });
}

export function loadSyncEvidenceMaintenanceConfig(env: NodeJS.ProcessEnv): SyncEvidenceMaintenanceConfig {
  // R15 global evidence/proof maintenance worker. Disabled by default so existing
  // deployments keep the R14 Pull-local opportunistic cleanup behavior unchanged;
  // enabling it adds the standalone global sweep as the primary mechanism.
  const evidenceMaintenanceEnabled = (env.SYNC_EVIDENCE_MAINTENANCE_ENABLED ?? 'false').toLowerCase();
  if (evidenceMaintenanceEnabled !== 'true' && evidenceMaintenanceEnabled !== 'false') {
    throw new Error('SYNC_EVIDENCE_MAINTENANCE_ENABLED must be true or false');
  }
  return Object.freeze({
    enabled: evidenceMaintenanceEnabled === 'true',
    intervalMs: parsePositiveInt(env.SYNC_EVIDENCE_MAINTENANCE_INTERVAL_MS, 60_000,
      'SYNC_EVIDENCE_MAINTENANCE_INTERVAL_MS', { max: 3_600_000 }),
    batchSize: parsePositiveInt(env.SYNC_EVIDENCE_MAINTENANCE_BATCH_SIZE, 500,
      'SYNC_EVIDENCE_MAINTENANCE_BATCH_SIZE', { max: 20_000 }),
    leaseDurationMs: parsePositiveInt(env.SYNC_EVIDENCE_MAINTENANCE_LEASE_DURATION_MS, 30_000,
      'SYNC_EVIDENCE_MAINTENANCE_LEASE_DURATION_MS', { max: 600_000 }),
  });
}
