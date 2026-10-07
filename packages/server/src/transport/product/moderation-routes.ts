import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { canonicalCommandFingerprint } from '../../modules/commands/index.js';
import { strongEntityTag } from '../../modules/collections/index.js';
import {
  getModerationCase,
  getModerationEvidence,
  getMyModerationReport,
  GovernanceModerationError,
  listModerationCases,
  listMyModerationReports,
  ModerationCursorExpiredError,
  parseReportInput,
  submitModerationReport,
  type ModerationCommandPorts,
  type ModerationQueryPorts,
  type MyCase,
} from '../../modules/governance/index.js';
import type { AppConfig } from '../../bootstrap/config.js';
import type { IdentityUnitOfWork } from '../../modules/identity/index.js';
import { httpCommandScopeV1 } from '../http-command-scope.js';
import { consumeProductAdmission, type ProductAdmissionRateLimiter } from '../http-security.js';
import { requireMutationActor } from '../mutation-actor.js';
import {
  mapCollectionMutationError,
  sendProductCommandReceiptOutcome,
} from '../product-command-mapping.js';
import { ProductHttpError } from '../product-error.js';
import { productErrorStatus } from '../product-codes.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { requireSessionActor } from '../session-auth.js';
import { readKnownCommandId } from './collection-route-helpers.js';

const REPORTS = '/api/v1/moderation/reports';
const MY_REPORTS = '/api/v1/me/moderation-reports';
const MY_REPORT = '/api/v1/me/moderation-reports/:caseId';
const CASES = '/api/v1/moderation/cases';
const CASE = '/api/v1/moderation/cases/:caseId';
const EVIDENCE = '/api/v1/moderation/cases/:caseId/evidence/:evidenceId';
const BODY_LIMIT = 32_768;

export interface ModerationRoutesDeps {
  readonly config: AppConfig;
  readonly identityUnitOfWork: IdentityUnitOfWork;
  readonly commandUnitOfWork: {
    execute<Result>(work: (ports: ModerationCommandPorts) => Promise<Result>): Promise<Result>;
  };
  readonly queryPorts: ModerationQueryPorts;
  readonly rateLimiter: ProductAdmissionRateLimiter;
  readonly actionRateLimiter: ProductAdmissionRateLimiter;
  readonly appealRateLimiter: ProductAdmissionRateLimiter;
}

export function registerModerationRoutes(app: FastifyInstance, deps: ModerationRoutesDeps): void {
  const enabled = deps.config.contentGovernance.enabled;
  const hmacKey = deps.config.contentGovernance.cursorHmacKey;

  app.post(REPORTS, {
    config: {
      ...productRouteMetadata('POST', REPORTS),
      productTransport: {
        allowedQuery: [],
        acceptedMediaTypes: ['application/json'],
        bodyLimitBytes: BODY_LIMIT,
        cacheControl: 'private-no-store',
      },
    },
  }, async (request, reply) => {
    if (!enabled) featureOff();
    const { account } = await requireMutationActor(request, {
      identityUnitOfWork: deps.identityUnitOfWork,
      allowedOrigins: deps.config.allowedOrigins,
    });
    await consumeReportRate(deps.rateLimiter, account.id);
    const commandId = readKnownCommandId(request);
    let report;
    try {
      report = parseReportInput(request.body);
    } catch (error: unknown) {
      mapModerationError(error);
    }
    const fingerprint = canonicalCommandFingerprint({
      method: 'POST',
      route: REPORTS,
      mediaType: 'application/json',
      body: report,
      query: {},
    });
    try {
      const outcome = await deps.commandUnitOfWork.execute((ports) =>
        submitModerationReport(ports, {
          actor: {
            accountId: account.id,
            subjectId: account.subjectId,
            principalId: account.id,
          },
          commandId,
          fingerprint,
          commandScope: httpCommandScopeV1('POST', REPORTS),
          report,
        }));
      if (outcome.kind === 'created' || outcome.kind === 'deduped') {
        return sendMyCase(reply, outcome.status, outcome.case);
      }
      return sendProductCommandReceiptOutcome(reply, outcome);
    } catch (error: unknown) {
      mapModerationError(error);
    }
  });

  app.get(MY_REPORTS, {
    exposeHeadRoute: false,
    config: {
      ...productRouteMetadata('GET', MY_REPORTS),
      productTransport: {
        allowedQuery: ['status', 'limit', 'cursor'],
        cacheControl: 'private-no-store',
        rejectRequestBody: true,
        queryErrorCode: 'invalid_query',
        duplicateQueryErrorCode: 'invalid_query',
      },
    },
  }, async (request, reply) => {
    if (!enabled) featureOff();
    const { account } = await requireSessionActor(request, deps.identityUnitOfWork, { touch: false });
    try {
      const page = await listMyModerationReports(deps.queryPorts, requireHmac(hmacKey), {
        accountId: account.id,
        query: request.query as Record<string, string>,
      });
      return sendPage(reply, page);
    } catch (error: unknown) {
      mapModerationError(error);
    }
  });

  app.get(MY_REPORT, {
    exposeHeadRoute: false,
    config: {
      ...productRouteMetadata('GET', MY_REPORT),
      productTransport: {
        allowedQuery: [],
        cacheControl: 'private-no-store',
        rejectRequestBody: true,
      },
    },
  }, async (request, reply) => {
    if (!enabled) featureOff();
    const { account } = await requireSessionActor(request, deps.identityUnitOfWork, { touch: false });
    try {
      const result = await getMyModerationReport(deps.queryPorts, {
        accountId: account.id,
        caseId: pathId(request, 'caseId'),
      });
      return sendMyCase(reply, 200, result.view);
    } catch (error: unknown) {
      mapModerationError(error);
    }
  });

  app.get(CASES, {
    exposeHeadRoute: false,
    config: {
      ...productRouteMetadata('GET', CASES),
      productTransport: {
        allowedQuery: ['status', 'assignee', 'limit', 'cursor'],
        cacheControl: 'private-no-store',
        rejectRequestBody: true,
        queryErrorCode: 'invalid_query',
        duplicateQueryErrorCode: 'invalid_query',
      },
    },
  }, async (request, reply) => {
    if (!enabled) featureOff();
    const { account } = await requireSessionActor(request, deps.identityUnitOfWork, { touch: false });
    try {
      const page = await listModerationCases(deps.queryPorts, requireHmac(hmacKey), {
        accountId: account.id,
        query: request.query as Record<string, string>,
      });
      return sendPage(reply, page);
    } catch (error: unknown) {
      mapModerationError(error);
    }
  });

  app.get(CASE, {
    exposeHeadRoute: false,
    config: {
      ...productRouteMetadata('GET', CASE),
      productTransport: {
        allowedQuery: [],
        cacheControl: 'private-no-store',
        rejectRequestBody: true,
      },
    },
  }, async (request, reply) => {
    if (!enabled) featureOff();
    const { account } = await requireSessionActor(request, deps.identityUnitOfWork, { touch: false });
    try {
      const result = await getModerationCase(deps.queryPorts, {
        accountId: account.id,
        caseId: pathId(request, 'caseId'),
      });
      return reply.code(200)
        .header('etag', result.etag)
        .header('cache-control', 'private, no-store')
        .send(result.view);
    } catch (error: unknown) {
      mapModerationError(error);
    }
  });

  app.get(EVIDENCE, {
    exposeHeadRoute: false,
    config: {
      ...productRouteMetadata('GET', EVIDENCE),
      productTransport: {
        allowedQuery: [],
        cacheControl: 'private-no-store',
        rejectRequestBody: true,
      },
    },
  }, async (request, reply) => {
    if (!enabled) featureOff();
    const { account } = await requireSessionActor(request, deps.identityUnitOfWork, { touch: false });
    try {
      const evidence = await getModerationEvidence(deps.queryPorts, {
        accountId: account.id,
        caseId: pathId(request, 'caseId'),
        evidenceId: pathId(request, 'evidenceId'),
      });
      return reply.code(200).header('cache-control', 'private, no-store').send(evidence);
    } catch (error: unknown) {
      mapModerationError(error);
    }
  });
}

export function sendModerationPage(
  reply: FastifyReply,
  page: { readonly items: readonly unknown[]; readonly nextCursor: string | null },
): FastifyReply {
  return sendPage(reply, page);
}

export function moderationFeatureOff(): never {
  featureOff();
}

export function mapRegisteredModerationError(error: unknown): never {
  mapModerationError(error);
}

export function requireModerationHmac(key: string | null): string {
  return requireHmac(key);
}

export function readModerationPathId(
  request: FastifyRequest,
  name: 'caseId' | 'evidenceId' | 'actionId' | 'appealId',
): string {
  return pathId(request, name);
}

function sendMyCase(reply: FastifyReply, status: 200 | 201, view: MyCase): FastifyReply {
  return reply.code(status)
    .header('etag', strongEntityTag(view.revision))
    .header('cache-control', 'private, no-store')
    .send(view);
}

function sendPage(
  reply: FastifyReply,
  page: { readonly items: readonly unknown[]; readonly nextCursor: string | null },
): FastifyReply {
  return reply.code(200).header('cache-control', 'private, no-store').send({
    items: [...page.items],
    nextCursor: page.nextCursor,
  });
}

async function consumeReportRate(
  limiter: ProductAdmissionRateLimiter,
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
      message: 'Too many moderation reports. Please try again later.',
      recovery: 'same_request',
      sameRequestRetrySafe: true,
      retryAfterSeconds: decision.retryAfterSeconds,
      headers: { 'Retry-After': String(decision.retryAfterSeconds) },
    });
  }
}

function pathId(request: FastifyRequest, name: 'caseId' | 'evidenceId' | 'actionId' | 'appealId'): string {
  const value = (request.params as Record<string, unknown>)[name];
  if (typeof value !== 'string' || value.length < 1) {
    throw new ProductHttpError({
      statusCode: 400,
      code: 'invalid_request',
      message: `${name} path parameter is required.`,
    });
  }
  return value;
}

function requireHmac(key: string | null): string {
  if (key === null || key.length === 0) {
    throw new Error('GOVERNANCE_CURSOR_HMAC_KEY is required when content governance is enabled');
  }
  return key;
}

function featureOff(): never {
  throw new ProductHttpError({
    statusCode: 404,
    code: 'resource_not_found',
    message: 'The requested resource was not found.',
    recovery: 'none',
  });
}

function mapModerationError(error: unknown): never {
  if (error instanceof ProductHttpError) throw error;
  if (error instanceof ModerationCursorExpiredError) {
    throw new ProductHttpError({
      statusCode: productErrorStatus('snapshot_expired'),
      code: 'snapshot_expired',
      message: 'The cursor snapshot has expired.',
      recovery: 'restart_from_first_page',
    });
  }
  if (error instanceof GovernanceModerationError) {
    if (error.code === 'resource_not_found' || error.outcome === 'conceal') {
      throw new ProductHttpError({
        statusCode: 404,
        code: 'resource_not_found',
        message: 'The requested resource was not found.',
        recovery: 'none',
      });
    }
    if (error.code === 'insufficient_permission' || error.outcome === 'deny') {
      throw new ProductHttpError({
        statusCode: 403,
        code: 'insufficient_permission',
        message: 'You do not have permission to perform this action.',
        recovery: 'user_action',
      });
    }
    if (error.code === 'invalid_cursor') {
      throw new ProductHttpError({
        statusCode: 400,
        code: 'invalid_cursor',
        message: 'The cursor is invalid.',
        recovery: 'restart_from_first_page',
      });
    }
    if (error.code === 'snapshot_expired') {
      throw new ProductHttpError({
        statusCode: 409,
        code: 'snapshot_expired',
        message: 'The cursor snapshot has expired.',
        recovery: 'restart_from_first_page',
      });
    }
    if (error.code === 'revision_conflict') {
      throw new ProductHttpError({
        statusCode: 409,
        code: 'revision_conflict',
        message: error.message,
        recovery: 'refresh_and_retry',
      });
    }
    throw new ProductHttpError({
      statusCode: 400,
      code: error.code,
      message: error.message,
    });
  }
  const mapped = mapCollectionMutationError(error);
  if (mapped) throw mapped;
  throw error;
}
