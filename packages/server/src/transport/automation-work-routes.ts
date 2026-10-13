import type { FastifyInstance,FastifyRequest } from 'fastify';
import { AutomationError,type WorkPrincipal,type WorkerPairingPort,type AutomationWorkerService } from '../modules/automation/index.js';
import { isMcpOauthVerificationResult,McpOauthVerificationError,type McpOauthVerifier } from '../modules/mcp/index.js';
import { rejectMixedCarriers,readSingleBearer } from './product-actor.js';
import { productRouteMetadata } from './product-route-manifest.js';
import { ProductHttpError } from './product-error.js';
import { productErrorStatus } from './product-codes.js';
import { sendProductCommandReceiptOutcome } from './product-command-mapping.js';
import { readKnownCommandId } from './product/collection-route-helpers.js';

export interface AutomationWorkRouteDeps { pairing: WorkerPairingPort; worker?: AutomationWorkerService; oauthVerifier: McpOauthVerifier; allowedOrigins: readonly string[]; admit?: (actor: WorkPrincipal) => Promise<void> }
export async function requireAutomationWorkerActor(request: FastifyRequest,deps: Pick<AutomationWorkRouteDeps,'oauthVerifier' | 'allowedOrigins'>): Promise<WorkPrincipal> {
  rejectMixedCarriers(request);
  const origin = request.headers.origin;
  if (origin !== undefined && (typeof origin !== 'string' || !deps.allowedOrigins.includes(origin)))
    throw new ProductHttpError({ statusCode: 403,code: 'insufficient_permission',message: 'Origin is not allowed.' });
  const token = readSingleBearer(request);
  let verified;
  try { verified = await deps.oauthVerifier.verify({ authorization: `Bearer ${token}`,requiredScopes: ['automation:work'] }); }
  catch (error) {
    if (error instanceof McpOauthVerificationError && error.reason === 'missing_scope') throw new ProductHttpError({ statusCode: 403,code: 'insufficient_permission',message: 'The credential requires automation:work.' });
    throw new ProductHttpError({ statusCode: 401,code: 'authentication_required',message: 'A valid worker credential is required.' });
  }
  if (!isMcpOauthVerificationResult(verified)) throw new ProductHttpError({ statusCode: 401,code: 'authentication_required',message: 'Verified worker evidence is required.' });
  return { accountId: verified.binding.principalId,subjectId: verified.accountSubjectId,clientId: verified.binding.clientId,
    credentialBindingId: verified.binding.credentialBindingId,resourceAudience: verified.binding.resourceAudience,securityEpoch: verified.binding.securityEpoch,
    scopes: verified.scopes,credentialDigest: verified.credentialDigest,expiresAt: verified.expiresAt.toISOString(),issuedAtSeconds: verified.issuedAtSeconds,accountSecurityEpoch: verified.accountSecurityEpoch };
}
export function automationWorkError(error: unknown): never {
  if (error instanceof AutomationError) throw new ProductHttpError({ statusCode: productErrorStatus(error.code),code: error.code,message: error.message,
    ...((error.retryAfterSeconds || error.code === 'automation_paused') ? { retryAfterSeconds: error.retryAfterSeconds ?? 30,headers: { 'Retry-After': String(error.retryAfterSeconds ?? 30) } } : {}) });
  throw error;
}
export function registerAutomationWorkRoutes(app: FastifyInstance,deps: AutomationWorkRouteDeps): void {
  const path = '/api/v1/automation-work/pairings/claim';
  app.post(path,{ config: { ...productRouteMetadata('POST',path),productTransport: { allowedQuery: [],cacheControl: 'private-no-store',acceptedMediaTypes: ['application/json'],bodyLimitBytes: 16_384 } } },async (request,reply) => {
    const actor = await requireAutomationWorkerActor(request,deps),commandId = readKnownCommandId(request);
    try {
      const outcome = await deps.pairing.pair(actor,request.body,commandId);
      if (outcome.kind === 'succeeded') return reply.header('cache-control','private, no-store').send(outcome.target);
      if (outcome.kind === 'reused') throw new AutomationError('automation_command_conflict','Command identity was reused with different input.');
      return sendProductCommandReceiptOutcome(reply,outcome.kind === 'replay' ? { kind: 'replay',...outcome.result } : outcome);
    } catch (error) { return automationWorkError(error); }
  });
  if (!deps.worker) return;
  const work = deps.worker;
  const routes = [
    { method: 'GET' as const,path: '/jobs',query: ['targetId','cursor','limit'],action: (a: WorkPrincipal,r: FastifyRequest) => work.list(a,r.query as { targetId?: string; cursor?: string; limit?: string }) },
    { method: 'GET' as const,path: '/jobs/:jobId',query: ['deliveryHandle'],action: (a: WorkPrincipal,r: FastifyRequest) => work.get(a,jobId(r),String((r.query as Record<string,string>).deliveryHandle ?? '')) },
    { method: 'GET' as const,path: '/jobs/:jobId/inputs',query: ['deliveryHandle','cursor','limit'],action: (a: WorkPrincipal,r: FastifyRequest) => work.inputs(a,jobId(r),r.query as { deliveryHandle: string; cursor?: string; limit?: string }) },
    ...(['claim','heartbeat','results','failures'] as const).map(op => ({ method: 'POST' as const,path: `/jobs/:jobId/${op}`,query: [],
      action: (a: WorkPrincipal,r: FastifyRequest) => work.mutate(a,jobId(r),op === 'results' ? 'submit' : op === 'failures' ? 'fail' : op,r.body,readKnownCommandId(r)) })),
  ];
  for (const route of routes) {
    const url = '/api/v1/automation-work'+route.path;
    app.route({ method: route.method,url,exposeHeadRoute: false,config: { ...productRouteMetadata(route.method,url),productTransport: { allowedQuery: route.query,cacheControl: 'private-no-store',
      ...(route.method === 'GET' ? { rejectRequestBody: true } : { acceptedMediaTypes: ['application/json'],bodyLimitBytes: 262_144 }) } },handler: async (request,reply) => {
      const actor = await requireAutomationWorkerActor(request,deps);
      try { await deps.admit?.(actor);return reply.header('cache-control','private, no-store').send(await route.action(actor,request)); }
      catch (error) { return automationWorkError(error); }
    } });
  }
}
function jobId(request: FastifyRequest): string {
  const id = (request.params as Record<string,string>).jobId;
  if (!id || !/^[A-Za-z0-9._~-]{1,128}$/u.test(id)) throw new AutomationError('invalid_request','Invalid job identity.');return id;
}
