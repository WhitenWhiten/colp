import 'dotenv/config';
import { loadClassificationConfig } from './config-classification.js';
import { timingSafeEqual } from 'node:crypto';
import { DEFAULT_EXPORT_R2_PREFIX } from '../modules/collections/index.js';
import {
  assertFeedOperationsConfig,
  assertNotificationOperationsConfig,
} from './config-social.js';
import {
  assertNoForbiddenMcpLegacyEnvKeys,
} from '../modules/mcp/index.js';
import {
  requireNonEmpty,
  parsePositiveInt,
  parseOrigins,
} from './config-parse-helpers.js';
import { loadPublicShellConfigs } from './config-public-shell.js';
import { loadContentGovernanceConfig } from './config-governance.js';
import { loadBetterAuthConfig, loadHttpSecurity } from './config-http-security.js';
import {
  assertDatabaseConnectionBudget,
  loadDatabasePoolConfig,
  loadWorkerConcurrencyConfig,
  loadPublisherReceiptRetentionConfig,
  loadPublicationInsightRetentionConfig,
  loadCacheConfig,
} from './config-cache.js';
import { assertDistinctRedisRoles } from './config-redis-roles.js';
import {
  loadMcpRateLimitSharedConfig,
  loadEmailCallbackRateLimitSharedConfig,
  loadCollaborationInviteRateLimitSharedConfig,
  loadExploreDirectoryRateLimitSharedConfig,
  loadSyncRateLimitSharedConfig,
  loadRedisRateLimitFamilySharedConfig,
  assertIndependentRateLimitPrefixes,
  loadCollaborationInviteCleanupConfig,
  FOLLOW_RATE_LIMIT_FAMILY_ENV,
  COLLECTION_FOLLOW_RATE_LIMIT_FAMILY_ENV,
  FEED_RATE_LIMIT_FAMILY_ENV,
  NOTIFICATION_RATE_LIMIT_FAMILY_ENV,
  EFFECT_PAGE_RATE_LIMIT_FAMILY_ENV,
  PUBLIC_ACTIVITY_RATE_LIMIT_FAMILY_ENV,
  PRODUCT_ROUTE_RATE_LIMIT_FAMILY_ENV,
} from './config-rate-limit.js';
import {
  loadMcpWriteFeatureConfig,
  loadMcpReadFeatureConfig,
} from './config-mcp.js';
import {
  loadSyncSessionConfig,
  loadSyncTombstonePurgeConfig,
  loadSyncEvidenceMaintenanceConfig,
} from './config-sync.js';
import { loadOidcRuntimeConfig, loadOidcTransactionSecrets } from './config-auth.js';
import {
  assemblePublicationConfig,
  loadPublicationCore,
  loadPublishingInsightsConfig,
} from './config-publication.js';
import {
  loadEmailFeatureConfig,
  loadAuthEmailFeatureConfig,
  loadCollaborationInviteEmailConfig,
} from './config-email.js';
import {
  loadFollowFeatureConfig,
  loadCollectionFollowFeatureConfig,
  loadCommunityFeatureConfig,
  loadLibraryOrderAdmissionConfig,
  loadFaviconPolicyAdmissionConfig,
  loadFeedOperationsConfig,
  loadFeedFeatureConfig,
  loadPublicActivityFeatureConfig,
  loadNotificationOperationsConfig,
  loadNotificationFeatureConfig,
} from './config-social.js';
import {
  assertPublicObjectPrefixesDoNotOverlap,
  DEFAULT_ATTACHMENTS_LIVE_PREFIX,
  DEFAULT_ATTACHMENTS_PROBE_PREFIX,
  DEFAULT_AVATAR_R2_PREFIX,
  DEFAULT_FAVICON_R2_PREFIX,
  loadProductEditorCursorConfig,
  loadOwnedCollectionsCursorConfig,
  loadLinkHealthFeatureConfig,
  loadOrganizePlansFeatureConfig,
  loadReadableReplicaFeatureConfig,
  loadClassifyInboxFeatureConfig,
  loadCollectionHistoryFeatureConfig,
  loadExportJobsFeatureConfig,
} from './config-product.js';
import { parseEmailSkinConfig } from '../infrastructure/email/index.js';
import type { AppConfig } from './config-types.js';
import {
  loadLedgerArchiveRuntimeConfig,
} from './config-ledger-archive.js';
import {
  loadLedgerArchiveReaderRuntimeConfig,
} from './config-ledger-archive-reader.js';
import { loadDatabaseConnectionConfig } from '../infrastructure/config/database-connection.js';
import { loadLinkPreviewFeatureConfig } from './config-link-preview.js';
import { loadReportsFeatureConfig } from './config-reports.js'; import { loadAccountCredentialsFeatureConfig } from './config-account-credentials.js';

export type * from './config-types.js';
export { DEFAULT_MCP_WRITE_COMMIT_RATE_LIMIT } from './config-mcp.js';
export { loadReportsFeatureConfig, parseReportsFeatureConfig } from './config-reports.js';
export {
  sanitizeEmailFeatureConfig,
} from './config-email.js';
export {
  assertPublicObjectPrefixesDoNotOverlap,
  DEFAULT_AVATAR_R2_PREFIX,
  DEFAULT_FAVICON_R2_PREFIX,
} from './config-product.js';

export { sanitizedRuntimeCapacity } from './config-capacity-summary.js';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const { nodeEnv, databaseUrl, databaseSsl } = loadDatabaseConnectionConfig(env);
  const reports = loadReportsFeatureConfig(env, nodeEnv);
  const ledgerArchive = loadLedgerArchiveRuntimeConfig(env, nodeEnv);
  const ledgerArchiveReader = loadLedgerArchiveReaderRuntimeConfig(env, nodeEnv);
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be a valid TCP port');
  }
  // Modern-only absence gate: legacy MCP mode/Session/Legacy configuration must
  // fail closed even while the MCP Read flag is off (migration decision §8).
  assertNoForbiddenMcpLegacyEnvKeys(env);

  const followFlag = (env.KNOWN_FEATURE_FOLLOW ?? 'false').trim().toLowerCase();
  if (followFlag !== 'true' && followFlag !== 'false') throw new Error('KNOWN_FEATURE_FOLLOW must be true or false');
  // Phase 5 follow bindings pin these env names on the config.ts facade.
  const followCursorBindings = {
    FOLLOW_CURSOR_ACTIVE_KEY_ID: env.FOLLOW_CURSOR_ACTIVE_KEY_ID,
    FOLLOW_CURSOR_ACTIVE_SECRET: env.FOLLOW_CURSOR_ACTIVE_SECRET,
    FOLLOW_CURSOR_RETAINED_KEYS: env.FOLLOW_CURSOR_RETAINED_KEYS,
  } as const;
  const collectionFollowFlag = (env.KNOWN_FEATURE_COLLECTION_FOLLOW ?? 'true').trim().toLowerCase();
  if (collectionFollowFlag !== 'true' && collectionFollowFlag !== 'false') {
    throw new Error('KNOWN_FEATURE_COLLECTION_FOLLOW must be true or false');
  }
  const collectionFollowCursorBindings = {
    FOLLOWED_COLLECTIONS_CURSOR_ACTIVE_KEY_ID: env.FOLLOWED_COLLECTIONS_CURSOR_ACTIVE_KEY_ID,
    FOLLOWED_COLLECTIONS_CURSOR_ACTIVE_SECRET: env.FOLLOWED_COLLECTIONS_CURSOR_ACTIVE_SECRET,
    FOLLOWED_COLLECTIONS_CURSOR_RETAINED_KEYS: env.FOLLOWED_COLLECTIONS_CURSOR_RETAINED_KEYS,
  } as const;

  const communityFlag = (env.KNOWN_FEATURE_COMMUNITY ?? 'false').trim().toLowerCase();
  if (communityFlag !== 'true' && communityFlag !== 'false') {
    throw new Error('KNOWN_FEATURE_COMMUNITY must be true or false');
  }

  const feedFlag = (env.KNOWN_FEATURE_FEED ?? 'false').trim().toLowerCase();
  if (feedFlag !== 'true' && feedFlag !== 'false') throw new Error('KNOWN_FEATURE_FEED must be true or false');
  const { fanoutPageSize, operations: feedOperations } = loadFeedOperationsConfig(env, {
    fanoutPageSizeRaw: env.FEED_FANOUT_PAGE_SIZE,
    fanoutProgressAgeNotReadyMsRaw: env.FEED_FANOUT_PROGRESS_AGE_NOT_READY_MS,
  });

  const notificationFlag = (env.KNOWN_FEATURE_NOTIFICATIONS ?? 'false').trim().toLowerCase();
  if (notificationFlag !== 'true' && notificationFlag !== 'false') throw new Error('KNOWN_FEATURE_NOTIFICATIONS must be true or false');
  const notificationOperations = loadNotificationOperationsConfig(env);

  const emailFlag = (env.KNOWN_FEATURE_EMAIL ?? 'false').trim().toLowerCase();
  if (emailFlag !== 'true' && emailFlag !== 'false') throw new Error('KNOWN_FEATURE_EMAIL must be true or false');
  const emailBase = loadEmailFeatureConfig(env, emailFlag);
  const authEmail = loadAuthEmailFeatureConfig(env);
  const collaborationInviteEmail = loadCollaborationInviteEmailConfig(env, { nodeEnv, authEmail });
  const emailSkins = parseEmailSkinConfig(env);

  const productOrigin = requireNonEmpty(env, 'PRODUCT_ORIGIN', 'http://127.0.0.1:3000');
  let productOriginUrl: URL;
  try {
    productOriginUrl = new URL(productOrigin);
    if (productOriginUrl.origin !== productOrigin) throw new Error('PRODUCT_ORIGIN must be an exact origin');
  } catch {
    throw new Error('PRODUCT_ORIGIN must be a valid absolute origin URL');
  }
  // __Host- session cookies require Secure over HTTPS at the browser edge.
  if (nodeEnv === 'production' && productOriginUrl.protocol !== 'https:') {
    throw new Error('PRODUCT_ORIGIN must use https in production (__Host- session cookie contract)');
  }
  const allowedOrigins = parseOrigins(env.ALLOWED_ORIGINS, productOrigin);
  const betterAuth = loadBetterAuthConfig(env, nodeEnv, productOrigin, allowedOrigins);
  if (emailBase.opsToken !== null && betterAuth.secret !== null) {
    const tokenBytes = Buffer.from(emailBase.opsToken, 'utf8');
    const secretBytes = Buffer.from(betterAuth.secret, 'utf8');
    if (tokenBytes.length === secretBytes.length && timingSafeEqual(tokenBytes, secretBytes)) {
      throw new Error('EMAIL_OPS_TOKEN must not equal BETTER_AUTH_SECRET');
    }
  }

  const avatarR2Prefix = env.AVATAR_R2_PREFIX?.trim() || DEFAULT_AVATAR_R2_PREFIX;
  const faviconR2Prefix = env.FAVICON_R2_PREFIX?.trim() || DEFAULT_FAVICON_R2_PREFIX;
  const exportR2Prefix = env.EXPORT_R2_PREFIX?.trim() || DEFAULT_EXPORT_R2_PREFIX;
  const linkPreview = loadLinkPreviewFeatureConfig(env);
  assertPublicObjectPrefixesDoNotOverlap(
    avatarR2Prefix,
    faviconR2Prefix,
    DEFAULT_ATTACHMENTS_LIVE_PREFIX,
    DEFAULT_ATTACHMENTS_PROBE_PREFIX,
    exportR2Prefix,
    linkPreview.r2Prefix,
  );

  const publicationCore = loadPublicationCore(env, { nodeEnv, productOrigin });
  const oidcRuntime = loadOidcRuntimeConfig(env, {
    nodeEnv, productOrigin, productOriginUrl, betterAuthEnabled: betterAuth.enabled,
  });
  const productEditorCursor = loadProductEditorCursorConfig(env, nodeEnv);
  const productOwnedCollectionsCursor = loadOwnedCollectionsCursorConfig(env, nodeEnv);
  const organizePlans = loadOrganizePlansFeatureConfig(env);
  const readableReplica = loadReadableReplicaFeatureConfig(env);
  const exportJobs = loadExportJobsFeatureConfig(env, exportR2Prefix);
  const linkHealth = loadLinkHealthFeatureConfig(env, nodeEnv, {
    editorKey: productEditorCursor.current.key,
    ownedKey: productOwnedCollectionsCursor.current.key,
  });
  const classifyInbox = loadClassifyInboxFeatureConfig(env, nodeEnv, {
    editorKey: productEditorCursor.current.key,
    ownedKey: productOwnedCollectionsCursor.current.key,
    linkHealthKey: linkHealth.cursor.current.key,
  });
  const collectionHistory = loadCollectionHistoryFeatureConfig(env, nodeEnv, {
    editorKey: productEditorCursor.current.key,
    ownedKey: productOwnedCollectionsCursor.current.key,
    linkHealthKey: linkHealth.cursor.current.key,
    classifyInboxKey: classifyInbox.cursor.current.key,
  });
  const publishingInsights = loadPublishingInsightsConfig(env, {
    nodeEnv,
    productEditorCursorKey: productEditorCursor.current.key,
    ownedCursorKey: productOwnedCollectionsCursor.current.key,
  });
  const collaborationInviteRateLimit = loadCollaborationInviteRateLimitSharedConfig(env, nodeEnv);
  const collaborationSecret = collaborationInviteRateLimit.keySecret.toString('utf8');
  const forbiddenCollaborationSecrets = new Set([
    env.AUTH_RATE_LIMIT_KEY_SECRET?.trim() ?? '',
    env.SEARCH_RATE_LIMIT_KEY_SECRET?.trim() ?? '',
    env.EXPLORE_DIRECTORY_RATE_LIMIT_KEY_SECRET?.trim() ?? '',
    env.PUBLIC_ACTIVITY_RATE_LIMIT_KEY_SECRET?.trim() ?? '',
    env.PRODUCT_ROUTE_RATE_LIMIT_KEY_SECRET?.trim() ?? '',
    env.SYNC_RATE_LIMIT_KEY_SECRET?.trim() ?? '',
    publishingInsights.visitorHmacKey.toString('utf8'),
    publishingInsights.rateLimitHmacKey.toString('utf8'),
  ].filter((value) => value.length > 0));
  if (forbiddenCollaborationSecrets.has(collaborationSecret)) {
    throw new Error(
      'COLLABORATION_INVITE_RATE_LIMIT_KEY_SECRET must not reuse auth, search, or insights secrets',
    );
  }

  const oidcTransactionSecrets = loadOidcTransactionSecrets(env, {
    nodeEnv,
    legacyOidcSecretsRequired: !betterAuth.enabled,
  });
  const httpSecurity = loadHttpSecurity(env, nodeEnv);
  const exploreDirectoryShared = loadExploreDirectoryRateLimitSharedConfig(env);
  if (exploreDirectoryShared.keySecret !== null) {
    const exploreSecret = exploreDirectoryShared.keySecret.toString('utf8');
    const forbiddenExploreSecrets = new Set([
      env.AUTH_RATE_LIMIT_KEY_SECRET?.trim() ?? '',
      env.SEARCH_RATE_LIMIT_KEY_SECRET?.trim() ?? '',
      env.SYNC_RATE_LIMIT_KEY_SECRET?.trim() ?? '',
      env.FOLLOW_RATE_LIMIT_KEY_SECRET?.trim() ?? '',
      env.COLLECTION_FOLLOW_RATE_LIMIT_KEY_SECRET?.trim() ?? '',
      env.FEED_RATE_LIMIT_KEY_SECRET?.trim() ?? '',
      env.NOTIFICATION_RATE_LIMIT_KEY_SECRET?.trim() ?? '',
      env.SYNC_EFFECT_PAGE_RATE_LIMIT_KEY_SECRET?.trim() ?? '',
      env.PUBLIC_ACTIVITY_RATE_LIMIT_KEY_SECRET?.trim() ?? '',
      env.PRODUCT_ROUTE_RATE_LIMIT_KEY_SECRET?.trim() ?? '',
      publishingInsights.visitorHmacKey.toString('utf8'),
      publishingInsights.rateLimitHmacKey.toString('utf8'),
      collaborationSecret,
    ].filter((value) => value.length > 0));
    if (forbiddenExploreSecrets.has(exploreSecret)) {
      throw new Error(
        'EXPLORE_DIRECTORY_RATE_LIMIT_KEY_SECRET must not reuse auth, search, insights, or invite secrets',
      );
    }
  }
  const exploreDirectoryRateLimit = Object.freeze({
    anonymousMaxRequests: httpSecurity.searchRateLimit.anonymousMaxRequests,
    accountMaxRequests: httpSecurity.searchRateLimit.accountMaxRequests,
    windowMs: httpSecurity.searchRateLimit.windowMs,
    shared: exploreDirectoryShared,
  });
  const publicActivityRateLimitShared = loadRedisRateLimitFamilySharedConfig(
    env, PUBLIC_ACTIVITY_RATE_LIMIT_FAMILY_ENV,
  );
  const publicActivityRateLimit = Object.freeze({
    anonymousMaxRequests: httpSecurity.searchRateLimit.anonymousMaxRequests,
    accountMaxRequests: httpSecurity.searchRateLimit.accountMaxRequests,
    windowMs: httpSecurity.searchRateLimit.windowMs,
    shared: publicActivityRateLimitShared,
  });
  const syncRateLimitShared = loadSyncRateLimitSharedConfig(env);
  if (syncRateLimitShared.keySecret !== null) {
    const syncSecret = syncRateLimitShared.keySecret.toString('utf8');
    const forbiddenSyncSecrets = new Set([
      env.AUTH_RATE_LIMIT_KEY_SECRET?.trim() ?? '',
      env.SEARCH_RATE_LIMIT_KEY_SECRET?.trim() ?? '',
      env.EXPLORE_DIRECTORY_RATE_LIMIT_KEY_SECRET?.trim() ?? '',
      env.PUBLIC_ACTIVITY_RATE_LIMIT_KEY_SECRET?.trim() ?? '',
      env.PRODUCT_ROUTE_RATE_LIMIT_KEY_SECRET?.trim() ?? '',
      env.COLLABORATION_INVITE_RATE_LIMIT_KEY_SECRET?.trim() ?? '',
      env.FOLLOW_RATE_LIMIT_KEY_SECRET?.trim() ?? '',
      env.COLLECTION_FOLLOW_RATE_LIMIT_KEY_SECRET?.trim() ?? '',
      env.FEED_RATE_LIMIT_KEY_SECRET?.trim() ?? '',
      env.NOTIFICATION_RATE_LIMIT_KEY_SECRET?.trim() ?? '',
      env.SYNC_EFFECT_PAGE_RATE_LIMIT_KEY_SECRET?.trim() ?? '',
      publishingInsights.visitorHmacKey.toString('utf8'),
      publishingInsights.rateLimitHmacKey.toString('utf8'),
    ].filter((value) => value.length > 0));
    if (forbiddenSyncSecrets.has(syncSecret)) {
      throw new Error(
        'SYNC_RATE_LIMIT_KEY_SECRET must not reuse auth, search, insights, invite, or explore secrets',
      );
    }
  }
  const syncRateLimit = Object.freeze({ shared: syncRateLimitShared });
  const followRateLimitShared = loadRedisRateLimitFamilySharedConfig(env, FOLLOW_RATE_LIMIT_FAMILY_ENV);
  const collectionFollowRateLimitShared = loadRedisRateLimitFamilySharedConfig(
    env, COLLECTION_FOLLOW_RATE_LIMIT_FAMILY_ENV,
  );
  const feedRateLimitShared = loadRedisRateLimitFamilySharedConfig(env, FEED_RATE_LIMIT_FAMILY_ENV);
  const notificationRateLimitShared = loadRedisRateLimitFamilySharedConfig(env, NOTIFICATION_RATE_LIMIT_FAMILY_ENV);
  const effectPageRateLimitShared = loadRedisRateLimitFamilySharedConfig(env, EFFECT_PAGE_RATE_LIMIT_FAMILY_ENV);
  const productRouteRateLimitShared = loadRedisRateLimitFamilySharedConfig(
    env, PRODUCT_ROUTE_RATE_LIMIT_FAMILY_ENV,
  );
  const redisFamilyShared = [
    [FOLLOW_RATE_LIMIT_FAMILY_ENV, followRateLimitShared],
    [COLLECTION_FOLLOW_RATE_LIMIT_FAMILY_ENV, collectionFollowRateLimitShared],
    [FEED_RATE_LIMIT_FAMILY_ENV, feedRateLimitShared],
    [NOTIFICATION_RATE_LIMIT_FAMILY_ENV, notificationRateLimitShared],
    [EFFECT_PAGE_RATE_LIMIT_FAMILY_ENV, effectPageRateLimitShared],
    [PUBLIC_ACTIVITY_RATE_LIMIT_FAMILY_ENV, publicActivityRateLimitShared],
    [PRODUCT_ROUTE_RATE_LIMIT_FAMILY_ENV, productRouteRateLimitShared],
  ] as const;
  const publishingInsightsVisitorKey = publishingInsights.visitorHmacKey.toString('utf8');
  const publishingInsightsRateLimitKey = publishingInsights.rateLimitHmacKey.toString('utf8');
  for (const [names, shared] of redisFamilyShared) {
    if (shared.keySecret === null) continue;
    const secret = shared.keySecret.toString('utf8');
    const siblingSecrets = new Set(
      ([
        ['AUTH_RATE_LIMIT_KEY_SECRET', env.AUTH_RATE_LIMIT_KEY_SECRET?.trim() ?? ''],
        ['SEARCH_RATE_LIMIT_KEY_SECRET', env.SEARCH_RATE_LIMIT_KEY_SECRET?.trim() ?? ''],
        ['EXPLORE_DIRECTORY_RATE_LIMIT_KEY_SECRET', env.EXPLORE_DIRECTORY_RATE_LIMIT_KEY_SECRET?.trim() ?? ''],
        ['SYNC_RATE_LIMIT_KEY_SECRET', env.SYNC_RATE_LIMIT_KEY_SECRET?.trim() ?? ''],
        ['COLLABORATION_INVITE_RATE_LIMIT_KEY_SECRET', env.COLLABORATION_INVITE_RATE_LIMIT_KEY_SECRET?.trim() ?? ''],
        ['FOLLOW_RATE_LIMIT_KEY_SECRET', env.FOLLOW_RATE_LIMIT_KEY_SECRET?.trim() ?? ''],
        ['COLLECTION_FOLLOW_RATE_LIMIT_KEY_SECRET', env.COLLECTION_FOLLOW_RATE_LIMIT_KEY_SECRET?.trim() ?? ''],
        ['FEED_RATE_LIMIT_KEY_SECRET', env.FEED_RATE_LIMIT_KEY_SECRET?.trim() ?? ''],
        ['NOTIFICATION_RATE_LIMIT_KEY_SECRET', env.NOTIFICATION_RATE_LIMIT_KEY_SECRET?.trim() ?? ''],
        ['SYNC_EFFECT_PAGE_RATE_LIMIT_KEY_SECRET', env.SYNC_EFFECT_PAGE_RATE_LIMIT_KEY_SECRET?.trim() ?? ''],
        ['PUBLIC_ACTIVITY_RATE_LIMIT_KEY_SECRET', env.PUBLIC_ACTIVITY_RATE_LIMIT_KEY_SECRET?.trim() ?? ''],
        ['PRODUCT_ROUTE_RATE_LIMIT_KEY_SECRET', env.PRODUCT_ROUTE_RATE_LIMIT_KEY_SECRET?.trim() ?? ''],
      ] as const)
        .filter(([label, value]) => label !== names.keySecret && value.length > 0)
        .map(([, value]) => value),
    );
    siblingSecrets.add(publishingInsightsVisitorKey);
    siblingSecrets.add(publishingInsightsRateLimitKey);
    siblingSecrets.delete('');
    if (siblingSecrets.has(secret)) {
      throw new Error(
        `${names.keySecret} must not reuse auth, search, insights, invite, explore, sync, or sibling rate-limit secrets`,
      );
    }
  }
  assertIndependentRateLimitPrefixes([
    ['SEARCH_RATE_LIMIT_KEY_PREFIX', (env.SEARCH_RATE_LIMIT_KEY_PREFIX ?? 'known').trim()],
    ['EXPLORE_DIRECTORY_RATE_LIMIT_KEY_PREFIX', exploreDirectoryShared.keyPrefix],
    ['SYNC_RATE_LIMIT_KEY_PREFIX', syncRateLimitShared.keyPrefix],
    ['FOLLOW_RATE_LIMIT_KEY_PREFIX', followRateLimitShared.keyPrefix],
    ['COLLECTION_FOLLOW_RATE_LIMIT_KEY_PREFIX', collectionFollowRateLimitShared.keyPrefix],
    ['FEED_RATE_LIMIT_KEY_PREFIX', feedRateLimitShared.keyPrefix],
    ['NOTIFICATION_RATE_LIMIT_KEY_PREFIX', notificationRateLimitShared.keyPrefix],
    ['SYNC_EFFECT_PAGE_RATE_LIMIT_KEY_PREFIX', effectPageRateLimitShared.keyPrefix],
    ['PUBLIC_ACTIVITY_RATE_LIMIT_KEY_PREFIX', publicActivityRateLimitShared.keyPrefix],
    ['PRODUCT_ROUTE_RATE_LIMIT_KEY_PREFIX', productRouteRateLimitShared.keyPrefix],
  ]);
  const syncEffectPageRateLimit = Object.freeze({ shared: effectPageRateLimitShared });
  if (nodeEnv === 'production' && httpSecurity.authApiReplicas > 1
      && !publishingInsights.rateLimitShared.enabled) {
    throw new Error('Production multi-replica API (AUTH_API_REPLICAS > 1) requires PUBLISHING_INSIGHTS_RATE_LIMIT_SHARED=true');
  }
  if (nodeEnv === 'production' && httpSecurity.authApiReplicas > 1
      && !collaborationInviteRateLimit.enabled) {
    throw new Error('Production multi-replica API (AUTH_API_REPLICAS > 1) requires COLLABORATION_INVITE_RATE_LIMIT_SHARED=true');
  }
  if (nodeEnv === 'production' && httpSecurity.authApiReplicas > 1
      && !exploreDirectoryRateLimit.shared.enabled) {
    throw new Error('Production multi-replica API (AUTH_API_REPLICAS > 1) requires EXPLORE_DIRECTORY_RATE_LIMIT_SHARED=true');
  }
  if (nodeEnv === 'production' && httpSecurity.authApiReplicas > 1
      && !publicActivityRateLimit.shared.enabled) {
    throw new Error('Production multi-replica API (AUTH_API_REPLICAS > 1) requires PUBLIC_ACTIVITY_RATE_LIMIT_SHARED=true');
  }
  if (nodeEnv === 'production' && httpSecurity.authApiReplicas > 1
      && !productRouteRateLimitShared.enabled) {
    throw new Error('Production multi-replica API (AUTH_API_REPLICAS > 1) requires PRODUCT_ROUTE_RATE_LIMIT_SHARED=true');
  }

  const follow = loadFollowFeatureConfig({ ...env, ...followCursorBindings }, {
    nodeEnv, flag: followFlag, rateLimitShared: followRateLimitShared,
  });
  const feed = loadFeedFeatureConfig(env, {
    nodeEnv, flag: feedFlag, rateLimitShared: feedRateLimitShared, fanoutPageSize, operations: feedOperations,
  });
  const publicActivity = loadPublicActivityFeatureConfig(env, nodeEnv);
  const notifications = loadNotificationFeatureConfig(env, {
    nodeEnv, flag: notificationFlag, rateLimitShared: notificationRateLimitShared, operations: notificationOperations,
  });
  const libraryOrder = loadLibraryOrderAdmissionConfig(env);
  const collectionFollow = loadCollectionFollowFeatureConfig(
    { ...env, ...collectionFollowCursorBindings },
    {
      nodeEnv, flag: collectionFollowFlag, rateLimitShared: collectionFollowRateLimitShared,
      siblingCursorSecrets: {
        followSecret: follow.cursorKeys.active.secret,
        feedSecret: feed.cursorKeys.active.secret,
        classifyKey: classifyInbox.cursor.current.key,
        editorKey: productEditorCursor.current.key,
        ownedKey: productOwnedCollectionsCursor.current.key,
        linkHealthKey: linkHealth.cursor.current.key,
        collectionHistoryKey: collectionHistory.cursor.current.key,
        notificationSecret: notifications.cursorKeys.active.secret,
        publicActivitySecret: publicActivity.cursorKeys.active.secret,
      },
    },
  );
  const community = loadCommunityFeatureConfig(env, { nodeEnv, flag: communityFlag });

  const database = loadDatabasePoolConfig(env);
  const worker = loadWorkerConcurrencyConfig(env, database);
  assertFeedOperationsConfig(feedOperations, { workerConcurrency: worker.concurrency,
    workerBatchSize: worker.batchSize, workerLeaseDurationMs: worker.leaseDurationMs,
    workerHandlerTimeoutMs: worker.handlerTimeoutMs });
  assertNotificationOperationsConfig(notificationOperations, {
    workerConcurrency: worker.concurrency, workerBatchSize: worker.batchSize,
    workerLeaseDurationMs: worker.leaseDurationMs,
    workerHandlerTimeoutMs: worker.handlerTimeoutMs,
  });
  assertDatabaseConnectionBudget({
    env,
    database,
    apiReplicas: httpSecurity.authApiReplicas,
    workerLoops: [
      { name: 'WORKER_CONCURRENCY', concurrency: worker.concurrency },
      { name: 'REPORTS_SCHEDULER_CONCURRENCY', concurrency: reports.schedulerEnabled ? 1 : 0 },
      {
        name: 'LINK_HEALTH_WORKER_CONCURRENCY',
        concurrency: linkHealth.enabled ? linkHealth.workerConcurrency : 0,
      },
      {
        name: 'READABLE_REPLICA_WORKER_CONCURRENCY',
        concurrency: readableReplica.enabled ? readableReplica.workerConcurrency : 0,
      },
      { name: 'LINK_PREVIEW_CONCURRENCY', concurrency: linkPreview.enabled ? linkPreview.workerConcurrency : 0 },
      {
        name: 'EXPORT_JOB_WORKER_CONCURRENCY',
        concurrency: exportJobs.enabled ? exportJobs.workerConcurrency : 0,
      },
      {
        name: 'LEDGER_ARCHIVE_CONCURRENCY',
        concurrency: ledgerArchive.enabled ? ledgerArchive.concurrency : 0,
      },
    ],
  });
  const publisherReceipts = loadPublisherReceiptRetentionConfig(env);
  const publicationInsightRetention = loadPublicationInsightRetentionConfig(env);
  const collaborationInviteCleanup = loadCollaborationInviteCleanupConfig(env);
  const cache = loadCacheConfig(env);
  assertDistinctRedisRoles(env, cache.redis.mode);
  const syncSession = loadSyncSessionConfig(env);
  const syncTombstonePurge = loadSyncTombstonePurgeConfig(env);
  const syncEvidenceMaintenance = loadSyncEvidenceMaintenanceConfig(env);
  const publication = assemblePublicationConfig(publicationCore, syncSession);
  if (syncSession && nodeEnv === 'production' && !httpSecurity.trustedIngressDeclared) {
    throw new Error('Production Sync Sessions require the explicit TRUSTED_INGRESS allowlist (CIDRs/addresses; empty = peer-only direct TLS) for trusted TLS evidence');
  }
  if (nodeEnv === 'production' && httpSecurity.authApiReplicas > 1
      && syncSession !== undefined && !syncRateLimit.shared.enabled) {
    throw new Error(
      'Production multi-replica API (AUTH_API_REPLICAS > 1) with Sync Sessions enabled requires SYNC_RATE_LIMIT_SHARED=true',
    );
  }
  if (nodeEnv === 'production' && httpSecurity.authApiReplicas > 1
      && syncSession !== undefined && !syncEffectPageRateLimit.shared.enabled) {
    throw new Error(
      'Production multi-replica API (AUTH_API_REPLICAS > 1) with Sync Sessions enabled requires SYNC_EFFECT_PAGE_RATE_LIMIT_SHARED=true',
    );
  }
  if (nodeEnv === 'production' && httpSecurity.authApiReplicas > 1
      && followFlag === 'true' && !followRateLimitShared.enabled) {
    throw new Error(
      'Production multi-replica API (AUTH_API_REPLICAS > 1) with Follow enabled requires FOLLOW_RATE_LIMIT_SHARED=true',
    );
  }
  if (nodeEnv === 'production' && httpSecurity.authApiReplicas > 1
      && collectionFollowFlag === 'true' && !collectionFollowRateLimitShared.enabled) {
    throw new Error(
      'Production multi-replica API (AUTH_API_REPLICAS > 1) with Collection Follow enabled requires COLLECTION_FOLLOW_RATE_LIMIT_SHARED=true',
    );
  }
  if (nodeEnv === 'production' && httpSecurity.authApiReplicas > 1
      && feedFlag === 'true' && !feedRateLimitShared.enabled) {
    throw new Error(
      'Production multi-replica API (AUTH_API_REPLICAS > 1) with Feed enabled requires FEED_RATE_LIMIT_SHARED=true',
    );
  }
  if (nodeEnv === 'production' && httpSecurity.authApiReplicas > 1
      && notificationFlag === 'true' && !notificationRateLimitShared.enabled) {
    throw new Error(
      'Production multi-replica API (AUTH_API_REPLICAS > 1) with Notifications enabled requires NOTIFICATION_RATE_LIMIT_SHARED=true',
    );
  }
  const contentGovernance = loadContentGovernanceConfig(env, nodeEnv);
  const mcpConfig = loadMcpReadFeatureConfig(
    env,
    nodeEnv,
    publication.origin,
    publication.serverUuid,
    { oauthIssuerEnabled: betterAuth.oauthIssuerEnabled, reportsMcpEnabled: reports.mcpEnabled, reportsMcpWriteEnabled: reports.mcpWriteEnabled, communityEnabled: community.enabled, contentGovernanceEnabled: contentGovernance.enabled },
  );
  const mcpWriteFlag = (env.KNOWN_FEATURE_MCP_WRITE ?? 'false').trim().toLowerCase();
  if (mcpWriteFlag !== 'true' && mcpWriteFlag !== 'false') {
    throw new Error('KNOWN_FEATURE_MCP_WRITE must be true or false');
  }
  const mcpWriteEnabled = mcpWriteFlag === 'true';
  if (mcpWriteEnabled && nodeEnv === 'production'
      && (!env.MCP_WRITE_COMMIT_RATE_LIMIT_MAX?.trim()
        || !env.MCP_WRITE_COMMIT_RATE_LIMIT_WINDOW_MS?.trim())) {
    throw new Error(
      'MCP_WRITE_COMMIT_RATE_LIMIT_MAX and MCP_WRITE_COMMIT_RATE_LIMIT_WINDOW_MS are required in production',
    );
  }
  const mcpWrite = mcpWriteEnabled && mcpConfig !== undefined
    ? loadMcpWriteFeatureConfig(env, nodeEnv, productOrigin)
    : undefined;
  const mcpRateLimit = loadMcpRateLimitSharedConfig(env);
  if (nodeEnv === 'production' && httpSecurity.authApiReplicas > 1
      && (mcpConfig !== undefined || mcpWriteEnabled) && !mcpRateLimit.enabled) {
    throw new Error('Production multi-replica API (AUTH_API_REPLICAS > 1) with MCP enabled requires MCP_RATE_LIMIT_SHARED=true');
  }
  const emailCallbackRateLimitShared = loadEmailCallbackRateLimitSharedConfig(env);
  if (nodeEnv === 'production' && httpSecurity.authApiReplicas > 1
      && emailFlag === 'true' && emailBase.callback.hmacSecret !== null && !emailCallbackRateLimitShared.enabled) {
    throw new Error('Production multi-replica API (AUTH_API_REPLICAS > 1) with the email callback ingress mounted requires EMAIL_CALLBACK_RATE_LIMIT_SHARED=true');
  }

  const { publicShellMeta, publicProfileShell } = loadPublicShellConfigs(env);

  return {
    nodeEnv,
    host: env.HOST ?? '127.0.0.1',
    port,
    databaseUrl,
    databaseSsl,
    logLevel: env.LOG_LEVEL ?? 'info',
    productOrigin,
    allowedOrigins,
    betterAuth,
    oidc: oidcRuntime.oidc,
    testIdentityProviderEnabled: oidcRuntime.testIdentityProviderEnabled,
    testAuthMailboxHttp: oidcRuntime.testAuthMailboxHttp,
    oidcTransactionSecrets,
    sessionCookieName: '__Host-known_session',
    productEditorCursor,
    productOwnedCollectionsCursor,
    linkHealth,
    classification: loadClassificationConfig(env),
    organizePlans,
    readableReplica,
    linkPreview,
    classifyInbox,
    collectionHistory,
    exportJobs,
    ledgerArchive,
    ledgerArchiveReader,
    publishingInsights,
    collaborationInviteRateLimit,
    exploreDirectoryRateLimit,
    publicActivityRateLimit,
    productRouteRateLimitShared,
    syncRateLimit,
    syncEffectPageRateLimit,
    collaborationInviteCleanup,
    httpSecurity,
    database,
    cache,
    reports, contentGovernance,
    bookmarkSubscriptions: { enabled: env.KNOWN_FEATURE_BOOKMARK_SUBSCRIPTIONS === 'true', protocolReady: env.KNOWN_BOOKMARK_SUBSCRIPTIONS_PROTOCOL_READY === 'true' },
    worker,
    publisherReceipts,
    publicationInsightRetention,
    syncTombstonePurge,
    syncEvidenceMaintenance,
    follow,
    collectionFollow,
    community,
    libraryOrder,
    faviconPolicy: loadFaviconPolicyAdmissionConfig(env),
    feed,
    publicActivity,
    notifications,
    email: Object.freeze({
      ...emailBase,
      callbackRateLimitShared: emailCallbackRateLimitShared,
    }),
    authEmail,
    collaborationInviteEmail,
    emailSkins,
    publication,
    avatarR2Prefix,
    faviconR2Prefix,
    mcpRateLimit,
    ...(syncSession ? { syncSession } : {}),
    ...(mcpConfig ? { mcp: mcpConfig } : {}),
    mcpWriteEnabled,
    ...(mcpWrite ? { mcpWrite } : {}),
    publicShellMeta,
    publicProfileShell, accountCredentials: loadAccountCredentialsFeatureConfig(env),
  };
}
