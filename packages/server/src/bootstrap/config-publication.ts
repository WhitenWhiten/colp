import { assertOidcEndpointUrl } from './oidc-endpoint-policy.js';
import {
  requireNonEmpty,
  parsePositiveInt,
  DEV_PUBLICATION_CURSOR_SECRET,
} from './config-parse-helpers.js';
import { loadPublishingInsightsRateLimitSharedConfig } from './config-rate-limit.js';
import type {
  PublicationConfig,
  PublishingInsightsConfig,
  SyncSessionConfig,
} from './config-types.js';

const DEFAULT_PUBLICATION_CACHE_PURGE_TIMEOUT_MS = 5_000;
const INDEXNOW_TIMEOUT_MS = 5_000 as const;
const MAX_HANDLER_TIMEOUT_MS = 600_000;
const DEV_PUBLISHING_INSIGHTS_VISITOR_HMAC_KEY = 'dev-publishing-insights-visitor-hmac-key-change-me';
const DEV_PUBLISHING_INSIGHTS_RATELIMIT_HMAC_KEY = 'dev-publishing-insights-ratelimit-hmac-key-change-me';
const DEV_PUBLICATION_SERVER_UUID = '019b3c67-a03c-7f02-9c7e-1ee8d50a77de';

export function parsePublicationRetainedKeys(raw: string): readonly { readonly id: string; readonly secret: string }[] {
  if (raw === '') return Object.freeze([]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('PUBLICATION_CURSOR_RETAINED_KEYS must be a JSON array');
  }
  if (!Array.isArray(parsed) || parsed.length > 8) {
    throw new Error('PUBLICATION_CURSOR_RETAINED_KEYS must be a JSON array with at most 8 entries');
  }
  return Object.freeze(parsed.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`PUBLICATION_CURSOR_RETAINED_KEYS[${index}] must be an object`);
    }
    const record = value as Record<string, unknown>;
    if (Object.keys(record).sort().join(',') !== 'id,secret'
      || typeof record.id !== 'string'
      || typeof record.secret !== 'string') {
      throw new Error(`PUBLICATION_CURSOR_RETAINED_KEYS[${index}] must contain only id and secret`);
    }
    return Object.freeze({ id: record.id, secret: record.secret });
  }));
}

export interface PublicationCoreConfig {
  readonly origin: string;
  readonly serverUuid: string;
  readonly title: string;
  readonly maxPageSize: number;
  readonly maxSnapshotNodes: number;
  readonly cursorKeyId: string;
  readonly cursorSecret: string;
  readonly retainedKeys: readonly { readonly id: string; readonly secret: string }[];
  readonly cachePurge: PublicationConfig['cachePurge'];
  readonly indexNow: PublicationConfig['indexNow'];
}

export function loadPublicationCore(
  env: NodeJS.ProcessEnv,
  args: {
    readonly nodeEnv: string;
    readonly productOrigin: string;
  },
): PublicationCoreConfig {
  const { nodeEnv, productOrigin } = args;
  const publicationOrigin = requireNonEmpty(env, 'PUBLICATION_ORIGIN', productOrigin);
  let publicationOriginUrl: URL;
  try {
    publicationOriginUrl = new URL(publicationOrigin);
    if (publicationOriginUrl.origin !== publicationOrigin || publicationOriginUrl.username || publicationOriginUrl.password) {
      throw new Error();
    }
  } catch {
    throw new Error('PUBLICATION_ORIGIN must be an exact absolute origin URL without userinfo');
  }
  const insecureHttp = env.COLP_INSECURE_HTTP === 'true';
  if (publicationOriginUrl.protocol !== 'https:'
    && !(publicationOriginUrl.protocol === 'http:' && (insecureHttp
      || ['localhost', '127.0.0.1', '[::1]'].includes(publicationOriginUrl.hostname)))) {
    throw new Error('PUBLICATION_ORIGIN must use https (http is allowed only for loopback)');
  }
  const publicationServerUuid = requireNonEmpty(
    env,
    'PUBLICATION_SERVER_UUID',
    nodeEnv === 'production' ? undefined : DEV_PUBLICATION_SERVER_UUID,
  );
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(publicationServerUuid)) {
    throw new Error('PUBLICATION_SERVER_UUID must be a lowercase UUID');
  }
  const publicationCursorKeyId = requireNonEmpty(
    env,
    'PUBLICATION_CURSOR_ACTIVE_KEY_ID',
    nodeEnv === 'production' ? undefined : 'dev-publication-v1',
  );
  const publicationCursorSecret = requireNonEmpty(
    env,
    'PUBLICATION_CURSOR_ACTIVE_SECRET',
    nodeEnv === 'production' ? undefined : DEV_PUBLICATION_CURSOR_SECRET,
  );
  const publicationRetainedKeys = parsePublicationRetainedKeys(
    env.PUBLICATION_CURSOR_RETAINED_KEYS?.trim() ?? '',
  );
  const publicationCachePurgeEndpoint = env.PUBLICATION_CACHE_PURGE_ENDPOINT?.trim();
  let publicationCachePurge: PublicationConfig['cachePurge'];
  if (publicationCachePurgeEndpoint) {
    let endpoint: URL;
    try {
      endpoint = new URL(publicationCachePurgeEndpoint);
    } catch {
      throw new Error('PUBLICATION_CACHE_PURGE_ENDPOINT must be an absolute URL');
    }
    if (endpoint.username || endpoint.password || endpoint.hash) {
      throw new Error('PUBLICATION_CACHE_PURGE_ENDPOINT must not contain userinfo or a fragment');
    }
    const loopbackHttp = endpoint.protocol === 'http:'
      && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
    if (endpoint.protocol !== 'https:' && !(nodeEnv !== 'production' && loopbackHttp)) {
      throw new Error('PUBLICATION_CACHE_PURGE_ENDPOINT must use https (development loopback may use http)');
    }
    if (nodeEnv === 'production') {
      assertOidcEndpointUrl(
        'PUBLICATION_CACHE_PURGE_ENDPOINT',
        publicationCachePurgeEndpoint,
        'strict',
      );
    }
    const bearerToken = env.PUBLICATION_CACHE_PURGE_BEARER_TOKEN?.trim();
    publicationCachePurge = Object.freeze({
      endpoint: endpoint.href,
      ...(bearerToken ? { bearerToken } : {}),
      timeoutMs: parsePositiveInt(
        env.PUBLICATION_CACHE_PURGE_TIMEOUT_MS,
        DEFAULT_PUBLICATION_CACHE_PURGE_TIMEOUT_MS,
        'PUBLICATION_CACHE_PURGE_TIMEOUT_MS',
        { max: MAX_HANDLER_TIMEOUT_MS },
      ),
    });
  }

  const indexNowFlag = env.KNOWN_FEATURE_INDEXNOW ?? 'false';
  if (indexNowFlag !== 'true' && indexNowFlag !== 'false') {
    throw new Error('KNOWN_FEATURE_INDEXNOW must be true or false');
  }
  let indexNow: PublicationConfig['indexNow'] = Object.freeze({ enabled: false });
  if (indexNowFlag === 'true') {
    const key = env.KNOWN_INDEXNOW_KEY ?? '';
    if (!/^[0-9a-f]{32}$/u.test(key)) {
      throw new Error('KNOWN_INDEXNOW_KEY must be exactly 32 lowercase hexadecimal characters');
    }
    indexNow = Object.freeze({ enabled: true, key, timeoutMs: INDEXNOW_TIMEOUT_MS });
  }

  return {
    origin: publicationOrigin,
    serverUuid: publicationServerUuid,
    title: env.PUBLICATION_TITLE?.trim() || 'Known Collections',
    maxPageSize: parsePositiveInt(env.PUBLICATION_MAX_PAGE_SIZE, 200, 'PUBLICATION_MAX_PAGE_SIZE', { max: 500 }),
    maxSnapshotNodes: parsePositiveInt(env.PUBLICATION_MAX_SNAPSHOT_NODES, 100_000, 'PUBLICATION_MAX_SNAPSHOT_NODES'),
    cursorKeyId: publicationCursorKeyId,
    cursorSecret: publicationCursorSecret,
    retainedKeys: publicationRetainedKeys,
    cachePurge: publicationCachePurge,
    indexNow,
  };
}

export function assemblePublicationConfig(
  core: PublicationCoreConfig,
  syncSession?: SyncSessionConfig,
): PublicationConfig {
  const publicationOrigin = core.origin;
  return Object.freeze({
    origin: publicationOrigin,
    mountPath: '/colp/v0.1/',
    serverUuid: core.serverUuid,
    title: core.title,
    maxPageSize: core.maxPageSize,
    maxSnapshotNodes: core.maxSnapshotNodes,
    endpoints: Object.freeze({
      directory: `${publicationOrigin}/colp/v0.1/directory`,
      collection: `${publicationOrigin}/colp/v0.1/collections/{collectionId}`,
      snapshot: `${publicationOrigin}/colp/v0.1/collections/{collectionId}/snapshot`,
      ...(syncSession ? { syncSessions: `${publicationOrigin}${syncSession.path}` } : {}),
      ...(syncSession ? { syncSnapshot: `${publicationOrigin}${syncSession.snapshot.path}` } : {}),
      ...(syncSession ? { syncPush: `${publicationOrigin}${syncSession.push.path}` } : {}),
      ...(syncSession ? { syncPull: `${publicationOrigin}${syncSession.pull.path}` } : {}),
      ...(syncSession ? { syncEffectPages: `${publicationOrigin}${syncSession.pull.effectPagePath}` } : {}),
      ...(syncSession ? { syncAck: `${publicationOrigin}${syncSession.ack.path}` } : {}),
      ...(syncSession ? { syncConflict: `${publicationOrigin}${syncSession.conflict.path}` } : {}),
    }),
    ...(syncSession ? { syncRetire: Object.freeze({
      href: `${publicationOrigin}${syncSession.retire.path}`,
    }) } : {}),
    ...(syncSession ? { sync: Object.freeze({
      multiCollectionSessions: false as const,
      maxBatchOperations: syncSession.push.maxBatchOperations,
      cursorRetentionSeconds: syncSession.tombstoneRetentionSeconds,
    }) } : {}),
    cursorKeys: Object.freeze({
      active: Object.freeze({ id: core.cursorKeyId, secret: core.cursorSecret }),
      retained: core.retainedKeys,
    }),
    indexNow: core.indexNow,
    ...(core.cachePurge ? { cachePurge: core.cachePurge } : {}),
  });
}

export function loadPublishingInsightsConfig(
  env: NodeJS.ProcessEnv,
  args: {
    readonly nodeEnv: string;
    readonly productEditorCursorKey: string;
    readonly ownedCursorKey: string;
  },
): PublishingInsightsConfig {
  const { nodeEnv, productEditorCursorKey, ownedCursorKey } = args;
  const publishingInsightsVisitorKey = requireNonEmpty(
    env,
    'PUBLISHING_INSIGHTS_VISITOR_HMAC_KEY',
    nodeEnv === 'production' ? undefined : DEV_PUBLISHING_INSIGHTS_VISITOR_HMAC_KEY,
  );
  const publishingInsightsRateLimitKey = requireNonEmpty(
    env,
    'PUBLISHING_INSIGHTS_RATELIMIT_HMAC_KEY',
    nodeEnv === 'production' ? undefined : DEV_PUBLISHING_INSIGHTS_RATELIMIT_HMAC_KEY,
  );
  if (nodeEnv === 'production' && publishingInsightsVisitorKey === DEV_PUBLISHING_INSIGHTS_VISITOR_HMAC_KEY) {
    throw new Error('PUBLISHING_INSIGHTS_VISITOR_HMAC_KEY must not use the development default in production');
  }
  if (nodeEnv === 'production' && publishingInsightsRateLimitKey === DEV_PUBLISHING_INSIGHTS_RATELIMIT_HMAC_KEY) {
    throw new Error('PUBLISHING_INSIGHTS_RATELIMIT_HMAC_KEY must not use the development default in production');
  }
  if (nodeEnv === 'production' && (
    Buffer.byteLength(publishingInsightsVisitorKey, 'utf8') < 32
    || Buffer.byteLength(publishingInsightsRateLimitKey, 'utf8') < 32
  )) {
    throw new Error('Publishing Insights HMAC keys must be at least 32 bytes in production');
  }
  if (publishingInsightsVisitorKey === publishingInsightsRateLimitKey) {
    throw new Error('PUBLISHING_INSIGHTS_RATELIMIT_HMAC_KEY must be independent from the visitor HMAC key');
  }
  const forbiddenInsightSecrets = new Set([
    productEditorCursorKey,
    ownedCursorKey,
    env.AUTH_RATE_LIMIT_KEY_SECRET?.trim() ?? '',
    env.SEARCH_RATE_LIMIT_KEY_SECRET?.trim() ?? '',
    env.EXPLORE_DIRECTORY_RATE_LIMIT_KEY_SECRET?.trim() ?? '',
    env.PUBLIC_ACTIVITY_RATE_LIMIT_KEY_SECRET?.trim() ?? '',
    env.SYNC_RATE_LIMIT_KEY_SECRET?.trim() ?? '',
  ].filter((value) => value.length > 0));
  if (forbiddenInsightSecrets.has(publishingInsightsVisitorKey)
    || forbiddenInsightSecrets.has(publishingInsightsRateLimitKey)) {
    throw new Error('Publishing Insights HMAC keys must not reuse search, auth, or cursor secrets');
  }
  return Object.freeze({
    visitorHmacKey: Buffer.from(publishingInsightsVisitorKey, 'utf8'),
    rateLimitHmacKey: Buffer.from(publishingInsightsRateLimitKey, 'utf8'),
    rateLimitShared: loadPublishingInsightsRateLimitSharedConfig(env),
  });
}
