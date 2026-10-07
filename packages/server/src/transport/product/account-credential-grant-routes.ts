import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AccountCredentialCommandError,
  authorizePlanWithCredentialGrant,
  createCredentialGrant,
  getCredentialPlanView,
  getOwnedGrant,
  listOwnedGrants,
  parseAuthorizePlanBody,
  parseGrantInput,
  parseGrantListQuery,
  parseGrantOpaqueId,
  parseGrantRevokeBody,
  parsePlanKind,
  revokeCredentialGrant,
  type CredentialGrantCommandPorts,
  type CredentialGrantCursorCodec,
} from '../../modules/auth/index.js';
import {
  admit,
  mapAccountCredentialError,
  readOptionalIfMatch,
  sendCredential,
  sendIssued,
  sendRevoked,
  withTimeout,
} from './account-credential-routes.js';
import type { AccountCredentialRouteDependencies } from './account-credential-routes.js';
import { readKnownCommandId } from './collection-route-helpers.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { requireParentKey } from '../auth/account-credential-parent-key-routes.js';
import { ProductHttpError } from '../product-error.js';
import { sendProductCommandReceiptOutcome } from '../product-command-mapping.js';

const LIST = '/api/v1/me/credential-grants';
const ITEM = '/api/v1/me/credential-grants/:grantId';
const REVOKE = '/api/v1/me/credential-grants/:grantId/revoke';
const AUTHORIZE = '/api/v1/me/credential-grants/:grantId/authorize-plan';
const PLAN = '/api/v1/me/credential-plans/:planKind/:planId';

export interface AccountCredentialGrantRoutesDependencies extends AccountCredentialRouteDependencies {
  readonly grantCursors: CredentialGrantCursorCodec | null;
}

export function registerAccountCredentialGrantRoutes(
  app: FastifyInstance,
  deps: AccountCredentialGrantRoutesDependencies,
): void {
  const credentialAccess = async (request: FastifyRequest) => { await requireParentKey(request, deps); };
  app.get(LIST, {
    exposeHeadRoute: false,
    config: {
      credentialAccess,
      ...productRouteMetadata('GET', LIST),
      productTransport: {
        allowedQuery: ['credentialId', 'limit', 'cursor'],
        duplicateQueryErrorCode: 'invalid_query',
        queryErrorCode: 'invalid_query',
        acceptedMediaTypes: [],
        bodyLimitBytes: 1,
        cacheControl: 'private-no-store',
      },
    },
  }, wrap(async (request, reply) => {
    const { account } = await parentAccount(request, deps);
    gate(deps);
    await admit(deps.rateLimiter, `credential-grants:list:${account.id}`);
    const filters = parseGrantListQuery(request.query as Record<string, string>);
    const page = await deps.unitOfWork.execute((ports) => listOwnedGrants({
      ...grantPorts(ports),
      grantCursors: deps.grantCursors!,
    }, { ownerAccountId: account.id, filters }));
    return reply.code(200).type('application/json; charset=utf-8').send(page);
  }));

  app.post(LIST, {
    exposeHeadRoute: false,
    config: {
      credentialAccess,
      ...productRouteMetadata('POST', LIST),
      productTransport: {
        allowedQuery: [],
        acceptedMediaTypes: ['application/json'],
        bodyLimitBytes: 32_768,
        cacheControl: 'private-no-store',
      },
    },
  }, wrap(async (request, reply) => {
    const { account } = await parentAccount(request, deps);
    gate(deps);
    await admit(deps.rateLimiter, `credential-grants:mutate:${account.id}`);
    const commandId = readKnownCommandId(request);
    const body = parseGrantInput(request.body);
    const outcome = await withTimeout(request, deps.timeoutMs, () =>
      deps.unitOfWork.execute((ports) => createCredentialGrant(grantPorts(ports), {
        ownerAccountId: account.id,
        ownerSubjectId: account.subjectId,
        commandId,
        body,
      })));
    return sendIssued(reply, outcome, 201);
  }));

  app.get(ITEM, {
    exposeHeadRoute: false,
    config: {
      credentialAccess,
      ...productRouteMetadata('GET', ITEM),
      productTransport: {
        allowedQuery: [],
        acceptedMediaTypes: [],
        bodyLimitBytes: 1,
        cacheControl: 'private-no-store',
      },
    },
  }, wrap(async (request, reply) => {
    const { account } = await parentAccount(request, deps);
    gate(deps);
    await admit(deps.rateLimiter, `credential-grants:get:${account.id}`);
    const grantId = parseGrantOpaqueId((request.params as { grantId?: string }).grantId, 'grantId');
    const result = await deps.unitOfWork.execute((ports) =>
      getOwnedGrant(grantPorts(ports), { ownerAccountId: account.id, grantId }));
    return sendCredential(reply, result.grant, result.etag);
  }));

  app.post(REVOKE, {
    exposeHeadRoute: false,
    config: {
      credentialAccess,
      ...productRouteMetadata('POST', REVOKE),
      productTransport: {
        allowedQuery: [],
        acceptedMediaTypes: ['application/json'],
        bodyLimitBytes: 32_768,
        cacheControl: 'private-no-store',
      },
    },
  }, wrap(async (request, reply) => {
    const { account } = await parentAccount(request, deps);
    gate(deps);
    await admit(deps.rateLimiter, `credential-grants:mutate:${account.id}`);
    const commandId = readKnownCommandId(request);
    const grantId = parseGrantOpaqueId((request.params as { grantId?: string }).grantId, 'grantId');
    const ifMatch = readOptionalIfMatch(request);
    const body = parseGrantRevokeBody(request.body);
    const outcome = await withTimeout(request, deps.timeoutMs, () =>
      deps.unitOfWork.execute((ports) => revokeCredentialGrant(grantPorts(ports), {
        ownerAccountId: account.id,
        grantId,
        commandId,
        ifMatch,
        reason: body.reason,
      })));
    return sendRevoked(reply, outcome);
  }));

  app.post(AUTHORIZE, {
    exposeHeadRoute: false,
    config: {
      credentialAccess,
      ...productRouteMetadata('POST', AUTHORIZE),
      productTransport: {
        allowedQuery: [],
        acceptedMediaTypes: ['application/json'],
        bodyLimitBytes: 32_768,
        cacheControl: 'private-no-store',
      },
    },
  }, wrap(async (request, reply) => {
    const { account } = await parentAccount(request, deps);
    gate(deps);
    await admit(deps.rateLimiter, `credential-grants:mutate:${account.id}`);
    const commandId = readKnownCommandId(request);
    const grantId = parseGrantOpaqueId((request.params as { grantId?: string }).grantId, 'grantId');
    const ifMatch = readOptionalIfMatch(request);
    const body = parseAuthorizePlanBody(request.body);
    const outcome = await withTimeout(request, deps.timeoutMs, () =>
      deps.unitOfWork.execute((ports) => authorizePlanWithCredentialGrant(grantPorts(ports), {
        ownerAccountId: account.id,
        grantId,
        commandId,
        ifMatch,
        ...body,
      })));
    if (outcome.kind !== 'succeeded') return sendProductCommandReceiptOutcome(reply, outcome);
    reply.header('ETag', outcome.etag);
    return reply.code(200).type('application/json; charset=utf-8').send(outcome.body);
  }));

  app.get(PLAN, {
    exposeHeadRoute: false,
    config: {
      credentialAccess,
      ...productRouteMetadata('GET', PLAN),
      productTransport: {
        allowedQuery: [],
        acceptedMediaTypes: [],
        bodyLimitBytes: 1,
        cacheControl: 'private-no-store',
      },
    },
  }, wrap(async (request, reply) => {
    const { account } = await parentAccount(request, deps);
    gate(deps);
    await admit(deps.rateLimiter, `credential-plans:get:${account.id}`);
    const params = request.params as { planKind?: string; planId?: string };
    const planKind = parsePlanKind(params.planKind);
    const planId = parseGrantOpaqueId(params.planId, 'planId');
    const view = await deps.unitOfWork.execute((ports) =>
      getCredentialPlanView(grantPorts(ports), { accountId: account.id, planKind, planId }));
    return reply.code(200).type('application/json; charset=utf-8').send(view);
  }));
}

function grantPorts(ports: object): CredentialGrantCommandPorts {
  const candidate = ports as CredentialGrantCommandPorts;
  if (!candidate.grants || !candidate.resources || !candidate.plans) {
    throw new AccountCredentialCommandError('resource_not_found', 'The credential grant was not found.');
  }
  return candidate;
}

function gate(deps: AccountCredentialGrantRoutesDependencies): void {
  if (!deps.enabled || !deps.cursors || !deps.grantCursors) {
    throw new ProductHttpError({
      statusCode: 404,
      code: 'resource_not_found',
      message: 'The requested resource was not found.',
      recovery: 'none',
    });
  }
}

async function parentAccount(request: FastifyRequest, deps: AccountCredentialRouteDependencies) {
  const actor = await requireParentKey(request, deps);
  return { account: { id: actor.managerAccountId, subjectId: actor.subjectId } };
}

function wrap(
  handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
): (request: FastifyRequest, reply: FastifyReply) => Promise<unknown> {
  return async (request, reply) => {
    try {
      return await handler(request, reply);
    } catch (error) {
      throw mapAccountCredentialError(error);
    }
  };
}
