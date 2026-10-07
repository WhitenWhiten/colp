import type { FastifyInstance } from 'fastify';
import type { ProductSurfaceRateLimitPurpose } from '../infrastructure/rate-limit/index.js';
import type { ProductAdmissionRateLimiter } from './http-security.js';
import type { AppDependencies } from './app-dependencies.js';
import { registerCatalogPreferenceRoutes } from './product/catalog-preferences-routes.js';
import { registerModerationActionRoutes, registerModerationAppealRoutes } from './product/moderation-action-routes.js';
import { registerModerationRoutes } from './product/moderation-routes.js';

type ResolveRateLimiter = (
  purpose: ProductSurfaceRateLimitPurpose,
  limiter: ProductAdmissionRateLimiter | undefined,
  budget: { readonly maxRequests: number; readonly windowMs: number },
) => ProductAdmissionRateLimiter;

/** Register catalog-preference and moderation Product surfaces. */
export function registerGovernanceProductSurfaces(
  app: FastifyInstance,
  deps: AppDependencies,
  resolveRateLimiter: ResolveRateLimiter,
): void {
  const {
    config,
    identityUnitOfWork,
    catalogPreferencesUnitOfWork,
    catalogPreferencesQuery,
    moderationCommandUnitOfWork,
    moderationQueryPorts,
    governanceReportRateLimiter,
    governanceActionRateLimiter,
    governanceAppealRateLimiter,
  } = deps;
  if (identityUnitOfWork && catalogPreferencesUnitOfWork && catalogPreferencesQuery) {
    registerCatalogPreferenceRoutes(app, {
      config,
      identityUnitOfWork,
      commandUnitOfWork: catalogPreferencesUnitOfWork,
      queryStore: catalogPreferencesQuery,
    });
  }
  if (identityUnitOfWork && moderationCommandUnitOfWork && moderationQueryPorts) {
    const moderationDeps = {
      config,
      identityUnitOfWork,
      commandUnitOfWork: moderationCommandUnitOfWork,
      queryPorts: moderationQueryPorts,
      rateLimiter: resolveRateLimiter(
        'governance-report',
        governanceReportRateLimiter,
        config.contentGovernance.reportRate,
      ),
      actionRateLimiter: resolveRateLimiter(
        'governance-action',
        governanceActionRateLimiter,
        config.contentGovernance.actionRate,
      ),
      appealRateLimiter: resolveRateLimiter(
        'governance-appeal',
        governanceAppealRateLimiter,
        config.contentGovernance.appealRate,
      ),
    };
    registerModerationRoutes(app, moderationDeps);
    registerModerationActionRoutes(app, moderationDeps);
    registerModerationAppealRoutes(app, moderationDeps);
  }
}
