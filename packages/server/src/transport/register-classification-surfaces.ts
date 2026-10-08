import { registerCaptureLearningRoutes } from './product/capture-learning-routes.js';
import { registerCaptureHistoryRoutes } from './product/capture-history-routes.js';
import { registerCaptureRoutes } from './product/capture-routes.js';
import { registerClassificationProfileRoutes } from './product/classification-profile-routes.js';
import { registerClassificationRunRoutes } from './product/classification-run-routes.js';
import { classificationProductAllowedOrigins } from './classification-extension-cors.js';
import type { FastifyInstance } from 'fastify';
import type { AppDependencies } from './app-dependencies.js';
import type { ProductAdmissionRateLimiter } from './http-security.js';
import type { ProductSurfaceRateLimitPurpose } from '../infrastructure/rate-limit/index.js';
import { registerClassifyInboxRoutes } from './product/classify-inbox-routes.js';
import { registerClassificationConfirmationRoutes } from './product/classification-confirmation-routes.js';
import { registerClassificationPreviewRoutes } from './product/classification-preview-routes.js';
import { registerClassificationSettingsRoutes } from './product/classification-settings-routes.js';

export function registerClassificationProductSurfaces(app: FastifyInstance, deps: AppDependencies,
  resolveProductRouteRateLimiter: (purpose: ProductSurfaceRateLimitPurpose, limiter: ProductAdmissionRateLimiter | undefined,
    budget: {readonly maxRequests: number; readonly windowMs: number}) => ProductAdmissionRateLimiter): void {
  const {config, identityUnitOfWork, classifyInboxQuery, classifyInboxSkip, classifyInboxAccept, classifyInboxRateLimiter} = deps;
  const defaultProductRouteBudget = {maxRequests: 120, windowMs: 60000};
  if (identityUnitOfWork && deps.captureLearning) registerCaptureLearningRoutes(app, { runtime: deps.captureLearning, identityUnitOfWork, allowedOrigins: classificationProductAllowedOrigins(config) });
  if (identityUnitOfWork && deps.captureHistory) registerCaptureHistoryRoutes(app, { runtime: deps.captureHistory, identityUnitOfWork,
    allowedOrigins: classificationProductAllowedOrigins(config), rateLimiter: resolveProductRouteRateLimiter('classification-preview', deps.classificationPreviewRateLimiter, defaultProductRouteBudget) });
  if (identityUnitOfWork && deps.captureRuntime) registerCaptureRoutes(app, { runtime: deps.captureRuntime, identityUnitOfWork,
    allowedOrigins: classificationProductAllowedOrigins(config), rateLimiter: resolveProductRouteRateLimiter('classification-preview', deps.classificationPreviewRateLimiter, defaultProductRouteBudget) });
  const byokActive = config.classification?.enabled === true && config.classification?.byokEnabled === true;
  if (identityUnitOfWork && deps.classificationProfiles && byokActive) {
    app.addHook('onReady', async () => deps.classificationProfiles!.start());
    app.addHook('preClose', async () => deps.classificationProfiles!.stop());
    registerClassificationProfileRoutes(app, {
      enabled: true,
      allowedOrigins: classificationProductAllowedOrigins(config),
      identityUnitOfWork,
      runtime: deps.classificationProfiles,
      rateLimiter: resolveProductRouteRateLimiter('classification-profile', deps.classificationProfilesRateLimiter, { maxRequests: 20, windowMs: 60000 })
    });
  }
  if(identityUnitOfWork&&deps.classificationRuns){
    app.addHook('onReady',async()=>deps.classificationRuns!.start());
    app.addHook('preClose',async()=>deps.classificationRuns!.stop());
    registerClassificationRunRoutes(app,{enabled:(config.classification?.enabled??false)&&(config.classification?.batchEnabled??false),
      allowedOrigins:config.allowedOrigins,identityUnitOfWork,runtime:deps.classificationRuns,
      rateLimiter:resolveProductRouteRateLimiter('classification-run',deps.classificationRunsRateLimiter,defaultProductRouteBudget)});
  }
  if(deps.classificationPreview){
    app.addHook('onReady',async()=>{deps.classificationPreview!.start();});
    app.addHook('preClose',async()=>{await deps.classificationPreview!.stop();});
  }
  if (identityUnitOfWork && deps.classificationSettings) {
    registerClassificationSettingsRoutes(app, {
      enabled: config.classification?.enabled ?? false, allowedOrigins: classificationProductAllowedOrigins(config), identityUnitOfWork,
      ...deps.classificationSettings, byokEnabled: byokActive, autoEnabled: config.classification?.autoTagsEnabled === true && deps.classificationSettings.autoEnabled === true,
      rateLimiter: resolveProductRouteRateLimiter('classification-settings', deps.classificationSettingsRateLimiter, defaultProductRouteBudget),
    });
  }
  if (identityUnitOfWork && deps.classificationPreview) {
    registerClassificationPreviewRoutes(app, {
      enabled: config.classification?.enabled ?? false, allowedOrigins: classificationProductAllowedOrigins(config), identityUnitOfWork,
      runtime: deps.classificationPreview,
      rateLimiter: resolveProductRouteRateLimiter('classification-preview', deps.classificationPreviewRateLimiter, defaultProductRouteBudget),
    });
  }
  if (identityUnitOfWork && deps.classificationConfirmation) {
    registerClassificationConfirmationRoutes(app, {
      enabled: config.classification?.enabled ?? false, allowedOrigins: classificationProductAllowedOrigins(config), identityUnitOfWork,
      tagsEnabled: config.classification?.tagsEnabled ?? false, commands: deps.classificationConfirmation,
      rateLimiter: resolveProductRouteRateLimiter('classification-confirmation', deps.classificationConfirmationRateLimiter, defaultProductRouteBudget),
    });
  }
  const classifyInboxPorts = [classifyInboxQuery, classifyInboxSkip, classifyInboxAccept];
  if (classifyInboxPorts.some(Boolean) && classifyInboxPorts.some((port) => port === undefined)) {
    throw new TypeError('Classify-inbox query, skip, and accept production ports must be configured together');
  }
  if (identityUnitOfWork && classifyInboxQuery && classifyInboxSkip && classifyInboxAccept) {
    registerClassifyInboxRoutes(app, {
      enabled: config.classifyInbox?.enabled ?? false,
      classificationTagsEnabled: (config.classification?.enabled ?? false) && (config.classification?.tagsEnabled ?? false),
      allowedOrigins: config.allowedOrigins,
      identityUnitOfWork,
      query: classifyInboxQuery,
      skip: classifyInboxSkip,
      accept: classifyInboxAccept,
      rateLimiter: resolveProductRouteRateLimiter(
        'classify-inbox', classifyInboxRateLimiter, defaultProductRouteBudget,
      ),
      timeoutMs: 2_000,
    });
  }
}
