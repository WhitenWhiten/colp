import { registerClassificationProfileRoutes } from '../../src/transport/product/classification-profile-routes.js';
import { registerClassificationSettingsRoutes,type ClassificationSettingsRoutesDependencies } from '../../src/transport/product/classification-settings-routes.js';
import type { ClassificationProfilesRuntime } from '../../src/modules/collections/index.js';
import { registerClassificationRunRoutes } from '../../src/transport/product/classification-run-routes.js';
import type { ClassificationRunRuntime } from '../../src/modules/collections/index.js';
import { registerClassifyInboxRoutes, type ClassifyInboxRoutesDependencies } from '../../src/transport/product/classify-inbox-routes.js';
import Fastify from 'fastify';
import type { IdentityPorts, IdentityUnitOfWork } from '../../src/modules/identity/index.js';
import { registerClassificationConfirmationRoutes } from '../../src/transport/product/classification-confirmation-routes.js';
import type { ClassificationConfirmationUnitOfWork, ClassificationPreviewRuntime } from '../../src/modules/collections/index.js';
import { registerClassificationPreviewRoutes } from '../../src/transport/product/classification-preview-routes.js';
import { installProductAdmission, parseStrictQuery } from '../../src/transport/product-admission.js';
import { installProductRouteManifestChecks } from '../../src/transport/product-route-manifest.js';
import { ProductHttpError, sendProductError } from '../../src/transport/product-error.js';
import { createFixedWindowRateLimiter, type ProductAdmissionRateLimiter } from '../../src/transport/http-security.js';

/** Fixed session identity; runtime can be real PostgreSQL or a controlled failure stub. */
export function classificationHttpHarness(runtime: Pick<ClassificationPreviewRuntime, 'preview'>,
  options: {profiles?:ClassificationProfilesRuntime;settings?:Pick<ClassificationSettingsRoutesDependencies,'commands'|'reads'>;runs?:ClassificationRunRuntime;enabled?: boolean;tagsEnabled?:boolean; principalId?: string; subjectId?: string; limiter?: ProductAdmissionRateLimiter; confirmation?: ClassificationConfirmationUnitOfWork; inboxAccept?: ClassifyInboxRoutesDependencies['accept']} = {}) {
  const now = new Date();
  const identity = {sessions: {findByTokenHash: async () => ({id:'s',accountId:options.principalId ?? 'account',csrfTokenHash:'csrf-hash',securityEpoch:1n,createdAt:now,lastSeenAt:now,idleExpiresAt:new Date(now.getTime()+60000),absoluteExpiresAt:new Date(now.getTime()+60000),revokedAt:null}),touch:async()=>true},
    accounts:{findById:async()=>({id:options.principalId ?? 'account',subjectId:options.subjectId ?? 'owner',status:'active',securityEpoch:1n,createdAt:now,deletedAt:null})},clock:{now:async()=>now}} as unknown as IdentityPorts;
  const identityUnitOfWork: IdentityUnitOfWork = {execute: work => work(identity)};
  const app = Fastify({exposeHeadRoutes:false,routerOptions:{maxParamLength:128,querystringParser:parseStrictQuery}});
  installProductRouteManifestChecks(app,{requireComplete:false}); installProductAdmission(app);
  app.setErrorHandler((error, request, reply) => sendProductError(request,reply,error instanceof ProductHttpError ? error : new ProductHttpError({statusCode:500,code:'internal_error',message:'test failure'})));
  registerClassificationPreviewRoutes(app,{enabled:options.enabled ?? true,allowedOrigins:['https://app.example.test'],identityUnitOfWork,runtime,
    csrfMatches:raw=>raw==='csrf',rateLimiter:options.limiter ?? createFixedWindowRateLimiter({maxRequests:100,windowMs:60000})});
  if(options.profiles)registerClassificationProfileRoutes(app,{enabled:options.enabled??true,allowedOrigins:['https://app.example.test'],identityUnitOfWork,
    runtime:options.profiles,csrfMatches:raw=>raw==='csrf',rateLimiter:createFixedWindowRateLimiter({maxRequests:100,windowMs:60000})});
  if(options.settings)registerClassificationSettingsRoutes(app,{enabled:true,byokEnabled:true,...options.settings,allowedOrigins:['https://app.example.test'],identityUnitOfWork,
    csrfMatches:raw=>raw==='csrf',rateLimiter:createFixedWindowRateLimiter({maxRequests:100,windowMs:60000})});
  if(options.runs)registerClassificationRunRoutes(app,{enabled:options.enabled??true,allowedOrigins:['https://app.example.test'],identityUnitOfWork,
    runtime:options.runs,csrfMatches:raw=>raw==='csrf',rateLimiter:createFixedWindowRateLimiter({maxRequests:100,windowMs:60000})});
  if (options.confirmation) registerClassificationConfirmationRoutes(app,{enabled:options.enabled ?? true,tagsEnabled:options.tagsEnabled,allowedOrigins:['https://app.example.test'],identityUnitOfWork,
    commands:options.confirmation,csrfMatches:raw=>raw==='csrf',rateLimiter:options.limiter ?? createFixedWindowRateLimiter({maxRequests:100,windowMs:60000})});
  if (options.inboxAccept) registerClassifyInboxRoutes(app,{enabled:true,classificationTagsEnabled:options.tagsEnabled,allowedOrigins:['https://app.example.test'],identityUnitOfWork,
    accept:options.inboxAccept,query:{} as ClassifyInboxRoutesDependencies['query'],skip:{execute:async()=>{throw new Error('unused skip');}},
    csrfMatches:raw=>raw==='csrf',timeoutMs:2000,rateLimiter:createFixedWindowRateLimiter({maxRequests:100,windowMs:60000})});
  return app;
}
export const classificationAuthHeaders = {cookie:'__Host-known_session=test',origin:'https://app.example.test','x-csrf-token':'csrf'};
