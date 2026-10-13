import { CollectionExportCapacityError } from '../../modules/collections/index.js';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { canonicalCommandFingerprint, type ProductCommandClaim } from '../../modules/commands/index.js';
import type { IdentityUnitOfWork } from '../../modules/identity/index.js';
import { createRule, replaceRule, validateRule, saveBinding, requireRule, requireBinding, requireEtag } from '../../modules/automation/index.js';
import { previewRule } from '../../modules/automation/index.js';
import { revalidateRule, setLifecycle, setPause } from '../../modules/automation/index.js';
import type { AutomationPorts, AutomationUnitOfWork } from '../../modules/automation/index.js';
import type { AutomationActor } from '../../modules/automation/index.js';
import { AutomationError } from '../../modules/automation/index.js';
import { requireMutationActor } from '../mutation-actor.js';
import { requireSessionActor } from '../session-auth.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { readKnownCommandId, readRequiredIfMatch } from './collection-route-helpers.js';
import { httpCommandScopeV1 } from '../http-command-scope.js';
import { ProductHttpError } from '../product-error.js';
import { productErrorStatus } from '../product-codes.js';
import { sendProductCommandReceiptOutcome, mapProductDatabaseError } from '../product-command-mapping.js';
import { DatabaseOperationError } from '../../infrastructure/database/errors.js';
import { createAutomationPagination } from './automation-pagination.js';

export interface AutomationRoutesDeps {
  identityUnitOfWork: IdentityUnitOfWork;
  unitOfWork: AutomationUnitOfWork;
  allowedOrigins: readonly string[];
  cursorKey: string;
}
export interface AutomationRouteContext { ports: AutomationPorts; actor: AutomationActor; request: FastifyRequest; ifMatch: string }
export interface AutomationResponse { body?: unknown; status?: number; etag?: string }
export interface AutomationRoute {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'; path: string; ifMatch?: boolean; query?: readonly string[]; noBody?: boolean;
  action(context: AutomationRouteContext): Promise<AutomationResponse>;
}
const BASE = '/api/v1/me/automations';
const id = (request: FastifyRequest, name: string): string => {
  const value = (request.params as Record<string, string>)[name];
  if (!value || !/^[A-Za-z0-9._~-]{1,128}$/u.test(value)) throw new AutomationError('invalid_request', 'Invalid resource identity.'); return value;
};
export const automationView = (body: unknown, status = 200): AutomationResponse => ({ body, status,
  ...(body && typeof body === 'object' && 'revision' in body ? { etag: `"${String(body.revision)}"` } : {}) });

export function registerAutomationRoutes(app: FastifyInstance, deps: AutomationRoutesDeps, additional: readonly AutomationRoute[] = []): void {
  const pagination = createAutomationPagination(deps.cursorKey);
  const routes: AutomationRoute[] = [
    { method: 'GET', path: '/capabilities', action: async ({ ports }) => automationView({ contractVersion: '0.2.1-design', ruleApiVersions: ['colp.automation/v1'],
      runtimeProfiles: ports.runtimeEnabled ? ['browser-bounded-v1'] : [], triggerModes: ports.runtimeEnabled ? ['each'] : [], taskTypes: [], eventsEnabled: false, limits: { maxRules: 500, maxExpressionBytes: 4_194_304, maxTasksPerRule: 8 } }) },
    { method: 'POST', path: '/rules/validate', action: async ({ ports, actor, request }) => automationView(await validateRule(ports, actor, request.body)) },
    { method: 'POST', path: '/rules/preview', action: async ({ ports, actor, request }) => automationView(await previewRule(ports, actor, request.body)) },
    { method: 'POST', path: '/rules', action: async ({ ports, actor, request }) => automationView(await createRule(ports, actor, request.body), 201) },
    { method: 'GET', path: '/rules', query: ['limit', 'cursor'], action: async ({ ports, actor, request }) => {
      const now = await ports.now(), { limit, after } = pagination.read(request.query as Record<string, string>, actor.accountId, 'rules', now);
      const rows = await ports.rules.list(actor.accountId, after, limit + 1), last = rows[limit - 1], paused = (await ports.settings.get(actor.accountId)).paused;
      if (ports.runtimeEnabled) for (const row of rows.slice(0, limit)) row.view.effectiveState = (await revalidateRule(ports, actor, row.view.id)).effectiveState;
      return automationView({ items: rows.slice(0, limit).map((row) => ({ ...row.view, effectiveState: row.view.desiredState === 'enabled' && paused ? 'paused' : row.view.effectiveState })),
        nextCursor: rows.length > limit && last ? pagination.next(actor.accountId, 'rules', limit, { createdAt: last.sortCreatedAt, id: last.view.id }, now) : null });
    } },
    { method: 'GET', path: '/rules/:ruleId', noBody: true, action: async ({ ports, actor, request }) => {
      const stored = await requireRule(ports, actor, id(request, 'ruleId'));
      if (stored.view.desiredState === 'enabled' && (await ports.settings.get(actor.accountId)).paused) stored.view.effectiveState = 'paused';
      if (ports.runtimeEnabled) stored.view.effectiveState = (await revalidateRule(ports, actor, stored.view.id)).effectiveState;
      return automationView(stored.view);
    } },
    { method: 'PUT', path: '/rules/:ruleId', ifMatch: true, action: async ({ ports, actor, request, ifMatch }) => automationView(await replaceRule(ports, actor, id(request, 'ruleId'), request.body, ifMatch)) },
    { method: 'POST', path: '/rules/:ruleId/lifecycle', ifMatch: true, action: async ({ ports, actor, request, ifMatch }) => automationView(await setLifecycle(ports, actor, id(request, 'ruleId'), request.body, ifMatch)) },
    { method: 'DELETE', path: '/rules/:ruleId', ifMatch: true, noBody: true, action: async ({ ports, actor, request, ifMatch }) => automationView(await setLifecycle(ports, actor,
      id(request, 'ruleId'), { state: 'archived', pendingRuns: 'cancel', reason: 'Owner deleted rule configuration.' }, ifMatch)) },
    { method: 'POST', path: '/binding-sets', action: async ({ ports, actor, request }) => automationView(await saveBinding(ports, actor, request.body), 201) },
    { method: 'PUT', path: '/binding-sets/:bindingSetId', ifMatch: true, action: async ({ ports, actor, request, ifMatch }) => automationView(await saveBinding(ports, actor, request.body, id(request, 'bindingSetId'), ifMatch)) },
    { method: 'GET', path: '/binding-sets/:bindingSetId', noBody: true, action: async ({ ports, actor, request }) => automationView(await requireBinding(ports, actor, id(request, 'bindingSetId'))) },
    { method: 'GET', path: '/binding-sets', query: ['limit', 'cursor'], action: async ({ ports, actor, request }) => {
      const now = await ports.now(), { limit, after } = pagination.read(request.query as Record<string, string>, actor.accountId, 'bindings', now);
      const rows = await ports.bindings.list(actor.accountId, after, limit + 1), last = rows[limit - 1];
      return automationView({ items: rows.slice(0, limit).map((row) => row.view), nextCursor: rows.length > limit && last
        ? pagination.next(actor.accountId, 'bindings', limit, { createdAt: last.createdAt, id: last.view.id }, now) : null });
    } },
    { method: 'DELETE', path: '/binding-sets/:bindingSetId', ifMatch: true, noBody: true, action: async ({ ports, actor, request, ifMatch }) => {
      const binding = await requireBinding(ports, actor, id(request, 'bindingSetId')); requireEtag(binding.revision, ifMatch);
      if (!await ports.bindings.delete(actor.accountId, binding.id)) throw new AutomationError('automation_binding_unavailable', 'Binding is referenced by immutable rule history.');
      return { status: 204 };
    } },
    { method: 'GET', path: '/pause', noBody: true, action: async ({ ports, actor }) => automationView(await ports.settings.get(actor.accountId)) },
    { method: 'POST', path: '/pause', ifMatch: true, action: async ({ ports, actor, request, ifMatch }) => automationView(await setPause(ports, actor, request.body, ifMatch)) },
    { method: 'GET', path: '/export', noBody: true, action: async ({ ports, actor }) => automationView(await ports.export(actor.accountId)) },
    ...additional,
  ];
  for (const route of routes) registerAutomationRoute(app, deps, route);
}
function registerAutomationRoute(app: FastifyInstance, deps: AutomationRoutesDeps, route: AutomationRoute): void {
  const url = BASE + route.path, mutation = route.method !== 'GET';
  app.route({ method: route.method, url, exposeHeadRoute: false,
    config: { ...productRouteMetadata(route.method, url), productTransport: { allowedQuery: route.query ?? [], cacheControl: 'private-no-store',
      ...(route.noBody || !mutation ? { rejectRequestBody: true } : { acceptedMediaTypes: ['application/json'], bodyLimitBytes: 4_194_304 }) } },
    handler: async (request, reply) => {
      const authenticated = mutation ? await requireMutationActor(request, deps) : await requireSessionActor(request, deps.identityUnitOfWork, { touch: false });
      const actor = { accountId: authenticated.account.id, subjectId: authenticated.account.subjectId };
      const commandId = mutation ? readKnownCommandId(request) : '', ifMatch = route.ifMatch ? readRequiredIfMatch(request) : '';
      try {
        const result = await deps.unitOfWork.execute(actor, async (ports) => {
          const binding = { principalId: actor.accountId, commandScope: httpCommandScopeV1(route.method, request.url.split('?')[0]!), commandId };
          const fingerprint = canonicalCommandFingerprint({ method: route.method, route: url, resource: request.url.split('?')[0],
            mediaType: mutation && !route.noBody ? 'application/json' : '', body: request.body ?? null, query: request.query, conditions: { ifMatch } });
          if (mutation) {
            const claim = await ports.receipts.claim(binding, fingerprint);
            if (claim.kind !== 'claimed') return { claim };
          }
          const response = await route.action({ ports, actor, request, ifMatch });
          if (mutation) await ports.receipts.complete(binding, fingerprint, { status: response.status ?? 200,
            body: new TextEncoder().encode(response.body === undefined ? '' : JSON.stringify(response.body)), mediaType: 'application/json',
            contractVersion: '1.95.0', stableHeaders: { 'cache-control': 'private, no-store', ...(response.etag ? { etag: response.etag } : {}) } });
          return { response };
        });
        if ('claim' in result) return replay(reply, result.claim!);
        const response = result.response!;
        if (response.etag) reply.header('etag', response.etag);
        return reply.code(response.status ?? 200).header('cache-control', 'private, no-store').send(response.body);
      } catch (error) {
        if (error instanceof AutomationError) throw new ProductHttpError({ statusCode: productErrorStatus(error.code), code: error.code, message: error.message,
          fieldErrors: error.fieldErrors, currentEtag: error.currentEtag, ...(error.code === 'precondition_failed' ? { recovery: 'refresh_and_retry', precondition: 'resource' } : {}) });
        if (error instanceof CollectionExportCapacityError) throw new ProductHttpError({ statusCode: 413, code: 'payload_too_large', message: error.message });
        if (error instanceof DatabaseOperationError) throw mapProductDatabaseError(error); throw error;
      }
    },
  });
}
function replay(reply: FastifyReply, claim: Exclude<ProductCommandClaim, { kind: 'claimed' }>) {
  if (claim.kind === 'reused') throw new AutomationError('automation_command_conflict', 'Command identity was reused with different input.');
  if (claim.kind === 'replay') return sendProductCommandReceiptOutcome(reply, { kind: 'replay', ...claim.result });
  return sendProductCommandReceiptOutcome(reply, claim.kind === 'expired' ? { kind: 'expired' } : claim);
}
