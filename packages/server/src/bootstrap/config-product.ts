import {
  PRODUCT_EDITOR_CURSOR_MAX_PREVIOUS_KEYS,
  DEFAULT_ORGANIZE_PLANNER_ID,
  isHeuristicPlannerId,
} from '../modules/collections/index.js';
import {
  parseCanonicalUtcTimestamp,
  requireNonEmpty,
  parsePositiveInt,
  DEV_EDITOR_CURSOR_KEY,
} from './config-parse-helpers.js';
import type {
  ClassifyInboxFeatureConfig,
  CollectionHistoryFeatureConfig,
  ExportJobsFeatureConfig,
  ExportR2Config,
  LinkHealthFeatureConfig,
  OrganizePlansFeatureConfig,
  ReadableReplicaFeatureConfig,
  ProductEditorCursorConfig,
  ProductOwnedCollectionsCursorConfig,
} from './config-types.js';

export const DEFAULT_AVATAR_R2_PREFIX = 'avatar/';
export const DEFAULT_FAVICON_R2_PREFIX = 'favicon/';
export const DEFAULT_ATTACHMENTS_LIVE_PREFIX = 'attachments/live/';
export const DEFAULT_ATTACHMENTS_PROBE_PREFIX = 'attachments/probe/';

const PRODUCT_EDITOR_CURSOR_TTL_MS = 15 * 60 * 1000;
const DEV_EDITOR_CURSOR_KEY_ID = 'dev-editor-v1';
const DEV_OWNED_COLLECTIONS_CURSOR_KEY = 'dev-owned-collections-cursor-hmac-key-change-me';
const DEV_OWNED_COLLECTIONS_CURSOR_KEY_ID = 'dev-owned-collections-v1';
const DEV_LINK_HEALTH_CURSOR_KEY = 'dev-link-health-cursor-hmac-key-change-me';
const DEV_LINK_HEALTH_CURSOR_KEY_ID = 'dev-link-health-v1';
const DEV_CLASSIFY_INBOX_CURSOR_KEY = 'dev-classify-inbox-cursor-hmac-key-change-me';
const DEV_CLASSIFY_INBOX_CURSOR_KEY_ID = 'dev-classify-inbox-v1';
const DEV_COLLECTION_VERSIONS_CURSOR_KEY = 'dev-collection-versions-cursor-hmac-key-change-me';
const DEV_COLLECTION_VERSIONS_CURSOR_KEY_ID = 'dev-collection-versions-v1';

/**
 * Bootstrap-time guard: object prefixes (avatar, favicon, attachments live,
 * attachments probe, export, and link preview when given) must never overlap. Any pair that is equal or in
 * a bidirectional string-prefix relation is rejected. Empty string is a prefix
 * of every key.
 *
 * Identity's three-argument assertAvatarPrefixesDoNotOverlap stays as
 * defense-in-depth and is never taught about favicon or export; favicon vs
 * avatar vs export is covered here.
 */
export function assertPublicObjectPrefixesDoNotOverlap(
  avatarPrefix: string,
  faviconPrefix: string,
  livePrefix: string,
  probePrefix: string,
  exportPrefix: string,
  linkPreviewPrefix?: string,
): void {
  const overlaps = (left: string, right: string): boolean =>
    left === right || left.startsWith(right) || right.startsWith(left);
  const labeled: ReadonlyArray<{ readonly name: string; readonly prefix: string }> = [
    { name: 'avatar', prefix: avatarPrefix },
    { name: 'favicon', prefix: faviconPrefix },
    { name: 'attachments live', prefix: livePrefix },
    { name: 'attachments probe', prefix: probePrefix },
    { name: 'export', prefix: exportPrefix },
    ...(linkPreviewPrefix === undefined ? [] : [{ name: 'link preview', prefix: linkPreviewPrefix }]),
  ];
  for (const [index, left] of labeled.entries()) {
    for (const right of labeled.slice(index + 1)) {
      if (overlaps(left.prefix, right.prefix)) {
        throw new RangeError(
          `${left.name} prefix ${JSON.stringify(left.prefix)} must not overlap `
          + `${right.name} prefix ${JSON.stringify(right.prefix)} `
          + `(avatar ${JSON.stringify(avatarPrefix)}, favicon ${JSON.stringify(faviconPrefix)}, `
          + `live ${JSON.stringify(livePrefix)}, probe ${JSON.stringify(probePrefix)}, `
          + `export ${JSON.stringify(exportPrefix)}`
          + `${linkPreviewPrefix === undefined ? '' : `, link preview ${JSON.stringify(linkPreviewPrefix)}`})`,
        );
      }
    }
  }
}

export function parseProductEditorPreviousKeys(
  raw: string,
  label = 'PRODUCT_EDITOR_CURSOR_PREVIOUS_KEYS',
): ProductEditorCursorConfig['previous'] {
  if (raw === '') return Object.freeze([]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${label} must be a JSON array`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON array`);
  }
  if (parsed.length > PRODUCT_EDITOR_CURSOR_MAX_PREVIOUS_KEYS) {
    throw new Error(
      `${label} supports at most ${PRODUCT_EDITOR_CURSOR_MAX_PREVIOUS_KEYS} entries`,
    );
  }
  return Object.freeze(parsed.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${label}[${index}] must be an object`);
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.join(',') !== 'id,key,lastIssuedAt,retainUntil') {
      throw new Error(`${label}[${index}] has invalid fields`);
    }
    if (typeof record.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(record.id)) {
      throw new Error(`${label}[${index}].id is invalid`);
    }
    if (typeof record.key !== 'string' || record.key.length === 0) {
      throw new Error(`${label}[${index}].key is required`);
    }
    if (typeof record.lastIssuedAt !== 'string' || typeof record.retainUntil !== 'string') {
      throw new Error(`${label}[${index}] retention timestamps are required`);
    }
    const lastIssuedAt = parseCanonicalUtcTimestamp(
      record.lastIssuedAt,
      `${label}[${index}].lastIssuedAt`,
    );
    const retainUntil = parseCanonicalUtcTimestamp(
      record.retainUntil,
      `${label}[${index}].retainUntil`,
    );
    if (retainUntil - lastIssuedAt < PRODUCT_EDITOR_CURSOR_TTL_MS) {
      throw new Error(`${label}[${index}] retention must cover cursor TTL`);
    }
    return Object.freeze({
      id: record.id,
      key: record.key,
      lastIssuedAt: new Date(lastIssuedAt).toISOString(),
      retainUntil: new Date(retainUntil).toISOString(),
    });
  }));
}

export function parseExportR2Config(env: NodeJS.ProcessEnv, prefix: string): ExportR2Config {
  const endpoint = requireNonEmpty(env, 'EXPORT_R2_ENDPOINT');
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error('EXPORT_R2_ENDPOINT must be an absolute URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('EXPORT_R2_ENDPOINT must be an http(s) URL');
  }
  const region = requireNonEmpty(env, 'EXPORT_R2_REGION');
  const bucket = requireNonEmpty(env, 'EXPORT_R2_BUCKET');
  const accessKeyId = requireNonEmpty(env, 'EXPORT_R2_ACCESS_KEY_ID');
  const secretAccessKey = requireNonEmpty(env, 'EXPORT_R2_SECRET_ACCESS_KEY');
  const readAccessKeyId = env.EXPORT_R2_READ_ACCESS_KEY_ID?.trim() || accessKeyId;
  const readSecretAccessKey = env.EXPORT_R2_READ_SECRET_ACCESS_KEY?.trim() || secretAccessKey;
  return Object.freeze({
    endpoint,
    region,
    bucket,
    prefix,
    rwCredential: Object.freeze({ accessKeyId, secretAccessKey }),
    roCredential: Object.freeze({ accessKeyId: readAccessKeyId, secretAccessKey: readSecretAccessKey }),
  });
}

export function loadProductEditorCursorConfig(
  env: NodeJS.ProcessEnv,
  nodeEnv: string,
): ProductEditorCursorConfig {
  const productEditorCursorKey = requireNonEmpty(
    env,
    'PRODUCT_EDITOR_CURSOR_HMAC_KEY',
    nodeEnv === 'production' ? undefined : DEV_EDITOR_CURSOR_KEY,
  );
  const productEditorCursorKeyId = requireNonEmpty(
    env,
    'PRODUCT_EDITOR_CURSOR_KEY_ID',
    nodeEnv === 'production' ? undefined : DEV_EDITOR_CURSOR_KEY_ID,
  );
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(productEditorCursorKeyId)) {
    throw new Error('PRODUCT_EDITOR_CURSOR_KEY_ID must contain 1-64 URL-safe characters');
  }
  if (nodeEnv === 'production' && productEditorCursorKey === DEV_EDITOR_CURSOR_KEY) {
    throw new Error('PRODUCT_EDITOR_CURSOR_HMAC_KEY must not use the development default in production');
  }
  if (nodeEnv === 'production' && productEditorCursorKeyId === DEV_EDITOR_CURSOR_KEY_ID) {
    throw new Error('PRODUCT_EDITOR_CURSOR_KEY_ID must not use the development default in production');
  }
  const previousKeysRaw = env.PRODUCT_EDITOR_CURSOR_PREVIOUS_KEYS?.trim() ?? '';
  const previousKeys = parseProductEditorPreviousKeys(previousKeysRaw);
  const issuanceFormatRaw = env.PRODUCT_EDITOR_CURSOR_ISSUANCE_FORMAT?.trim();
  if (nodeEnv === 'production' && !issuanceFormatRaw) {
    throw new Error('PRODUCT_EDITOR_CURSOR_ISSUANCE_FORMAT is required in production');
  }
  const issuanceFormat = issuanceFormatRaw ?? 'keyed';
  if (issuanceFormat !== 'legacy' && issuanceFormat !== 'keyed') {
    throw new Error('PRODUCT_EDITOR_CURSOR_ISSUANCE_FORMAT must be legacy or keyed');
  }
  const legacyAcceptUntilRaw = env.PRODUCT_EDITOR_CURSOR_LEGACY_ACCEPT_UNTIL?.trim();
  const legacyAcceptUntil = legacyAcceptUntilRaw
    ? new Date(parseCanonicalUtcTimestamp(
      legacyAcceptUntilRaw,
      'PRODUCT_EDITOR_CURSOR_LEGACY_ACCEPT_UNTIL',
    )).toISOString()
    : undefined;
  if (issuanceFormat === 'legacy' && legacyAcceptUntil === undefined) {
    throw new Error(
      'PRODUCT_EDITOR_CURSOR_LEGACY_ACCEPT_UNTIL is required for legacy cursor issuance',
    );
  }
  const allIds = [productEditorCursorKeyId, ...previousKeys.map((key) => key.id)];
  const allSecrets = [productEditorCursorKey, ...previousKeys.map((key) => key.key)];
  if (nodeEnv === 'production'
    && (allIds.includes(DEV_EDITOR_CURSOR_KEY_ID) || allSecrets.includes(DEV_EDITOR_CURSOR_KEY))) {
    throw new Error('Product Editor cursor keys must not use development defaults in production');
  }
  if (new Set(allIds).size !== allIds.length) {
    throw new Error('Product Editor cursor key IDs must be unique');
  }
  if (new Set(allSecrets).size !== allSecrets.length) {
    throw new Error('Product Editor cursor key material must not be reused across key IDs');
  }
  if (nodeEnv === 'production' && allSecrets.some((key) => Buffer.byteLength(key, 'utf8') < 32)) {
    throw new Error('Product Editor cursor HMAC keys must be at least 32 bytes in production');
  }
  return {
    current: Object.freeze({ id: productEditorCursorKeyId, key: productEditorCursorKey }),
    previous: Object.freeze(previousKeys),
    issuanceFormat,
    legacyAcceptUntil,
    ttlMs: PRODUCT_EDITOR_CURSOR_TTL_MS,
  };
}

export function loadOwnedCollectionsCursorConfig(
  env: NodeJS.ProcessEnv,
  nodeEnv: string,
): ProductOwnedCollectionsCursorConfig {
  const ownedCursorKey = requireNonEmpty(env, 'PRODUCT_OWNED_COLLECTIONS_CURSOR_HMAC_KEY',
    nodeEnv === 'production' ? undefined : DEV_OWNED_COLLECTIONS_CURSOR_KEY);
  const ownedCursorKeyId = requireNonEmpty(env, 'PRODUCT_OWNED_COLLECTIONS_CURSOR_KEY_ID',
    nodeEnv === 'production' ? undefined : DEV_OWNED_COLLECTIONS_CURSOR_KEY_ID);
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(ownedCursorKeyId)) {
    throw new Error('PRODUCT_OWNED_COLLECTIONS_CURSOR_KEY_ID must contain 1-64 URL-safe characters');
  }
  const ownedPreviousKeys = parseProductEditorPreviousKeys(
    env.PRODUCT_OWNED_COLLECTIONS_CURSOR_PREVIOUS_KEYS?.trim() ?? '',
    'PRODUCT_OWNED_COLLECTIONS_CURSOR_PREVIOUS_KEYS',
  );
  const ownedIds = [ownedCursorKeyId, ...ownedPreviousKeys.map((key) => key.id)];
  const ownedSecrets = [ownedCursorKey, ...ownedPreviousKeys.map((key) => key.key)];
  if (new Set(ownedIds).size !== ownedIds.length || new Set(ownedSecrets).size !== ownedSecrets.length) {
    throw new Error('Owned Collections cursor key IDs and material must be unique');
  }
  if (nodeEnv === 'production' && (ownedCursorKey === DEV_OWNED_COLLECTIONS_CURSOR_KEY
    || ownedCursorKeyId === DEV_OWNED_COLLECTIONS_CURSOR_KEY_ID
    || ownedSecrets.some((key) => Buffer.byteLength(key, 'utf8') < 32))) {
    throw new Error('Owned Collections cursor keys must be non-development values of at least 32 bytes in production');
  }
  return {
    current: Object.freeze({ id: ownedCursorKeyId, key: ownedCursorKey }),
    previous: Object.freeze(ownedPreviousKeys),
    ttlMs: PRODUCT_EDITOR_CURSOR_TTL_MS,
  };
}

export function loadLinkHealthFeatureConfig(
  env: NodeJS.ProcessEnv,
  nodeEnv: string,
  siblingKeys: { readonly editorKey: string; readonly ownedKey: string },
): LinkHealthFeatureConfig {
  const linkHealthFlag = (env.KNOWN_FEATURE_LINK_HEALTH ?? 'false').trim().toLowerCase();
  if (linkHealthFlag !== 'true' && linkHealthFlag !== 'false') {
    throw new Error('KNOWN_FEATURE_LINK_HEALTH must be true or false');
  }
  const linkHealthCursorKey = requireNonEmpty(env, 'PRODUCT_LINK_HEALTH_CURSOR_HMAC_KEY',
    nodeEnv === 'production' ? undefined : DEV_LINK_HEALTH_CURSOR_KEY);
  const linkHealthCursorKeyId = requireNonEmpty(env, 'PRODUCT_LINK_HEALTH_CURSOR_KEY_ID',
    nodeEnv === 'production' ? undefined : DEV_LINK_HEALTH_CURSOR_KEY_ID);
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(linkHealthCursorKeyId)) {
    throw new Error('PRODUCT_LINK_HEALTH_CURSOR_KEY_ID must contain 1-64 URL-safe characters');
  }
  const linkHealthPreviousKeys = parseProductEditorPreviousKeys(
    env.PRODUCT_LINK_HEALTH_CURSOR_PREVIOUS_KEYS?.trim() ?? '',
    'PRODUCT_LINK_HEALTH_CURSOR_PREVIOUS_KEYS',
  );
  const linkHealthIds = [linkHealthCursorKeyId, ...linkHealthPreviousKeys.map((key) => key.id)];
  const linkHealthSecrets = [linkHealthCursorKey, ...linkHealthPreviousKeys.map((key) => key.key)];
  if (new Set(linkHealthIds).size !== linkHealthIds.length
    || new Set(linkHealthSecrets).size !== linkHealthSecrets.length) {
    throw new Error('Link-health cursor key IDs and material must be unique');
  }
  if (nodeEnv === 'production' && (linkHealthCursorKey === DEV_LINK_HEALTH_CURSOR_KEY
    || linkHealthCursorKeyId === DEV_LINK_HEALTH_CURSOR_KEY_ID
    || linkHealthCursorKey === siblingKeys.ownedKey
    || linkHealthCursorKey === siblingKeys.editorKey
    || linkHealthSecrets.some((key) => Buffer.byteLength(key, 'utf8') < 32))) {
    throw new Error('Link-health cursor keys must be independent non-development values of at least 32 bytes in production');
  }
  return Object.freeze({
    enabled: linkHealthFlag === 'true',
    cursor: Object.freeze({
      current: Object.freeze({ id: linkHealthCursorKeyId, key: linkHealthCursorKey }),
      previous: Object.freeze(linkHealthPreviousKeys),
      ttlMs: PRODUCT_EDITOR_CURSOR_TTL_MS,
    }),
    rateLimit: Object.freeze({
      maxRequests: parsePositiveInt(env.LINK_HEALTH_RATE_LIMIT_MAX, 120, 'LINK_HEALTH_RATE_LIMIT_MAX', { max: 10_000 }),
      windowMs: parsePositiveInt(env.LINK_HEALTH_RATE_LIMIT_WINDOW_MS, 60_000, 'LINK_HEALTH_RATE_LIMIT_WINDOW_MS', { max: 3_600_000 }),
    }),
    timeoutMs: parsePositiveInt(env.LINK_HEALTH_HTTP_TIMEOUT_MS, 2_000, 'LINK_HEALTH_HTTP_TIMEOUT_MS', { max: 30_000 }),
    probeTimeoutMs: parsePositiveInt(env.LINK_HEALTH_PROBE_TIMEOUT_MS, 8_000, 'LINK_HEALTH_PROBE_TIMEOUT_MS', { max: 30_000 }),
    connectTimeoutMs: parsePositiveInt(env.LINK_HEALTH_CONNECT_TIMEOUT_MS, 3_000, 'LINK_HEALTH_CONNECT_TIMEOUT_MS', { max: 30_000 }),
    workerConcurrency: parsePositiveInt(env.LINK_HEALTH_WORKER_CONCURRENCY, 4, 'LINK_HEALTH_WORKER_CONCURRENCY', { max: 4 }),
    perHostGapMs: parsePositiveInt(env.LINK_HEALTH_PER_HOST_GAP_MS, 1_000, 'LINK_HEALTH_PER_HOST_GAP_MS', { max: 60_000 }),
    workerPollIntervalMs: parsePositiveInt(env.LINK_HEALTH_WORKER_POLL_INTERVAL_MS, 1_000, 'LINK_HEALTH_WORKER_POLL_INTERVAL_MS', { max: 60_000 }),
    workerLeaseDurationMs: parsePositiveInt(env.LINK_HEALTH_WORKER_LEASE_DURATION_MS, 60_000, 'LINK_HEALTH_WORKER_LEASE_DURATION_MS', { max: 300_000 }),
  });
}

export function loadOrganizePlansFeatureConfig(env: NodeJS.ProcessEnv): OrganizePlansFeatureConfig {
  const organizePlansFlag = (env.KNOWN_FEATURE_AI_ORGANIZE ?? 'false').trim().toLowerCase();
  if (organizePlansFlag !== 'true' && organizePlansFlag !== 'false') {
    throw new Error('KNOWN_FEATURE_AI_ORGANIZE must be true or false');
  }
  const organizePlannerIdRaw = (env.ORGANIZE_PLANNER_ID ?? '').trim();
  const organizePlannerId = organizePlannerIdRaw.length === 0
    ? DEFAULT_ORGANIZE_PLANNER_ID
    : organizePlannerIdRaw;
  if (!isHeuristicPlannerId(organizePlannerId)) {
    throw new Error(`ORGANIZE_PLANNER_ID is not an allowed heuristic planner id: ${organizePlannerId}`);
  }
  return Object.freeze({
    enabled: organizePlansFlag === 'true',
    plannerId: organizePlannerId,
  });
}

export function loadReadableReplicaFeatureConfig(env: NodeJS.ProcessEnv): ReadableReplicaFeatureConfig {
  const flag = (env.KNOWN_FEATURE_READABLE_REPLICA ?? 'false').trim().toLowerCase();
  if (flag !== 'true' && flag !== 'false') {
    throw new Error('KNOWN_FEATURE_READABLE_REPLICA must be true or false');
  }
  const probeTimeoutMs = parsePositiveInt(
    env.READABLE_REPLICA_PROBE_TIMEOUT_MS, 15_000, 'READABLE_REPLICA_PROBE_TIMEOUT_MS', { max: 30_000 },
  );
  const connectTimeoutMs = parsePositiveInt(
    env.READABLE_REPLICA_CONNECT_TIMEOUT_MS, 5_000, 'READABLE_REPLICA_CONNECT_TIMEOUT_MS', { max: 30_000 },
  );
  const maxBodyBytes = parsePositiveInt(
    env.READABLE_REPLICA_MAX_BODY_BYTES, 2_097_152, 'READABLE_REPLICA_MAX_BODY_BYTES', { max: 2_097_152 },
  );
  const workerConcurrency = parsePositiveInt(
    env.READABLE_REPLICA_WORKER_CONCURRENCY, 2, 'READABLE_REPLICA_WORKER_CONCURRENCY', { max: 4 },
  );
  const perHostGapMs = parsePositiveInt(
    env.READABLE_REPLICA_PER_HOST_GAP_MS, 2_000, 'READABLE_REPLICA_PER_HOST_GAP_MS', { max: 60_000 },
  );
  const workerPollIntervalMs = parsePositiveInt(
    env.READABLE_REPLICA_WORKER_POLL_INTERVAL_MS, 1_000, 'READABLE_REPLICA_WORKER_POLL_INTERVAL_MS', { max: 60_000 },
  );
  const workerLeaseDurationMs = parsePositiveInt(
    env.READABLE_REPLICA_WORKER_LEASE_DURATION_MS, 120_000, 'READABLE_REPLICA_WORKER_LEASE_DURATION_MS', { max: 300_000 },
  );
  const enqueueCooldownMs = parsePositiveInt(
    env.READABLE_REPLICA_ENQUEUE_COOLDOWN_MS, 60_000, 'READABLE_REPLICA_ENQUEUE_COOLDOWN_MS', { max: 300_000 },
  );
  if (workerLeaseDurationMs < probeTimeoutMs) {
    throw new Error(
      'READABLE_REPLICA_WORKER_LEASE_DURATION_MS must be >= READABLE_REPLICA_PROBE_TIMEOUT_MS',
    );
  }
  return Object.freeze({
    enabled: flag === 'true',
    probeTimeoutMs,
    connectTimeoutMs,
    maxBodyBytes,
    workerConcurrency,
    perHostGapMs,
    workerPollIntervalMs,
    workerLeaseDurationMs,
    enqueueCooldownMs,
  });
}

export function loadClassifyInboxFeatureConfig(
  env: NodeJS.ProcessEnv,
  nodeEnv: string,
  siblingKeys: { readonly editorKey: string; readonly ownedKey: string; readonly linkHealthKey: string },
): ClassifyInboxFeatureConfig {
  const classifyFlag = (env.KNOWN_FEATURE_CLASSIFY ?? 'false').trim().toLowerCase();
  if (classifyFlag !== 'true' && classifyFlag !== 'false') {
    throw new Error('KNOWN_FEATURE_CLASSIFY must be true or false');
  }
  const classifyInboxCursorKey = requireNonEmpty(env, 'PRODUCT_CLASSIFY_INBOX_CURSOR_HMAC_KEY',
    nodeEnv === 'production' ? undefined : DEV_CLASSIFY_INBOX_CURSOR_KEY);
  const classifyInboxCursorKeyId = requireNonEmpty(env, 'PRODUCT_CLASSIFY_INBOX_CURSOR_KEY_ID',
    nodeEnv === 'production' ? undefined : DEV_CLASSIFY_INBOX_CURSOR_KEY_ID);
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(classifyInboxCursorKeyId)) {
    throw new Error('PRODUCT_CLASSIFY_INBOX_CURSOR_KEY_ID must contain 1-64 URL-safe characters');
  }
  const classifyInboxPreviousKeys = parseProductEditorPreviousKeys(
    env.PRODUCT_CLASSIFY_INBOX_CURSOR_PREVIOUS_KEYS?.trim() ?? '',
    'PRODUCT_CLASSIFY_INBOX_CURSOR_PREVIOUS_KEYS',
  );
  const classifyInboxIds = [classifyInboxCursorKeyId, ...classifyInboxPreviousKeys.map((key) => key.id)];
  const classifyInboxSecrets = [classifyInboxCursorKey, ...classifyInboxPreviousKeys.map((key) => key.key)];
  if (new Set(classifyInboxIds).size !== classifyInboxIds.length
    || new Set(classifyInboxSecrets).size !== classifyInboxSecrets.length) {
    throw new Error('Classify inbox cursor key IDs and material must be unique');
  }
  if (nodeEnv === 'production' && (classifyInboxCursorKey === DEV_CLASSIFY_INBOX_CURSOR_KEY
    || classifyInboxCursorKeyId === DEV_CLASSIFY_INBOX_CURSOR_KEY_ID
    || classifyInboxCursorKey === siblingKeys.ownedKey
    || classifyInboxCursorKey === siblingKeys.editorKey
    || classifyInboxCursorKey === siblingKeys.linkHealthKey
    || classifyInboxSecrets.some((key) => Buffer.byteLength(key, 'utf8') < 32))) {
    throw new Error('Classify inbox cursor keys must be independent non-development values of at least 32 bytes in production');
  }
  return Object.freeze({
    enabled: classifyFlag === 'true',
    cursor: Object.freeze({
      current: Object.freeze({ id: classifyInboxCursorKeyId, key: classifyInboxCursorKey }),
      previous: Object.freeze(classifyInboxPreviousKeys),
      ttlMs: PRODUCT_EDITOR_CURSOR_TTL_MS,
    }),
  });
}

export function loadCollectionHistoryFeatureConfig(
  env: NodeJS.ProcessEnv,
  nodeEnv: string,
  siblingKeys: {
    readonly editorKey: string;
    readonly ownedKey: string;
    readonly linkHealthKey: string;
    readonly classifyInboxKey: string;
  },
): CollectionHistoryFeatureConfig {
  const collectionHistoryFlag = (env.KNOWN_FEATURE_COLLECTION_HISTORY ?? 'false').trim().toLowerCase();
  if (collectionHistoryFlag !== 'true' && collectionHistoryFlag !== 'false') {
    throw new Error('KNOWN_FEATURE_COLLECTION_HISTORY must be true or false');
  }
  const collectionHistoryCursorKey = requireNonEmpty(env, 'PRODUCT_COLLECTION_VERSIONS_CURSOR_HMAC_KEY',
    nodeEnv === 'production' ? undefined : DEV_COLLECTION_VERSIONS_CURSOR_KEY);
  const collectionHistoryCursorKeyId = requireNonEmpty(env, 'PRODUCT_COLLECTION_VERSIONS_CURSOR_KEY_ID',
    nodeEnv === 'production' ? undefined : DEV_COLLECTION_VERSIONS_CURSOR_KEY_ID);
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(collectionHistoryCursorKeyId)) {
    throw new Error('PRODUCT_COLLECTION_VERSIONS_CURSOR_KEY_ID must contain 1-64 URL-safe characters');
  }
  const collectionHistoryPreviousKeys = parseProductEditorPreviousKeys(
    env.PRODUCT_COLLECTION_VERSIONS_CURSOR_PREVIOUS_KEYS?.trim() ?? '',
    'PRODUCT_COLLECTION_VERSIONS_CURSOR_PREVIOUS_KEYS',
  );
  const collectionHistoryIds = [collectionHistoryCursorKeyId, ...collectionHistoryPreviousKeys.map((key) => key.id)];
  const collectionHistorySecrets = [collectionHistoryCursorKey, ...collectionHistoryPreviousKeys.map((key) => key.key)];
  if (new Set(collectionHistoryIds).size !== collectionHistoryIds.length
    || new Set(collectionHistorySecrets).size !== collectionHistorySecrets.length) {
    throw new Error('Collection history cursor key IDs and material must be unique');
  }
  if (nodeEnv === 'production' && (collectionHistoryCursorKey === DEV_COLLECTION_VERSIONS_CURSOR_KEY
    || collectionHistoryCursorKeyId === DEV_COLLECTION_VERSIONS_CURSOR_KEY_ID
    || collectionHistoryCursorKey === siblingKeys.ownedKey
    || collectionHistoryCursorKey === siblingKeys.editorKey
    || collectionHistoryCursorKey === siblingKeys.linkHealthKey
    || collectionHistoryCursorKey === siblingKeys.classifyInboxKey
    || collectionHistorySecrets.some((key) => Buffer.byteLength(key, 'utf8') < 32))) {
    throw new Error('Collection history cursor keys must be independent non-development values of at least 32 bytes in production');
  }
  return Object.freeze({
    enabled: collectionHistoryFlag === 'true',
    cursor: Object.freeze({
      current: Object.freeze({ id: collectionHistoryCursorKeyId, key: collectionHistoryCursorKey }),
      previous: Object.freeze(collectionHistoryPreviousKeys),
      ttlMs: PRODUCT_EDITOR_CURSOR_TTL_MS,
    }),
  });
}

export function loadExportJobsFeatureConfig(
  env: NodeJS.ProcessEnv,
  exportR2Prefix: string,
): ExportJobsFeatureConfig {
  const exportJobsFlag = (env.KNOWN_FEATURE_EXPORT_JOBS ?? 'true').trim().toLowerCase();
  if (exportJobsFlag !== 'true' && exportJobsFlag !== 'false') {
    throw new Error('KNOWN_FEATURE_EXPORT_JOBS must be true or false');
  }
  const exportR2 = exportJobsFlag === 'true' ? parseExportR2Config(env, exportR2Prefix) : null;
  return Object.freeze({
    enabled: exportJobsFlag === 'true',
    prefix: exportR2Prefix,
    r2: exportR2,
    rateLimit: Object.freeze({
      maxRequests: parsePositiveInt(env.EXPORT_JOB_RATE_LIMIT_MAX, 120, 'EXPORT_JOB_RATE_LIMIT_MAX', { max: 10_000 }),
      windowMs: parsePositiveInt(env.EXPORT_JOB_RATE_LIMIT_WINDOW_MS, 60_000, 'EXPORT_JOB_RATE_LIMIT_WINDOW_MS', { max: 3_600_000 }),
    }),
    timeoutMs: parsePositiveInt(env.EXPORT_JOB_HTTP_TIMEOUT_MS, 2_000, 'EXPORT_JOB_HTTP_TIMEOUT_MS', { max: 30_000 }),
    workerConcurrency: parsePositiveInt(env.EXPORT_JOB_WORKER_CONCURRENCY, 1, 'EXPORT_JOB_WORKER_CONCURRENCY', { max: 4 }),
    workerPollIntervalMs: parsePositiveInt(env.EXPORT_JOB_WORKER_POLL_INTERVAL_MS, 1_000, 'EXPORT_JOB_WORKER_POLL_INTERVAL_MS', { max: 60_000 }),
    workerLeaseDurationMs: parsePositiveInt(env.EXPORT_JOB_WORKER_LEASE_DURATION_MS, 60_000, 'EXPORT_JOB_WORKER_LEASE_DURATION_MS', { max: 300_000 }),
  });
}
