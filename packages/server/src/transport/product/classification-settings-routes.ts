import type { FastifyInstance } from 'fastify';
import type { IdentityUnitOfWork } from '../../modules/identity/index.js';
import { CLASSIFICATION_SETTINGS_V2_MEDIA, ClassificationSettingsError, classificationSettingsEtag, parseClassificationSettingsPatch, updateClassificationSettings,
  type ClassificationSettingsStore, type ClassificationSettingsUnitOfWork } from '../../modules/collections/index.js';
import { requireSessionActor } from '../session-auth.js';
import { requireMutationActor } from '../mutation-actor.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { ProductHttpError } from '../product-error.js';
import { consumeProductAdmission, type ProductAdmissionRateLimiter } from '../http-security.js';
import { readCollectionIdParam, readKnownCommandId, readRequiredIfMatch } from './collection-route-helpers.js';
import { mapCollectionMutationError, sendProductCommandReceiptOutcome } from '../product-command-mapping.js';

const PATH = '/api/v1/collections/:collectionId/classification-settings';
export interface ClassificationSettingsRoutesDependencies {
  readonly byokEnabled?:boolean;readonly autoEnabled?:boolean;
  readonly enabled: boolean; readonly allowedOrigins: readonly string[];
  readonly identityUnitOfWork: IdentityUnitOfWork; readonly rateLimiter: ProductAdmissionRateLimiter;
  readonly reads: Pick<ClassificationSettingsStore, 'loadOwned'>; readonly commands: ClassificationSettingsUnitOfWork;
  readonly csrfMatches?: (raw: string, expectedHash: string) => boolean;
}

export function registerClassificationSettingsRoutes(app: FastifyInstance, deps: ClassificationSettingsRoutesDependencies): void {
  if(!app.hasContentTypeParser(CLASSIFICATION_SETTINGS_V2_MEDIA))app.addContentTypeParser(CLASSIFICATION_SETTINGS_V2_MEDIA,{parseAs:'string'},app.getDefaultJsonParser('error','error'));
  const transport = {allowedQuery: [], cacheControl: 'private-no-store' as const};
  app.get(PATH, {exposeHeadRoute: false, config: {...productRouteMetadata('GET', PATH), productTransport: transport}}, async (request, reply) => {
    const {account} = await requireSessionActor(request, deps.identityUnitOfWork, {touch: false});
    if (!deps.enabled) throw notFound();
    await admit(deps.rateLimiter, account.id);
    const settings = await deps.reads.loadOwned({collectionId: readCollectionIdParam(request), ownerSubjectId: account.subjectId});
    const v2=request.headers.accept===CLASSIFICATION_SETTINGS_V2_MEDIA;
    if (v2 && !deps.byokEnabled) throw notFound();
    // D4: the v1 projection never exposes a BYOK mode or a profile binding. A
    // legacy row can still carry either even though the current patch parser
    // forbids the combination, so the guard checks it here too.
    if (!settings||!v2&&(settings.executionMode!=='server_managed'||settings.autoTagMode==='auto'||settings.providerProfileId!==null)) throw notFound();
    if(v2)reply.type(CLASSIFICATION_SETTINGS_V2_MEDIA);
    return reply.header('etag', classificationSettingsEtag(settings)).header('cache-control', 'private, no-store').send({...settings,contractVersion:v2?'2.0.0':'1.0.0'});
  });
  app.patch(PATH, {config: {...productRouteMetadata('PATCH', PATH), productTransport: {...transport, acceptedMediaTypes: ['application/json',CLASSIFICATION_SETTINGS_V2_MEDIA], bodyLimitBytes: 16*1024}}}, async (request, reply) => {
    const {account} = await requireMutationActor(request, {identityUnitOfWork: deps.identityUnitOfWork, allowedOrigins: deps.allowedOrigins, csrfMatches: deps.csrfMatches});
    if (!deps.enabled) throw notFound();
    await admit(deps.rateLimiter, account.id);
    try {
      const v2=request.headers['content-type']?.split(';',1)[0]?.trim().toLowerCase()===CLASSIFICATION_SETTINGS_V2_MEDIA;
      const acceptV2=request.headers.accept===CLASSIFICATION_SETTINGS_V2_MEDIA;
      if ((v2 || acceptV2) && !deps.byokEnabled) throw notFound();
      const capabilities={byok:v2&&deps.byokEnabled===true,auto:v2&&deps.autoEnabled===true};
      const input = {actor: {principalId: account.id, subjectId: account.subjectId}, collectionId: readCollectionIdParam(request),
        commandId: readKnownCommandId(request), ifMatch: readRequiredIfMatch(request), v2,autoEnabled:capabilities.auto,patch: parseClassificationSettingsPatch(request.body,capabilities)};
      const result = await deps.commands.execute(ports => updateClassificationSettings(ports, input));
      if (result.kind !== 'succeeded') return sendProductCommandReceiptOutcome(reply, result);
      if(v2)reply.type(CLASSIFICATION_SETTINGS_V2_MEDIA);
      return reply.header('etag', classificationSettingsEtag(result.settings)).header('cache-control', 'private, no-store').send(result.settings);
    } catch (error) {
      if (error instanceof ClassificationSettingsError) throw new ProductHttpError({statusCode: error.code === 'resource_not_found' ? 404 : 422, code: error.code, message: error.message});
      throw mapCollectionMutationError(error) ?? error;
    }
  });
}
function notFound() { return new ProductHttpError({statusCode: 404, code: 'resource_not_found', message: 'Classification settings are unavailable.'}); }
async function admit(limiter: ProductAdmissionRateLimiter, principal: string) {
  const result = await consumeProductAdmission(limiter, `classification-settings:${principal}`);
  if (result.kind === 'failed') throw new ProductHttpError({statusCode: 503, code: 'feature_temporarily_unavailable', message: 'Classification admission unavailable.'});
  if (result.kind === 'denied') throw new ProductHttpError({statusCode: 429, code: 'rate_limited', message: 'Classification settings rate limit exceeded.', retryAfterSeconds: result.retryAfterSeconds, headers: {'Retry-After': String(result.retryAfterSeconds)}});
}
