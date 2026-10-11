import { registerBookmarkSubscriptionRoutes } from './product/bookmark-subscription-routes.js';
import type { FastifyInstance } from 'fastify';
import type { AppDependencies } from './app-dependencies.js';
import { extensionProductAllowedOrigins } from './extension-product-origins.js';
import { registerBookmarkPreferencesRoutes } from './product/bookmark-preferences-routes.js';

/** Account preferences share the authenticated Product surface. */
export function registerAccountProductSurfaces(app: FastifyInstance, deps: AppDependencies): void {
  const { config, identityUnitOfWork, bookmarkPreferencesUnitOfWork, bookmarkPreferencesQuery } = deps;
  const subscriptions = { identityUnitOfWork, unitOfWork: deps.bookmarkSubscriptionUnitOfWork, allowedOrigins: extensionProductAllowedOrigins(config), enabled: () => config.bookmarkSubscriptions?.enabled === true, protocolReady: () => config.bookmarkSubscriptions?.protocolReady === true, cursorKey: config.community.cursorHmacKey, rateLimiter: deps.reportsRateLimiter };
  registerBookmarkSubscriptionRoutes(app, subscriptions);
  if (identityUnitOfWork && bookmarkPreferencesUnitOfWork && bookmarkPreferencesQuery) {
    registerBookmarkPreferencesRoutes(app, {
      identityUnitOfWork,
      allowedOrigins: extensionProductAllowedOrigins(config),
      commandUnitOfWork: bookmarkPreferencesUnitOfWork,
      queryStore: bookmarkPreferencesQuery,
    });
  }
}
