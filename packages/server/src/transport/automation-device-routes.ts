import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ExtensionCredentialEvidencePort } from '../modules/identity/index.js';
import { acceptIntakeReceipt, AutomationError, type AutomationDeviceUnitOfWork } from '../modules/automation/index.js';
import { canonicalCommandFingerprint } from '../modules/commands/index.js';
import { createMemorySyncAdmissionPolicy, syncAdmissionSubjectKey, type SyncAdmissionPolicy } from '../infrastructure/rate-limit/index.js';
import { createSyncTransportSecurity } from './colp-sync/sync-transport-security.js';
import { productRouteMetadata } from './product-route-manifest.js';
import { ProductHttpError } from './product-error.js';
import { productErrorStatus } from './product-codes.js';
import { readKnownCommandId } from './product/collection-route-helpers.js';
import { sendProductCommandReceiptOutcome } from './product-command-mapping.js';
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
  app.post(BASE + '/intake-receipts', { exposeHeadRoute: false,
    config: { ...productRouteMetadata('POST', BASE + '/intake-receipts'), productTransport: {
      allowedQuery: [], acceptedMediaTypes: ['application/json'], bodyLimitBytes: 32_768, cacheControl: 'private-no-store' } } },
  async (request, reply) => {
    if (!security.isSecure(request)) throw new ProductHttpError({ statusCode: 401, code: 'authentication_required', message: 'Secure transport required.' });
    const origin = header(request, 'origin');
    if (!deps.allowedOrigins.includes(origin)) throw new ProductHttpError({ statusCode: 403, code: 'insufficient_permission', message: 'Origin is not allowed.' });
    const pre = await admission.admitPreAuth({ purpose: 'push', clientKey: request.ip });
    if (pre.kind !== 'allowed') throw new ProductHttpError({ statusCode: pre.kind === 'denied' ? 429 : 503,
      code: pre.kind === 'denied' ? 'rate_limited' : 'feature_temporarily_unavailable', message: 'Device admission is unavailable.' });
    let credential;
    try { credential = await deps.credentialVerifier.verify({ authorization: header(request, 'authorization') }); }
    catch { throw new ProductHttpError({ statusCode: 401, code: 'authentication_required', message: 'Valid device bearer required.' }); }
    const allowed = await admission.admitSubject({ purpose: 'push', subjectKey: syncAdmissionSubjectKey({ credential }) });
    if (allowed.kind !== 'allowed') throw new ProductHttpError({ statusCode: allowed.kind === 'denied' ? 429 : 503,
      code: allowed.kind === 'denied' ? 'rate_limited' : 'feature_temporarily_unavailable', message: 'Device admission is unavailable.' });
    const sessionId = header(request, 'known-sync-session'), commandId = readKnownCommandId(request);
    try {
      const result = await deps.unitOfWork.execute({ credential, sessionId, origin }, async ports => {
        const binding = { principalId: ports.actor.accountId, commandScope: `${BASE}/intake-receipts:${ports.actor.deviceId}`, commandId };
        const fingerprint = canonicalCommandFingerprint({ method: 'POST', route: BASE + '/intake-receipts', mediaType: 'application/json', body: request.body, conditions: { sessionId } });
        const claim = await ports.receipts.claim(binding, fingerprint);
        if (claim.kind !== 'claimed') return { claim };
        const body = await acceptIntakeReceipt(ports, request.body);
        await ports.receipts.complete(binding, fingerprint, { status: 202, body: new TextEncoder().encode(JSON.stringify(body)),
          mediaType: 'application/json', contractVersion: '0.2.1-design', stableHeaders: { 'cache-control': 'private, no-store' } });
        return { body };
      });
      if ('claim' in result) {
        const claim = result.claim!;
        if (claim.kind === 'reused') throw new AutomationError('automation_command_conflict', 'Command identity reused.');
        return sendProductCommandReceiptOutcome(reply, claim.kind === 'replay' ? { kind: 'replay', ...claim.result } : claim);
      }
      return reply.code(202).header('cache-control', 'private, no-store').send(result.body);
    } catch (error) {
      if (error instanceof AutomationError) throw new ProductHttpError({ statusCode: productErrorStatus(error.code), code: error.code, message: error.message });
      throw error;
    }
  });
}
