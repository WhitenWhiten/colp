import type { FastifyInstance, FastifyReply } from 'fastify';
import { canonicalCommandFingerprint } from '../../modules/commands/index.js';
import { strongEntityTag } from '../../modules/collections/index.js';
import {
  createModerationAction,
  getModerationAction,
  listActionsAffectingMe,
  parseActionInput,
  parseCasePatch,
  parseRevokeReason,
  revokeModerationAction,
  updateModerationCase,
  type Action,
} from '../../modules/governance/index.js';
import { httpCommandScopeV1 } from '../http-command-scope.js';
import { consumeProductAdmission } from '../http-security.js';
import { requireMutationActor } from '../mutation-actor.js';
import { sendProductCommandReceiptOutcome } from '../product-command-mapping.js';
import { ProductHttpError } from '../product-error.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { requireSessionActor } from '../session-auth.js';
import { readKnownCommandId, readRequiredIfMatch } from './collection-route-helpers.js';
import {
  mapRegisteredModerationError,
  moderationFeatureOff,
  readModerationPathId,
  requireModerationHmac,
  sendModerationPage,
  type ModerationRoutesDeps,
} from './moderation-routes.js';

export { registerModerationAppealRoutes } from './moderation-appeal-routes.js';

const CASE = '/api/v1/moderation/cases/:caseId';
const ACTIONS = '/api/v1/moderation/actions';
const ACTION = '/api/v1/moderation/actions/:actionId';
const REVOKE = '/api/v1/moderation/actions/:actionId/revoke';
const MY_ACTIONS = '/api/v1/me/moderation-actions';
const BODY_LIMIT = 32_768;

export function registerModerationActionRoutes(app: FastifyInstance, deps: ModerationRoutesDeps): void {
  const enabled = deps.config.contentGovernance.enabled;
  const hmacKey = deps.config.contentGovernance.cursorHmacKey;

  app.patch(CASE, {
    config: {
      ...productRouteMetadata('PATCH', CASE),
      productTransport: {
        allowedQuery: [],
        acceptedMediaTypes: ['application/json'],
        bodyLimitBytes: BODY_LIMIT,
        cacheControl: 'private-no-store',
      },
    },
  }, async (request, reply) => {
    if (!enabled) moderationFeatureOff();
    const { account } = await requireMutationActor(request, {
      identityUnitOfWork: deps.identityUnitOfWork,
      allowedOrigins: deps.config.allowedOrigins,
    });
    await consumeActionRate(deps.actionRateLimiter, account.id);
    const commandId = readKnownCommandId(request);
    const ifMatch = readRequiredIfMatch(request);
    let patch;
    try {
      patch = parseCasePatch(request.body);
    } catch (error: unknown) {
      mapRegisteredModerationError(error);
    }
    const caseId = readModerationPathId(request, 'caseId');
    const routeIdentity = `/api/v1/moderation/cases/${caseId}`;
    const fingerprint = canonicalCommandFingerprint({
      method: 'PATCH',
      route: routeIdentity,
      mediaType: 'application/json',
      body: patch,
      query: {},
      conditions: { ifMatch },
    });
    try {
      const outcome = await deps.commandUnitOfWork.execute((ports) =>
        updateModerationCase(ports, {
          actor: { accountId: account.id, principalId: account.id },
          commandId,
          fingerprint,
          commandScope: httpCommandScopeV1('PATCH', routeIdentity),
          caseId,
          ifMatch,
          patch,
        }));
      if (outcome.kind === 'updated') {
        return reply.code(200)
          .header('etag', strongEntityTag(outcome.view.case.revision))
          .header('cache-control', 'private, no-store')
          .send(outcome.view);
      }
      return sendProductCommandReceiptOutcome(reply, outcome);
    } catch (error: unknown) {
      mapRegisteredModerationError(error);
    }
  });

  app.post(ACTIONS, {
    config: {
      ...productRouteMetadata('POST', ACTIONS),
      productTransport: {
        allowedQuery: [],
        acceptedMediaTypes: ['application/json'],
        bodyLimitBytes: BODY_LIMIT,
        cacheControl: 'private-no-store',
      },
    },
  }, async (request, reply) => {
    if (!enabled) moderationFeatureOff();
    const { account } = await requireMutationActor(request, {
      identityUnitOfWork: deps.identityUnitOfWork,
      allowedOrigins: deps.config.allowedOrigins,
    });
    await consumeActionRate(deps.actionRateLimiter, account.id);
    const commandId = readKnownCommandId(request);
    let body;
    try {
      body = parseActionInput(request.body);
    } catch (error: unknown) {
      mapRegisteredModerationError(error);
    }
    const fingerprint = canonicalCommandFingerprint({
      method: 'POST',
      route: ACTIONS,
      mediaType: 'application/json',
      body,
      query: {},
    });
    try {
      const outcome = await deps.commandUnitOfWork.execute((ports) =>
        createModerationAction(ports, {
          actor: { accountId: account.id, principalId: account.id },
          commandId,
          fingerprint,
          commandScope: httpCommandScopeV1('POST', ACTIONS),
          body,
        }));
      if (outcome.kind === 'written') return sendAction(reply, outcome.status, outcome.view);
      return sendProductCommandReceiptOutcome(reply, outcome);
    } catch (error: unknown) {
      mapRegisteredModerationError(error);
    }
  });

  app.get(ACTION, {
    exposeHeadRoute: false,
    config: {
      ...productRouteMetadata('GET', ACTION),
      productTransport: {
        allowedQuery: [],
        cacheControl: 'private-no-store',
        rejectRequestBody: true,
      },
    },
  }, async (request, reply) => {
    if (!enabled) moderationFeatureOff();
    const { account } = await requireSessionActor(request, deps.identityUnitOfWork, { touch: false });
    try {
      const result = await getModerationAction(deps.queryPorts, {
        accountId: account.id,
        actionId: readModerationPathId(request, 'actionId'),
      });
      return sendAction(reply, 200, result.view);
    } catch (error: unknown) {
      mapRegisteredModerationError(error);
    }
  });

  app.post(REVOKE, {
    config: {
      ...productRouteMetadata('POST', REVOKE),
      productTransport: {
        allowedQuery: [],
        acceptedMediaTypes: ['application/json'],
        bodyLimitBytes: BODY_LIMIT,
        cacheControl: 'private-no-store',
      },
    },
  }, async (request, reply) => {
    if (!enabled) moderationFeatureOff();
    const { account } = await requireMutationActor(request, {
      identityUnitOfWork: deps.identityUnitOfWork,
      allowedOrigins: deps.config.allowedOrigins,
    });
    await consumeActionRate(deps.actionRateLimiter, account.id);
    const commandId = readKnownCommandId(request);
    const ifMatch = readRequiredIfMatch(request);
    const actionId = readModerationPathId(request, 'actionId');
    let reason;
    try {
      reason = parseRevokeReason(request.body);
    } catch (error: unknown) {
      mapRegisteredModerationError(error);
    }
    const routeIdentity = `/api/v1/moderation/actions/${actionId}/revoke`;
    const fingerprint = canonicalCommandFingerprint({
      method: 'POST',
      route: routeIdentity,
      mediaType: 'application/json',
      body: { reason },
      query: {},
      conditions: { ifMatch },
    });
    try {
      const outcome = await deps.commandUnitOfWork.execute((ports) =>
        revokeModerationAction(ports, {
          actor: { accountId: account.id, principalId: account.id },
          commandId,
          fingerprint,
          commandScope: httpCommandScopeV1('POST', routeIdentity),
          actionId,
          ifMatch,
          reason,
        }));
      if (outcome.kind === 'written') return sendAction(reply, 200, outcome.view);
      return sendProductCommandReceiptOutcome(reply, outcome);
    } catch (error: unknown) {
      mapRegisteredModerationError(error);
    }
  });

  app.get(MY_ACTIONS, {
    exposeHeadRoute: false,
    config: {
      ...productRouteMetadata('GET', MY_ACTIONS),
      productTransport: {
        allowedQuery: ['limit', 'cursor'],
        cacheControl: 'private-no-store',
        rejectRequestBody: true,
        queryErrorCode: 'invalid_query',
        duplicateQueryErrorCode: 'invalid_query',
      },
    },
  }, async (request, reply) => {
    if (!enabled) moderationFeatureOff();
    const { account } = await requireSessionActor(request, deps.identityUnitOfWork, { touch: false });
    try {
      const page = await listActionsAffectingMe(deps.queryPorts, requireModerationHmac(hmacKey), {
        accountId: account.id,
        query: request.query as Record<string, string>,
      });
      return sendModerationPage(reply, page);
    } catch (error: unknown) {
      mapRegisteredModerationError(error);
    }
  });
}

function sendAction(reply: FastifyReply, status: 200 | 201, view: Action): FastifyReply {
  return reply.code(status)
    .header('etag', strongEntityTag(view.revision))
    .header('cache-control', 'private, no-store')
    .send(view);
}

export async function consumeActionRate(
  limiter: ModerationRoutesDeps['actionRateLimiter'],
  accountId: string,
): Promise<void> {
  const decision = await consumeProductAdmission(limiter, `account:${accountId}`);
  if (decision.kind === 'failed') {
    throw new ProductHttpError({
      statusCode: 503,
      code: 'feature_temporarily_unavailable',
      message: 'The service is temporarily unavailable.',
      recovery: 'same_request',
      sameRequestRetrySafe: true,
      retryAfterSeconds: 1,
    });
  }
  if (decision.kind === 'denied') {
    throw new ProductHttpError({
      statusCode: 429,
      code: 'rate_limited',
      message: 'Too many moderation actions. Please try again later.',
      recovery: 'same_request',
      sameRequestRetrySafe: true,
      retryAfterSeconds: decision.retryAfterSeconds,
      headers: { 'Retry-After': String(decision.retryAfterSeconds) },
    });
  }
}
