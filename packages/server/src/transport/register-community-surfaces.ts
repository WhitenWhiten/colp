import type { FastifyInstance } from 'fastify';
import type { ProductSurfaceRateLimitPurpose } from '../infrastructure/rate-limit/index.js';
import type { ProductAdmissionRateLimiter } from './http-security.js';
import type { AppDependencies } from './app-dependencies.js';
import { registerCommunityRoutes } from './product/community-routes.js';
import { registerCommunityCommentRoutes } from './product/community-comment-routes.js';
import { registerCommunityNotificationRoutes } from './product/community-notification-routes.js';

type ResolveRateLimiter = (
  purpose: ProductSurfaceRateLimitPurpose,
  limiter: ProductAdmissionRateLimiter | undefined,
  budget: { readonly maxRequests: number; readonly windowMs: number },
) => ProductAdmissionRateLimiter;

/** Contract family name → sealed product-surface purpose. */
const COMMUNITY_RATE_LIMIT_PURPOSES = Object.freeze({
  vote: 'community-vote',
  comment: 'community-comment',
  curation: 'community-curation',
  publicReads: 'community-public-reads',
} as const);

/**
 * Register the CS-01..CS-05 community Product surface in one bounded
 * seam. Community routes mount only when all production ports are present; a
 * half-configured set is a composition error, never a half-route.
 */
export function registerCommunityProductSurfaces(
  app: FastifyInstance,
  deps: AppDependencies,
  options: { readonly resolveRateLimiter: ResolveRateLimiter },
): void {
  const {
    config,
    identityUnitOfWork,
    communityTargetQueryUnitOfWork,
    communityVoteCommandUnitOfWork,
    communityRankingQueryUnitOfWork,
    communityCommentQueryUnitOfWork,
    communityCommentCommandUnitOfWork,
    communityCommentManageUnitOfWork,
    communityNotificationQueryUnitOfWork,
    communityNotificationCommandUnitOfWork,
    communityRateLimiters,
  } = deps;
  const configured = [
    communityTargetQueryUnitOfWork,
    communityVoteCommandUnitOfWork,
    communityRankingQueryUnitOfWork,
    communityCommentQueryUnitOfWork,
    communityCommentCommandUnitOfWork,
    communityCommentManageUnitOfWork,
    communityNotificationQueryUnitOfWork,
    communityNotificationCommandUnitOfWork,
  ].filter((unitOfWork) => unitOfWork !== undefined).length;
  if (configured !== 0 && configured !== 8) {
    throw new TypeError('Community target query, vote command, ranking query, comment query, comment command, comment manage, notification query, and notification command production ports must be configured together');
  }
  if (!identityUnitOfWork || !communityTargetQueryUnitOfWork || !communityVoteCommandUnitOfWork
      || !communityRankingQueryUnitOfWork || !communityCommentQueryUnitOfWork
      || !communityCommentCommandUnitOfWork || !communityCommentManageUnitOfWork
      || !communityNotificationQueryUnitOfWork || !communityNotificationCommandUnitOfWork) return;
  // CS contract COMMUNITY_RATE_LIMITS: four independent admission
  // families resolved once here; every community route group shares this
  // map but consumes only its own family counters.
  const rateLimits = Object.freeze({
    vote: options.resolveRateLimiter(
      COMMUNITY_RATE_LIMIT_PURPOSES.vote,
      communityRateLimiters?.vote, config.community.rateLimit.vote,
    ),
    comment: options.resolveRateLimiter(
      COMMUNITY_RATE_LIMIT_PURPOSES.comment,
      communityRateLimiters?.comment, config.community.rateLimit.comment,
    ),
    curation: options.resolveRateLimiter(
      COMMUNITY_RATE_LIMIT_PURPOSES.curation,
      communityRateLimiters?.curation, config.community.rateLimit.curation,
    ),
    publicReads: options.resolveRateLimiter(
      COMMUNITY_RATE_LIMIT_PURPOSES.publicReads,
      communityRateLimiters?.publicReads, config.community.rateLimit.publicReads,
    ),
  });
  registerCommunityRoutes(app, {
    enabled: config.community.enabled,
    allowedOrigins: config.allowedOrigins,
    identityUnitOfWork,
    commandUnitOfWork: communityVoteCommandUnitOfWork,
    queryUnitOfWork: communityTargetQueryUnitOfWork,
    rankingQueryUnitOfWork: communityRankingQueryUnitOfWork,
    rateLimits,
    timeoutMs: config.community.timeoutMs,
    etagHmacKey: config.community.cursorHmacKey,
  });
  registerCommunityCommentRoutes(app, {
    enabled: config.community.enabled,
    allowedOrigins: config.allowedOrigins,
    identityUnitOfWork,
    commentQueryUnitOfWork: communityCommentQueryUnitOfWork,
    commentCommandUnitOfWork: communityCommentCommandUnitOfWork,
    commentManageUnitOfWork: communityCommentManageUnitOfWork,
    rateLimits,
    timeoutMs: config.community.timeoutMs,
    etagHmacKey: config.community.cursorHmacKey,
  });
  registerCommunityNotificationRoutes(app, {
    enabled: config.community.enabled,
    allowedOrigins: config.allowedOrigins,
    identityUnitOfWork,
    notificationQueryUnitOfWork: communityNotificationQueryUnitOfWork,
    notificationCommandUnitOfWork: communityNotificationCommandUnitOfWork,
    rateLimits,
    timeoutMs: config.community.timeoutMs,
    etagHmacKey: config.community.cursorHmacKey,
  });
}
