import { automationRunRoutes } from './product/automation-run-routes.js';
import { automationHealthRoutes } from './product/automation-health-routes.js';
import { registerAutomationRoutes } from './product/automation-rule-routes.js';
import { registerBookmarkSubscriptionRoutes } from './product/bookmark-subscription-routes.js';
import type { FastifyInstance } from 'fastify';
import type { AppDependencies } from './app-dependencies.js';
import { extensionProductAllowedOrigins } from './extension-product-origins.js';
import { registerBookmarkPreferencesRoutes } from './product/bookmark-preferences-routes.js';

/** Account preferences share the authenticated Product surface. */
export function registerAccountProductSurfaces(app: FastifyInstance, deps: AppDependencies): void {
  const { config, identityUnitOfWork, bookmarkPreferencesUnitOfWork, bookmarkPreferencesQuery } = deps;
  if (identityUnitOfWork && deps.automationUnitOfWork) registerAutomationRoutes(app, { identityUnitOfWork, unitOfWork: deps.automationUnitOfWork,
    allowedOrigins: config.allowedOrigins, cursorKey: config.productEditorCursor.current.key }, [...automationHealthRoutes(config.productEditorCursor.current.key), ...automationRunRoutes(config.productEditorCursor.current.key)]);
  if (deps.automationHealthStartup) app.addHook('onReady', deps.automationHealthStartup);
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
