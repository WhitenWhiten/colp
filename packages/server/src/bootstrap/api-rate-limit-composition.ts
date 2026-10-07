import { createProductBurstRateLimiter } from '../transport/product-burst-rate-limit.js';
import type { AppConfig, RedisRateLimitFamilySharedConfig } from './config.js';
import {
  createRedisAuthRateLimitStore,
  createRedisSearchRateLimitStore,
  createRedisSyncColpRateLimitStore,
  createRedisProductSurfaceRateLimitStore,
  createRedisEffectPageRateLimitStore,
  createRedisSyncAdmissionPolicy,
  createMemorySyncAdmissionPolicy,
  type AuthRateLimiter,
  type SearchRateLimiter,
  type SyncColpRateLimiter,
  type EffectPageRateLimiter,
  type ProductSurfaceRateLimitPurpose,
  type SyncAdmissionPolicy,
} from '../infrastructure/rate-limit/index.js';
import {
  createFixedWindowRateLimiter,
  createMemorySearchRateLimiter,
  createMemorySyncColpRateLimiter,
  createMemoryEffectPageRateLimiter,
  type CommunityRateLimiters,
  type ProductAdmissionRateLimiter,
} from '../transport/http-security.js';

export function composeProductSurfaceRateLimiter(input: {
  readonly purpose: ProductSurfaceRateLimitPurpose;
  readonly shared: RedisRateLimitFamilySharedConfig;
  readonly budget: { readonly maxRequests: number; readonly windowMs: number };
  readonly environment: string;
  readonly sharedFlag: string;
  readonly redisUrlEnv: string;
  readonly keySecretEnv: string;
}): ProductAdmissionRateLimiter {
  if (input.shared.enabled) {
    if (input.shared.redisUrl === null || input.shared.keySecret === null) {
      throw new Error(
        `API composition refused: ${input.sharedFlag}=true requires ${input.redisUrlEnv} and ${input.keySecretEnv}`,
      );
    }
    return createRedisProductSurfaceRateLimitStore({
      redisUrl: input.shared.redisUrl,
      environment: input.environment,
      keySecret: input.shared.keySecret,
      purpose: input.purpose,
      keyPrefix: input.shared.keyPrefix,
      maxRequests: input.budget.maxRequests,
      windowMs: input.budget.windowMs,
      commandTimeoutMs: input.shared.commandTimeoutMs,
      connectTimeoutMs: input.shared.connectTimeoutMs,
      maxRetriesPerRequest: input.shared.maxRetriesPerRequest,
    });
  }
  return createFixedWindowRateLimiter(input.budget);
}

export interface ApiSurfaceRateLimiters {
  readonly authRateLimiter: AuthRateLimiter | undefined;
  readonly searchRateLimiter: SearchRateLimiter;
  readonly exploreDirectoryRateLimiter: SearchRateLimiter;
  readonly publicActivityRateLimiter: SearchRateLimiter;
  readonly syncColpRateLimiter: SyncColpRateLimiter | undefined;
  readonly followRateLimiter: ProductAdmissionRateLimiter;
  readonly collectionFollowRateLimiter: ProductAdmissionRateLimiter;
  readonly feedRateLimiter: ProductAdmissionRateLimiter;
  readonly notificationRateLimiter: ProductAdmissionRateLimiter;
  readonly creditsReadRateLimiter: ProductAdmissionRateLimiter;
  readonly libraryOrderRateLimiter: ProductAdmissionRateLimiter;
  readonly faviconPolicyRateLimiter: ProductAdmissionRateLimiter;
  readonly linkHealthRateLimiter: ProductAdmissionRateLimiter;
  readonly classificationProfilesRateLimiter: ProductAdmissionRateLimiter;
  readonly classificationRunsRateLimiter: ProductAdmissionRateLimiter;
  readonly classificationSettingsRateLimiter: ProductAdmissionRateLimiter;
  readonly classificationPreviewRateLimiter: ProductAdmissionRateLimiter;
  readonly classificationConfirmationRateLimiter: ProductAdmissionRateLimiter;
  readonly classifyInboxRateLimiter: ProductAdmissionRateLimiter;
  readonly exportJobRateLimiter: ProductAdmissionRateLimiter;
  readonly organizePlanRateLimiter: ProductAdmissionRateLimiter;
  readonly collectionVersionRateLimiter: ProductAdmissionRateLimiter;
  readonly readableReplicaRateLimiter: ProductAdmissionRateLimiter;
  readonly publicObjectRateLimiter: ProductAdmissionRateLimiter;
  readonly reportsRateLimiter: ProductAdmissionRateLimiter;
  /** CS: four sealed contract families; each has its own counter. */
  readonly communityRateLimiters: CommunityRateLimiters;
  readonly credentialsRateLimiter: ProductAdmissionRateLimiter | undefined;
  readonly credentialIssuanceRateLimiter: ProductAdmissionRateLimiter | undefined;
  readonly automationTokenCredentialRateLimiter: ProductAdmissionRateLimiter | undefined;
  readonly automationTokenClientRateLimiter: ProductAdmissionRateLimiter | undefined;
  readonly governanceReportRateLimiter: ProductAdmissionRateLimiter;
  readonly governanceActionRateLimiter: ProductAdmissionRateLimiter;
  readonly governanceAppealRateLimiter: ProductAdmissionRateLimiter;
  readonly effectPageRateLimiter: EffectPageRateLimiter | undefined;
  readonly syncAdmissionPolicy: SyncAdmissionPolicy | undefined;
}

export function composeApiSurfaceRateLimiters(config: AppConfig): ApiSurfaceRateLimiters {
  let authRateLimiter: AuthRateLimiter | undefined;
  const sharedAuthLimit = config.httpSecurity.authRateLimit.shared;
  if (sharedAuthLimit.enabled) {
    if (sharedAuthLimit.redisUrl === null || sharedAuthLimit.keySecret === null) {
      throw new Error(
        'API composition refused: AUTH_RATE_LIMIT_SHARED=true requires AUTH_RATE_LIMIT_REDIS_URL and AUTH_RATE_LIMIT_KEY_SECRET',
      );
    }
    authRateLimiter = createRedisAuthRateLimitStore({
      redisUrl: sharedAuthLimit.redisUrl,
      environment: config.nodeEnv,
      keySecret: sharedAuthLimit.keySecret,
      keyPrefix: sharedAuthLimit.keyPrefix,
      maxRequests: config.httpSecurity.authRateLimit.maxRequests,
      windowMs: config.httpSecurity.authRateLimit.windowMs,
      commandTimeoutMs: sharedAuthLimit.commandTimeoutMs,
      connectTimeoutMs: sharedAuthLimit.connectTimeoutMs,
      maxRetriesPerRequest: sharedAuthLimit.maxRetriesPerRequest,
    });
  }

  // Explore / Activity / Search always receive a limiter. shared=true uses
  // the Redis adapter; shared=false (the default) uses the in-process memory
  // limiter. Composition never returns undefined for these three families.
  const searchRateLimitConfig = config.httpSecurity.searchRateLimit;
  let searchRateLimiter: SearchRateLimiter;
  const sharedSearchLimit = searchRateLimitConfig.shared;
  if (sharedSearchLimit.enabled) {
    if (sharedSearchLimit.redisUrl === null || sharedSearchLimit.keySecret === null) {
      throw new Error(
        'API composition refused: SEARCH_RATE_LIMIT_SHARED=true requires SEARCH_RATE_LIMIT_REDIS_URL and SEARCH_RATE_LIMIT_KEY_SECRET',
      );
    }
    searchRateLimiter = createRedisSearchRateLimitStore({
      redisUrl: sharedSearchLimit.redisUrl,
      environment: config.nodeEnv,
      keySecret: sharedSearchLimit.keySecret,
      keyPrefix: sharedSearchLimit.keyPrefix,
      anonymousMaxRequests: searchRateLimitConfig.anonymousMaxRequests,
      accountMaxRequests: searchRateLimitConfig.accountMaxRequests,
      windowMs: searchRateLimitConfig.windowMs,
      commandTimeoutMs: sharedSearchLimit.commandTimeoutMs,
      connectTimeoutMs: sharedSearchLimit.connectTimeoutMs,
      maxRetriesPerRequest: sharedSearchLimit.maxRetriesPerRequest,
    });
  } else {
    searchRateLimiter = createMemorySearchRateLimiter({
      anonymousMaxRequests: searchRateLimitConfig.anonymousMaxRequests,
      accountMaxRequests: searchRateLimitConfig.accountMaxRequests,
      windowMs: searchRateLimitConfig.windowMs,
    });
  }

  const exploreDirectoryRateLimitConfig = config.exploreDirectoryRateLimit;
  let exploreDirectoryRateLimiter: SearchRateLimiter;
  const sharedExploreDirectoryLimit = exploreDirectoryRateLimitConfig.shared;
  if (sharedExploreDirectoryLimit.enabled) {
    if (sharedExploreDirectoryLimit.redisUrl === null || sharedExploreDirectoryLimit.keySecret === null) {
      throw new Error(
        'API composition refused: EXPLORE_DIRECTORY_RATE_LIMIT_SHARED=true requires EXPLORE_DIRECTORY_RATE_LIMIT_REDIS_URL and EXPLORE_DIRECTORY_RATE_LIMIT_KEY_SECRET',
      );
    }
    exploreDirectoryRateLimiter = createRedisSearchRateLimitStore({
      redisUrl: sharedExploreDirectoryLimit.redisUrl,
      environment: config.nodeEnv,
      keySecret: sharedExploreDirectoryLimit.keySecret,
      keyPrefix: sharedExploreDirectoryLimit.keyPrefix,
      anonymousMaxRequests: exploreDirectoryRateLimitConfig.anonymousMaxRequests,
      accountMaxRequests: exploreDirectoryRateLimitConfig.accountMaxRequests,
      windowMs: exploreDirectoryRateLimitConfig.windowMs,
      commandTimeoutMs: sharedExploreDirectoryLimit.commandTimeoutMs,
      connectTimeoutMs: sharedExploreDirectoryLimit.connectTimeoutMs,
      maxRetriesPerRequest: sharedExploreDirectoryLimit.maxRetriesPerRequest,
    });
  } else {
    exploreDirectoryRateLimiter = createMemorySearchRateLimiter({
      anonymousMaxRequests: exploreDirectoryRateLimitConfig.anonymousMaxRequests,
      accountMaxRequests: exploreDirectoryRateLimitConfig.accountMaxRequests,
      windowMs: exploreDirectoryRateLimitConfig.windowMs,
    });
  }

  const publicActivityRateLimitConfig = config.publicActivityRateLimit;
  let publicActivityRateLimiter: SearchRateLimiter;
  const sharedPublicActivityLimit = publicActivityRateLimitConfig.shared;
  if (sharedPublicActivityLimit.enabled) {
    if (sharedPublicActivityLimit.redisUrl === null || sharedPublicActivityLimit.keySecret === null) {
      throw new Error(
        'API composition refused: PUBLIC_ACTIVITY_RATE_LIMIT_SHARED=true requires PUBLIC_ACTIVITY_RATE_LIMIT_REDIS_URL and PUBLIC_ACTIVITY_RATE_LIMIT_KEY_SECRET',
      );
    }
    publicActivityRateLimiter = createRedisSearchRateLimitStore({
      redisUrl: sharedPublicActivityLimit.redisUrl,
      environment: config.nodeEnv,
      keySecret: sharedPublicActivityLimit.keySecret,
      keyPrefix: sharedPublicActivityLimit.keyPrefix,
      anonymousMaxRequests: publicActivityRateLimitConfig.anonymousMaxRequests,
      accountMaxRequests: publicActivityRateLimitConfig.accountMaxRequests,
      windowMs: publicActivityRateLimitConfig.windowMs,
      commandTimeoutMs: sharedPublicActivityLimit.commandTimeoutMs,
      connectTimeoutMs: sharedPublicActivityLimit.connectTimeoutMs,
      maxRetriesPerRequest: sharedPublicActivityLimit.maxRetriesPerRequest,
    });
  } else {
    publicActivityRateLimiter = createMemorySearchRateLimiter({
      anonymousMaxRequests: publicActivityRateLimitConfig.anonymousMaxRequests,
      accountMaxRequests: publicActivityRateLimitConfig.accountMaxRequests,
      windowMs: publicActivityRateLimitConfig.windowMs,
    });
  }

  let syncColpRateLimiter: SyncColpRateLimiter | undefined;
  const sharedSyncLimit = config.syncRateLimit.shared;
  if (config.syncSession && sharedSyncLimit.enabled) {
    if (sharedSyncLimit.redisUrl === null || sharedSyncLimit.keySecret === null) {
      throw new Error(
        'API composition refused: SYNC_RATE_LIMIT_SHARED=true requires SYNC_RATE_LIMIT_REDIS_URL and SYNC_RATE_LIMIT_KEY_SECRET',
      );
    }
    syncColpRateLimiter = createRedisSyncColpRateLimitStore({
      redisUrl: sharedSyncLimit.redisUrl,
      environment: config.nodeEnv,
      keySecret: sharedSyncLimit.keySecret,
      keyPrefix: sharedSyncLimit.keyPrefix,
      pushMaxRequests: config.syncSession.push.rateLimit.maxRequests,
      pushWindowMs: config.syncSession.push.rateLimit.windowMs,
      pullMaxRequests: config.syncSession.pull.rateLimit.maxRequests,
      pullWindowMs: config.syncSession.pull.rateLimit.windowMs,
      commandTimeoutMs: sharedSyncLimit.commandTimeoutMs,
      connectTimeoutMs: sharedSyncLimit.connectTimeoutMs,
      maxRetriesPerRequest: sharedSyncLimit.maxRetriesPerRequest,
    });
  } else if (config.syncSession) {
    syncColpRateLimiter = createMemorySyncColpRateLimiter({
      pushMaxRequests: config.syncSession.push.rateLimit.maxRequests,
      pushWindowMs: config.syncSession.push.rateLimit.windowMs,
      pullMaxRequests: config.syncSession.pull.rateLimit.maxRequests,
      pullWindowMs: config.syncSession.pull.rateLimit.windowMs,
    });
  }

  if (!config.follow) throw new Error('Follow production configuration is required');
  if (!config.collectionFollow) throw new Error('Collection Follow production configuration is required');
  if (!config.feed) throw new Error('Feed production configuration is required');
  if (!config.notifications) throw new Error('Notification production configuration is required');
  const followRateLimiter = composeProductSurfaceRateLimiter({
    purpose: 'follow',
    shared: config.follow.rateLimitShared,
    budget: config.follow.rateLimit,
    environment: config.nodeEnv,
    sharedFlag: 'FOLLOW_RATE_LIMIT_SHARED',
    redisUrlEnv: 'FOLLOW_RATE_LIMIT_REDIS_URL',
    keySecretEnv: 'FOLLOW_RATE_LIMIT_KEY_SECRET',
  });
  const collectionFollowRateLimiter = composeProductSurfaceRateLimiter({
    purpose: 'collection-follow',
    shared: config.collectionFollow.rateLimitShared,
    budget: config.collectionFollow.rateLimit,
    environment: config.nodeEnv,
    sharedFlag: 'COLLECTION_FOLLOW_RATE_LIMIT_SHARED',
    redisUrlEnv: 'COLLECTION_FOLLOW_RATE_LIMIT_REDIS_URL',
    keySecretEnv: 'COLLECTION_FOLLOW_RATE_LIMIT_KEY_SECRET',
  });
  const feedRateLimiter = composeProductSurfaceRateLimiter({
    purpose: 'feed',
    shared: config.feed.rateLimitShared,
    budget: config.feed.rateLimit,
    environment: config.nodeEnv,
    sharedFlag: 'FEED_RATE_LIMIT_SHARED',
    redisUrlEnv: 'FEED_RATE_LIMIT_REDIS_URL',
    keySecretEnv: 'FEED_RATE_LIMIT_KEY_SECRET',
  });
  const notificationRateLimiter = composeProductSurfaceRateLimiter({
    purpose: 'notification',
    shared: config.notifications.rateLimitShared,
    budget: config.notifications.rateLimit,
    environment: config.nodeEnv,
    sharedFlag: 'NOTIFICATION_RATE_LIMIT_SHARED',
    redisUrlEnv: 'NOTIFICATION_RATE_LIMIT_REDIS_URL',
    keySecretEnv: 'NOTIFICATION_RATE_LIMIT_KEY_SECRET',
  });
  const productRouteLimiter = (
    purpose: ProductSurfaceRateLimitPurpose,
    budget: { readonly maxRequests: number; readonly windowMs: number },
  ): ProductAdmissionRateLimiter => composeProductSurfaceRateLimiter({
    purpose,
    shared: config.productRouteRateLimitShared,
    budget,
    environment: config.nodeEnv,
    sharedFlag: 'PRODUCT_ROUTE_RATE_LIMIT_SHARED',
    redisUrlEnv: 'PRODUCT_ROUTE_RATE_LIMIT_REDIS_URL',
    keySecretEnv: 'PRODUCT_ROUTE_RATE_LIMIT_KEY_SECRET',
  });
  const creditsReadRateLimiter = createProductBurstRateLimiter(
    productRouteLimiter('credits-read', { maxRequests: 60, windowMs: 60_000 }),
    productRouteLimiter('credits-read', { maxRequests: 10, windowMs: 1_000 }),
    'credits-read',
  );
  const defaultProductRouteBudget = Object.freeze({ maxRequests: 120, windowMs: 60_000 });
  const libraryOrderRateLimiter = productRouteLimiter('library-order', config.libraryOrder.rateLimit);
  const faviconPolicyRateLimiter = productRouteLimiter('favicon-policy', defaultProductRouteBudget);
  const linkHealthRateLimiter = productRouteLimiter('link-health', config.linkHealth.rateLimit);
  const classificationProfilesRateLimiter = productRouteLimiter('classification-profile', {maxRequests:20,windowMs:60000});
  const classificationRunsRateLimiter = productRouteLimiter('classification-run', defaultProductRouteBudget);
  const classificationSettingsRateLimiter = productRouteLimiter('classification-settings', defaultProductRouteBudget);
  const classificationPreviewRateLimiter = productRouteLimiter('classification-preview', defaultProductRouteBudget);
  const classificationConfirmationRateLimiter = productRouteLimiter('classification-confirmation', defaultProductRouteBudget);
  const classifyInboxRateLimiter = productRouteLimiter('classify-inbox', defaultProductRouteBudget);
  const exportJobRateLimiter = productRouteLimiter('export-job', config.exportJobs.rateLimit);
  const organizePlanRateLimiter = productRouteLimiter('organize-plan', defaultProductRouteBudget);
  const collectionVersionRateLimiter = productRouteLimiter('collection-version', defaultProductRouteBudget);
  const readableReplicaRateLimiter = productRouteLimiter('readable-replica', defaultProductRouteBudget);
  const publicObjectRateLimiter = productRouteLimiter('public-object', defaultProductRouteBudget);
  const reportsRateLimiter = productRouteLimiter('reports', defaultProductRouteBudget);
  // CS contract COMMUNITY_RATE_LIMITS: four independent admission families.
  // Each maps to a sealed product-surface purpose so no pair ever shares a
  // counter (memory adapter: four fixed-window maps; shared adapter: four
  // hash-tag purposes).
  const communityRateLimiters: CommunityRateLimiters = Object.freeze({
    vote: productRouteLimiter('community-vote', config.community.rateLimit.vote),
    comment: productRouteLimiter('community-comment', config.community.rateLimit.comment),
    curation: productRouteLimiter('community-curation', config.community.rateLimit.curation),
    publicReads: productRouteLimiter('community-public-reads', config.community.rateLimit.publicReads),
  });
  const credentialsRateLimiter = config.accountCredentials.enabled
    ? productRouteLimiter('credentials', defaultProductRouteBudget)
    : undefined;
  const credentialIssuanceRateLimiter = config.accountCredentials.enabled
    ? productRouteLimiter('credential-issuance', config.accountCredentials.issuanceRate)
    : undefined;
  const automationTokenCredentialRateLimiter = config.accountCredentials.enabled
    ? productRouteLimiter('automation-token-credential', config.accountCredentials.tokenRate.credential)
    : undefined;
  const automationTokenClientRateLimiter = config.accountCredentials.enabled
    ? productRouteLimiter('automation-token-client', config.accountCredentials.tokenRate.client)
    : undefined;
  const governanceReportRateLimiter = productRouteLimiter(
    'governance-report',
    config.contentGovernance.reportRate,
  );
  const governanceActionRateLimiter = productRouteLimiter(
    'governance-action',
    config.contentGovernance.actionRate,
  );
  const governanceAppealRateLimiter = productRouteLimiter(
    'governance-appeal',
    config.contentGovernance.appealRate,
  );

  let effectPageRateLimiter: EffectPageRateLimiter | undefined;
  const sharedEffectPageLimit = config.syncEffectPageRateLimit.shared;
  if (config.syncSession && sharedEffectPageLimit.enabled) {
    if (sharedEffectPageLimit.keySecret === null || sharedEffectPageLimit.redisUrl === null) {
      throw new Error(
        'API composition refused: SYNC_EFFECT_PAGE_RATE_LIMIT_SHARED=true requires SYNC_EFFECT_PAGE_RATE_LIMIT_REDIS_URL and SYNC_EFFECT_PAGE_RATE_LIMIT_KEY_SECRET',
      );
    }
    effectPageRateLimiter = createRedisEffectPageRateLimitStore({
      redisUrl: sharedEffectPageLimit.redisUrl,
      environment: config.nodeEnv,
      keySecret: sharedEffectPageLimit.keySecret,
      keyPrefix: sharedEffectPageLimit.keyPrefix,
      subjectMaxRequests: config.syncSession.pull.effectPageRateLimit.subjectMaxRequests,
      effectMaxRequests: config.syncSession.pull.effectPageRateLimit.effectMaxRequests,
      windowMs: config.syncSession.pull.effectPageRateLimit.windowMs,
      commandTimeoutMs: sharedEffectPageLimit.commandTimeoutMs,
      connectTimeoutMs: sharedEffectPageLimit.connectTimeoutMs,
      maxRetriesPerRequest: sharedEffectPageLimit.maxRetriesPerRequest,
    });
  } else if (config.syncSession) {
    effectPageRateLimiter = createMemoryEffectPageRateLimiter({
      subjectMaxRequests: config.syncSession.pull.effectPageRateLimit.subjectMaxRequests,
      effectMaxRequests: config.syncSession.pull.effectPageRateLimit.effectMaxRequests,
      windowMs: config.syncSession.pull.effectPageRateLimit.windowMs,
    });
  }

  let syncAdmissionPolicy: SyncAdmissionPolicy | undefined;
  if (config.syncSession) {
    const budgets = Object.freeze({
      session: config.syncSession.rateLimit,
      snapshot: config.syncSession.snapshot.rateLimit,
      push: config.syncSession.push.rateLimit,
      pull: config.syncSession.pull.rateLimit,
      conflict: config.syncSession.conflict.rateLimit,
      'effect-page': Object.freeze({
        maxRequests: config.syncSession.pull.effectPageRateLimit.ipMaxRequests,
        windowMs: config.syncSession.pull.effectPageRateLimit.windowMs,
      }),
      ack: config.syncSession.ack.rateLimit,
      retire: config.syncSession.retire.rateLimit,
    });
    const sharedSyncLimit = config.syncRateLimit.shared;
    if (sharedSyncLimit.enabled) {
      if (sharedSyncLimit.redisUrl === null || sharedSyncLimit.keySecret === null) {
        throw new Error(
          'API composition refused: SYNC_RATE_LIMIT_SHARED=true requires SYNC_RATE_LIMIT_REDIS_URL and SYNC_RATE_LIMIT_KEY_SECRET',
        );
      }
      syncAdmissionPolicy = createRedisSyncAdmissionPolicy({
        redisUrl: sharedSyncLimit.redisUrl,
        environment: config.nodeEnv,
        keySecret: sharedSyncLimit.keySecret,
        keyPrefix: sharedSyncLimit.keyPrefix,
        budgets,
        commandTimeoutMs: sharedSyncLimit.commandTimeoutMs,
        connectTimeoutMs: sharedSyncLimit.connectTimeoutMs,
        maxRetriesPerRequest: sharedSyncLimit.maxRetriesPerRequest,
      });
    } else {
      syncAdmissionPolicy = createMemorySyncAdmissionPolicy({ budgets });
    }
  }

  return {
    authRateLimiter,
    searchRateLimiter,
    exploreDirectoryRateLimiter,
    publicActivityRateLimiter,
    syncColpRateLimiter,
    followRateLimiter,
    collectionFollowRateLimiter,
    feedRateLimiter,
    notificationRateLimiter,
    creditsReadRateLimiter,
    libraryOrderRateLimiter,
    faviconPolicyRateLimiter,
    linkHealthRateLimiter,
    classificationProfilesRateLimiter, classificationRunsRateLimiter, classificationSettingsRateLimiter,
    classificationPreviewRateLimiter,
    classificationConfirmationRateLimiter,
    classifyInboxRateLimiter,
    exportJobRateLimiter,
    organizePlanRateLimiter,
    collectionVersionRateLimiter,
    readableReplicaRateLimiter,
    publicObjectRateLimiter,
    reportsRateLimiter,
    communityRateLimiters,
    credentialsRateLimiter,
    credentialIssuanceRateLimiter,
    automationTokenCredentialRateLimiter,
    automationTokenClientRateLimiter,
    governanceReportRateLimiter,
    governanceActionRateLimiter,
    governanceAppealRateLimiter,
    effectPageRateLimiter,
    syncAdmissionPolicy,
  };
}
