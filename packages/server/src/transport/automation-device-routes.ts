import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ExtensionAuthError, type ExtensionCredentialEvidencePort } from '../modules/identity/index.js';
import { executeBridgeDeviceCommand } from '../modules/automation/index.js';
import { acceptIntakeReceipt, parseContract, AutomationError, type AutomationDeviceUnitOfWork } from '../modules/automation/index.js';
import { canonicalCommandFingerprint } from '../modules/commands/index.js';
import { rateLimitClientIp, createMemorySyncAdmissionPolicy, syncAdmissionSubjectKey, type SyncAdmissionPolicy } from '../infrastructure/rate-limit/index.js';
import { createSyncTransportSecurity } from './colp-sync/sync-transport-security.js';
import { productRouteMetadata } from './product-route-manifest.js';
import { ProductHttpError } from './product-error.js';
import { productErrorStatus } from './product-codes.js';
import { readKnownCommandId } from './product/collection-route-helpers.js';
import { sendProductCommandReceiptOutcome } from './product-command-mapping.js';
import { AUTOMATION_CONTRACT_VERSION } from '@know-n/colp/automation';
export interface AutomationDeviceRouteDeps {
  credentialVerifier: ExtensionCredentialEvidencePort; unitOfWork: AutomationDeviceUnitOfWork;
  allowedOrigins: readonly string[]; allowInsecureLoopback?: boolean; trustedIngress?: readonly string[]; admission?: SyncAdmissionPolicy;
}
const BASE = '/api/v1/automation-device';
function header(request: FastifyRequest, name: string): string {
  const values: string[] = [];
  for (let i = 0; i < request.raw.rawHeaders.length; i += 2)
    if (request.raw.rawHeaders[i]!.toLowerCase() === name) values.push(request.raw.rawHeaders[i + 1]!);
  if (values.length !== 1 || !values[0] || values[0].includes(','))
    throw new ProductHttpError({ statusCode: 400, code: 'invalid_request', message: `One ${name} header is required.` });
  return values[0];
}
export function registerAutomationDeviceRoutes(app: FastifyInstance, deps: AutomationDeviceRouteDeps): void {
  const security = createSyncTransportSecurity({ allowInsecureLoopback: deps.allowInsecureLoopback === true, trustedIngress: deps.trustedIngress });
  const admission = deps.admission ?? createMemorySyncAdmissionPolicy({ budgets: { push: { maxRequests: 120, windowMs: 60_000 } } });
  if (!deps.admission) app.addHook('onClose', async () => admission.close());
  for (const [method, path] of [['POST','/intake-receipts'], ['GET','/bundle'], ['POST','/bundle-acks'], ['GET','/bridge-requests'], ['POST','/bridge-results']] as const) app.route({
    method, url: BASE + path, exposeHeadRoute: false,
    config: { ...productRouteMetadata(method, BASE + path), productTransport: {
      allowedQuery: path === '/bundle' ? ['profile'] : [], acceptedMediaTypes: ['application/json'], rejectRequestBody: method === 'GET', bodyLimitBytes: 32_768, cacheControl: 'private-no-store' } },
  handler: async (request, reply) => {
    if (!security.isSecure(request)) throw new ProductHttpError({ statusCode: 401, code: 'authentication_required', message: 'Secure transport required.' });
    const origin = header(request, 'origin');
    if (!deps.allowedOrigins.includes(origin)) throw new ProductHttpError({ statusCode: 403, code: 'insufficient_permission', message: 'Origin is not allowed.' });
    const pre = await admission.admitPreAuth({ purpose: 'push', clientKey: rateLimitClientIp(request.ip) });
    if (pre.kind !== 'allowed') throw new ProductHttpError({ statusCode: pre.kind === 'denied' ? 429 : 503,
      code: pre.kind === 'denied' ? 'rate_limited' : 'feature_temporarily_unavailable', message: 'Device admission is unavailable.' });
    let credential;
    try { credential = await deps.credentialVerifier.verify({ authorization: header(request, 'authorization') }); }
    catch (error) {
      if (error instanceof ProductHttpError) throw error;
      if (error instanceof ExtensionAuthError && error.reason !== 'verifier_unavailable')
        throw new ProductHttpError({ statusCode: 401, code: 'authentication_required', message: 'Valid device bearer required.' });
      throw new ProductHttpError({ statusCode: 503, code: 'feature_temporarily_unavailable', message: 'Device authentication is temporarily unavailable.' });
    }
    const allowed = await admission.admitSubject({ purpose: 'push', subjectKey: syncAdmissionSubjectKey({ credential }) });
    if (allowed.kind !== 'allowed') throw new ProductHttpError({ statusCode: allowed.kind === 'denied' ? 429 : 503,
      code: allowed.kind === 'denied' ? 'rate_limited' : 'feature_temporarily_unavailable', message: 'Device admission is unavailable.' });
    const installationBridge = (path === '/bridge-requests' || path === '/bridge-results') && request.headers['known-sync-session'] === undefined;
    const sessionId = installationBridge ? '' : header(request, 'known-sync-session'), commandId = method === 'GET' ? '' : readKnownCommandId(request);
    try {
      const result = installationBridge ? await executeBridgeDeviceCommand(deps.unitOfWork, {
        credential, origin, replicaId: header(request, 'known-sync-replica-id'), replicaProof: header(request, 'known-sync-replica-proof'),
        method, commandId, body: request.body,
      }) : await deps.unitOfWork.execute({ credential, sessionId, origin }, async ports => {
        if (method === 'GET') return { body: path === '/bridge-requests' ? await ports.bridge!.pending() : await ports.bundle((request.query as { profile?: string }).profile ?? 'browser-bounded-v1') };
        const binding = { principalId: ports.actor.accountId, commandScope: `${BASE}${path}:${ports.actor.deviceId}`, commandId };
        const fingerprint = canonicalCommandFingerprint({ method: 'POST', route: BASE + path, mediaType: 'application/json', body: request.body, conditions: { sessionId } });
        const claim = await ports.receipts.claim(binding, fingerprint);
        if (claim.kind !== 'claimed') return { claim };
        const body = path === '/bridge-results' ? await ports.bridge!.complete(request.body) : path === '/intake-receipts' ? await acceptIntakeReceipt(ports, request.body)
          : await ports.acknowledge(parseContract('BundleAckInput', request.body));
        await ports.receipts.complete(binding, fingerprint, { status: path === '/intake-receipts' ? 202 : 200, body: new TextEncoder().encode(JSON.stringify(body)),
          mediaType: 'application/json', contractVersion: AUTOMATION_CONTRACT_VERSION, stableHeaders: { 'cache-control': 'private, no-store',
            ...('revision' in body ? { etag: `"${body.revision}"` } : {}) } });
        return { body };
      });
      if ('claim' in result) {
        const claim = result.claim!;
        if (claim.kind === 'reused') throw new AutomationError('automation_command_conflict', 'Command identity reused.');
        return sendProductCommandReceiptOutcome(reply, claim.kind === 'replay' ? { kind: 'replay', ...claim.result } : claim);
      }
      if (result.body && 'revision' in result.body) reply.header('etag', `"${result.body.revision}"`);
      return reply.code(path === '/intake-receipts' ? 202 : 200).header('cache-control', 'private, no-store').send(result.body);
    } catch (error) {
      if (error instanceof AutomationError) throw new ProductHttpError({ statusCode: productErrorStatus(error.code), code: error.code, message: error.message });
      throw error;
    }
  } });
}
