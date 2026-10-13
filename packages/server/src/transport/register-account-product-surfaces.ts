import { automationDeliveryRoutes } from './product/automation-delivery-routes.js';
import { automationJobRoutes } from './product/automation-job-routes.js';
import { registerAutomationWorkRoutes } from './automation-work-routes.js';
import { automationTargetRoutes } from './product/automation-target-routes.js';
import { automationPolicyRoutes } from './product/automation-policy-routes.js';
import { registerAutomationDeviceRoutes } from './automation-device-routes.js';
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
    allowedOrigins: config.allowedOrigins, cursorKey: config.productEditorCursor.current.key }, [...automationDeliveryRoutes(config.productEditorCursor.current.key),...automationJobRoutes(),...automationTargetRoutes(config.productEditorCursor.current.key), ...automationPolicyRoutes(config.productEditorCursor.current.key), ...automationHealthRoutes(config.productEditorCursor.current.key), ...automationRunRoutes(config.productEditorCursor.current.key)]);
  if (config.automationRuntimeEnabled && deps.automationDeviceUnitOfWork && deps.syncSessionRoutes) registerAutomationDeviceRoutes(app, {
    unitOfWork: deps.automationDeviceUnitOfWork, credentialVerifier: deps.syncSessionRoutes.credentialVerifier,
    allowedOrigins: deps.syncSessionRoutes.allowedOrigins, allowInsecureLoopback: deps.syncSessionRoutes.allowInsecureLoopback,
    trustedIngress: deps.syncSessionRoutes.trustedIngress, admission: deps.syncAdmissionPolicy,
  });
  if (config.automationRuntimeEnabled && deps.automationPairing && deps.mcpReadTransport?.oauthVerifier) registerAutomationWorkRoutes(app,{ pairing: deps.automationPairing,worker: deps.automationWorker,oauthVerifier: deps.mcpReadTransport.oauthVerifier,allowedOrigins: config.allowedOrigins });
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
