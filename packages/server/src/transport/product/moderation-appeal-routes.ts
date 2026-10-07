import { consumeActionRate } from './moderation-action-routes.js';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { canonicalCommandFingerprint } from '../../modules/commands/index.js';
import { strongEntityTag } from '../../modules/collections/index.js';
import {
  createModerationAppeal,
  decideModerationAppeal,
  getModerationAppeal,
  listModerationAppeals,
  listMyModerationAppeals,
  parseAppealDecision,
  parseAppealInput,
  type Appeal,
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

const APPEALS = '/api/v1/moderation/appeals';
const APPEAL = '/api/v1/moderation/appeals/:appealId';
const DECISION = '/api/v1/moderation/appeals/:appealId/decision';
const MY_APPEALS = '/api/v1/me/moderation-appeals';
const BODY_LIMIT = 32_768;

export function registerModerationAppealRoutes(app: FastifyInstance, deps: ModerationRoutesDeps): void {
  const enabled = deps.config.contentGovernance.enabled;
  const hmacKey = deps.config.contentGovernance.cursorHmacKey;

  app.post(APPEALS, {
    config: {
      ...productRouteMetadata('POST', APPEALS),
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
    await consumeAppealRate(deps.appealRateLimiter, account.id);
    const commandId = readKnownCommandId(request);
    let body;
    try {
      body = parseAppealInput(request.body);
    } catch (error: unknown) {
      mapRegisteredModerationError(error);
    }
    const fingerprint = canonicalCommandFingerprint({
      method: 'POST',
      route: APPEALS,
      mediaType: 'application/json',
      body,
      query: {},
    });
    try {
      const outcome = await deps.commandUnitOfWork.execute((ports) =>
        createModerationAppeal(ports, {
          actor: { accountId: account.id, principalId: account.id },
          commandId,
          fingerprint,
          commandScope: httpCommandScopeV1('POST', APPEALS),
          body,
        }));
      if (outcome.kind === 'written') return sendAppeal(reply, outcome.status, outcome.view);
      return sendProductCommandReceiptOutcome(reply, outcome);
    } catch (error: unknown) {
      mapRegisteredModerationError(error);
    }
  });

  app.get(APPEALS, {
    exposeHeadRoute: false,
    config: {
      ...productRouteMetadata('GET', APPEALS),
      productTransport: {
        allowedQuery: ['status', 'limit', 'cursor'],
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
      const page = await listModerationAppeals(deps.queryPorts, requireModerationHmac(hmacKey), {
        accountId: account.id,
        query: request.query as Record<string, string>,
      });
      return sendModerationPage(reply, page);
    } catch (error: unknown) {
      mapRegisteredModerationError(error);
    }
  });

  app.get(MY_APPEALS, {
    exposeHeadRoute: false,
    config: {
      ...productRouteMetadata('GET', MY_APPEALS),
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
      const page = await listMyModerationAppeals(deps.queryPorts, requireModerationHmac(hmacKey), {
        accountId: account.id,
        query: request.query as Record<string, string>,
      });
      return sendModerationPage(reply, page);
    } catch (error: unknown) {
      mapRegisteredModerationError(error);
    }
  });

  app.get(APPEAL, {
    exposeHeadRoute: false,
    config: {
      ...productRouteMetadata('GET', APPEAL),
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
      const result = await getModerationAppeal(deps.queryPorts, {
        accountId: account.id,
        appealId: readModerationPathId(request, 'appealId'),
      });
      return sendAppeal(reply, 200, result.view);
    } catch (error: unknown) {
      mapRegisteredModerationError(error);
    }
  });

  app.post(DECISION, {
    config: {
      ...productRouteMetadata('POST', DECISION),
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
    const appealId = readModerationPathId(request, 'appealId');
    let body;
    try {
      body = parseAppealDecision(request.body);
    } catch (error: unknown) {
      mapRegisteredModerationError(error);
    }
    const routeIdentity = `/api/v1/moderation/appeals/${appealId}/decision`;
    const fingerprint = canonicalCommandFingerprint({
      method: 'POST',
      route: routeIdentity,
      mediaType: 'application/json',
      body,
      query: {},
      conditions: { ifMatch },
    });
    try {
      const outcome = await deps.commandUnitOfWork.execute((ports) =>
        decideModerationAppeal(ports, {
          actor: { accountId: account.id, principalId: account.id },
          commandId,
          fingerprint,
          commandScope: httpCommandScopeV1('POST', routeIdentity),
          appealId,
          ifMatch,
          body,
        }));
      if (outcome.kind === 'written') return sendAppeal(reply, 200, outcome.view);
      return sendProductCommandReceiptOutcome(reply, outcome);
    } catch (error: unknown) {
      mapRegisteredModerationError(error);
    }
  });
}

function sendAppeal(reply: FastifyReply, status: 200 | 201, view: Appeal): FastifyReply {
  return reply.code(status)
    .header('etag', strongEntityTag(view.revision))
    .header('cache-control', 'private, no-store')
    .send(view);
}

async function consumeAppealRate(
  limiter: ModerationRoutesDeps['appealRateLimiter'],
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
      message: 'Too many moderation appeals. Please try again later.',
      recovery: 'same_request',
      sameRequestRetrySafe: true,
      retryAfterSeconds: decision.retryAfterSeconds,
      headers: { 'Retry-After': String(decision.retryAfterSeconds) },
    });
  }
}
