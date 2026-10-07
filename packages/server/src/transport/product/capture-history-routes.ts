import type { FastifyInstance } from 'fastify';
import type { IdentityUnitOfWork } from '../../modules/identity/index.js';
import { CaptureError, parseCaptureReport, type CaptureHistoryRuntime, type CaptureHistoryQuery } from '../../modules/collections/index.js';
import { requireSessionActor } from '../session-auth.js';
import { requireMutationActor } from '../mutation-actor.js';
import { readKnownCommandId } from './collection-route-helpers.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { ProductHttpError } from '../product-error.js';
import { consumeProductAdmission, type ProductAdmissionRateLimiter } from '../http-security.js';

export function registerCaptureHistoryRoutes(app: FastifyInstance, deps: {
  readonly runtime: CaptureHistoryRuntime; readonly identityUnitOfWork: IdentityUnitOfWork;
  readonly allowedOrigins: readonly string[]; readonly rateLimiter: ProductAdmissionRateLimiter;
}) {
  const path = '/api/v1/me/bookmark-captures';
  app.addHook('onReady', async () => { deps.runtime.start?.(); });
  app.addHook('preClose', async () => { await deps.runtime.stop?.(); });
  async function admit(accountId: string) {
    const result = await consumeProductAdmission(deps.rateLimiter, `capture-history:${accountId}`);
    if (result.kind !== 'allowed') throw new ProductHttpError({ statusCode: result.kind === 'denied' ? 429 : 503,
      code: result.kind === 'denied' ? 'rate_limited' : 'feature_temporarily_unavailable', message: 'Capture history is temporarily unavailable.' });
  }
  app.post(path, { config: { ...productRouteMetadata('POST', path), productTransport: { allowedQuery: [],
    cacheControl: 'private-no-store', acceptedMediaTypes: ['application/json'], bodyLimitBytes: 65536 } } }, async request => {
    const { account } = await requireMutationActor(request, deps); await admit(account.id);
    try { return await deps.runtime.report({ principalId: account.id, subjectId: account.subjectId }, readKnownCommandId(request), parseCaptureReport(request.body)); }
    catch (error) { throw mapError(error); }
  });
  for (const aggregate of [false, true]) {
    const route = aggregate ? `${path}/aggregate` : path;
    app.get(route, { config: { ...productRouteMetadata('GET', route), productTransport: { allowedQuery: [
      'from', 'to', 'timezone', 'deviceId', 'beforeAt', 'beforeId', 'q', 'captureId', 'source', 'collectionId', 'day'],
    cacheControl: 'private-no-store', rejectRequestBody: true } } }, async (request, reply) => {
      const actor = await requireSessionActor(request, deps.identityUnitOfWork, { touch: false }); await admit(actor.account.id);
      if ('session' in actor) reply.header('Known-Capture-Session', actor.session.id);
      const query = parseQuery(request.query as Record<string, unknown>), owner = { principalId: actor.account.id, subjectId: actor.account.subjectId };
      try { return aggregate ? await deps.runtime.aggregate(owner, query) : await deps.runtime.history(owner, query); }
      catch (error) { throw mapError(error); }
    });
  }
}
function parseQuery(raw: Record<string, unknown>): CaptureHistoryQuery {
  const to = raw.to === undefined ? Date.now() : Date.parse(String(raw.to)), from = raw.from === undefined ? to - 7 * 86400000 : Date.parse(String(raw.from));
  const timezone = String(raw.timezone ?? 'UTC');
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 90 * 86400000 || timezone.length > 100) throw mapError(new CaptureError('invalid_request'));
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { throw mapError(new CaptureError('invalid_request')); }
  for (const key of ['deviceId', 'captureId', 'collectionId', 'beforeId']) if (raw[key] !== undefined && (typeof raw[key] !== 'string' || !/^[A-Za-z0-9._~-]{1,128}$/u.test(raw[key]))) throw mapError(new CaptureError('invalid_request'));
  if (raw.q !== undefined && (typeof raw.q !== 'string' || raw.q.length > 100)) throw mapError(new CaptureError('invalid_request'));
  if (raw.source !== undefined && !['action-popup', 'manual-popup', 'context-page', 'context-link', 'batch'].includes(String(raw.source))) throw mapError(new CaptureError('invalid_request'));
  if (raw.day !== undefined && (typeof raw.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(raw.day))) throw mapError(new CaptureError('invalid_request'));
  if ((raw.beforeAt === undefined) !== (raw.beforeId === undefined) || (raw.beforeAt !== undefined && !Number.isFinite(Date.parse(String(raw.beforeAt))))) throw mapError(new CaptureError('invalid_request'));
  return { from, to, timezone, ...(raw.day ? { day: String(raw.day) } : {}), ...(raw.deviceId ? { deviceId: String(raw.deviceId) } : {}), ...(raw.captureId ? { captureId: String(raw.captureId) } : {}),
    ...(raw.collectionId ? { collectionId: String(raw.collectionId) } : {}), ...(raw.source ? { source: raw.source as CaptureHistoryQuery['source'] } : {}),
    ...(raw.q ? { q: String(raw.q) } : {}), ...(raw.beforeAt ? { before: [String(raw.beforeAt), String(raw.beforeId)] as const } : {}) };
}
function mapError(error: unknown): Error {
  if (error instanceof CaptureError) return new ProductHttpError({ statusCode: error.code === 'resource_not_found' ? 404 : error.code === 'command_id_reused' ? 409 : 400,
    code: error.code === 'capture_policy_unavailable' ? 'feature_temporarily_unavailable' : error.code, message: error.code });
  return error instanceof Error ? error : new Error('capture_history_unavailable');
}
