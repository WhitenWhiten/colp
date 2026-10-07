import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  ALREADY_MEMBER_MESSAGE,
  CollaborationError,
  CollaborationListCursorError,
  CollaborationPreconditionError,
  INVITE_ALREADY_PENDING_MESSAGE,
  acceptInvite,
  acceptInviteCommandScope,
  declineInvite,
  declineInviteCommandScope,
  inviteMember,
  inviteMemberCommandScope,
  listCollectionMembers,
  listMyCollaborationInvites,
  removeMember,
  removeMemberCommandScope,
  revokeInvite,
  revokeInviteCommandScope,
  strongPolicyEtag,
  updateMemberRole,
  updateMemberRoleCommandScope,
  type CollaborationActor,
  type CollaborationCommandResult,
  type CollaborationUnitOfWork,
  type CollaboratorGrantRole,
  type ProductCollaborationMembersCursorSignerPort,
  type ProductMyCollaborationInvitesCursorSignerPort,
} from '../../modules/access-policy/index.js';
import { canonicalCommandFingerprint } from '../../modules/commands/index.js';
import { secretsMatch } from '../../modules/identity/index.js';
import type { IdentityUnitOfWork } from '../../modules/identity/index.js';
import type { CollaborationInviteRateLimiter } from '../../infrastructure/rate-limit/index.js';
import {
  readCollectionIdParam,
  readKnownCommandId,
  readRequiredIfMatch,
} from './collection-route-helpers.js';
import { sendProductCommandReceiptOutcome } from '../product-command-mapping.js';
import { ProductHttpError } from '../product-error.js';
import { productErrorStatus } from '../product-codes.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { requireSessionActor } from '../session-auth.js';
import { requireMutationActor } from '../mutation-actor.js';

const MEMBERS = '/api/v1/collections/:collectionId/members';
const INVITES = '/api/v1/collections/:collectionId/members/invites';
const INVITE_ITEM = '/api/v1/collections/:collectionId/members/invites/:inviteId';
const MEMBER_ITEM = '/api/v1/collections/:collectionId/members/:subjectId';
const MY_INVITES = '/api/v1/me/collaboration-invites';
const ACCEPT = '/api/v1/me/collaboration-invites/:inviteId/accept';
const DECLINE = '/api/v1/me/collaboration-invites/:inviteId/decline';
const BODY_LIMIT = 16 * 1024;
const INVITE_201_FORBIDDEN_KEYS = new Set([
  'accountFound', 'emailQueued', 'found', 'queued', 'deliveryId', 'emailStatus',
]);

export interface ProductCollaborationRouteDependencies {
  readonly identityUnitOfWork: IdentityUnitOfWork;
  readonly allowedOrigins: readonly string[];
  readonly unitOfWork: CollaborationUnitOfWork;
  readonly rateLimiter: CollaborationInviteRateLimiter;
  readonly cursors: {
    readonly members: ProductCollaborationMembersCursorSignerPort;
    readonly myInvites: ProductMyCollaborationInvitesCursorSignerPort;
  };
  readonly csrfMatches?: (raw: string, expectedHash: string) => boolean;
  readonly now?: () => Date;
}

export function registerProductCollaborationRoutes(
  app: FastifyInstance,
  deps: ProductCollaborationRouteDependencies,
): void {
  app.get(MEMBERS, {
    config: {
      ...productRouteMetadata('GET', MEMBERS),
      productTransport: { allowedQuery: ['cursor'], cacheControl: 'private-no-store' },
    },
  }, async (request, reply) => {
    const actor = await collaborationActor(request, deps, { csrf: false, touch: false });
    const collectionId = readCollectionIdParam(request);
    const cursor = readOptionalCursor(request);
    try {
      const body = await deps.unitOfWork.execute((ports) => listCollectionMembers({
        ...ports,
        cursors: deps.cursors.members,
      }, {
        actor: toPrincipal(actor),
        collectionId,
        now: nowOf(deps),
        ...(cursor === undefined ? {} : { cursor }),
      }));
      return reply.code(200).type('application/json; charset=utf-8').send(body);
    } catch (error) {
      throw mapCollaborationHttpError(error);
    }
  });

  app.post(INVITES, {
    config: {
      ...productRouteMetadata('POST', INVITES),
      productTransport: {
        allowedQuery: [],
        acceptedMediaTypes: ['application/json'],
        bodyLimitBytes: BODY_LIMIT,
        cacheControl: 'private-no-store',
      },
    },
  }, async (request, reply) => {
    const actor = await collaborationActor(request, deps, { csrf: true, touch: true });
    await consumeInviteRate(deps.rateLimiter, actor.principalId);
    const collectionId = readCollectionIdParam(request);
    const commandId = readKnownCommandId(request);
    const ifMatch = readRequiredIfMatch(request);
    const body = inviteBody(request.body);
    const route = `/api/v1/collections/${collectionId}/members/invites`;
    const fingerprint = canonicalCommandFingerprint({
      method: 'POST', route, mediaType: 'application/json', body, query: {}, conditions: { ifMatch },
    });
    try {
      const outcome = await deps.unitOfWork.execute((ports) =>
        inviteMember(ports, {
          actor,
          command: { commandId, fingerprint, commandScope: inviteMemberCommandScope(collectionId) },
          collectionId,
          email: body.email,
          role: body.role,
          ifMatch,
        }));
      return sendWrite(reply, outcome);
    } catch (error) {
      throw mapCollaborationHttpError(error);
    }
  });

  app.delete(INVITE_ITEM, {
    config: {
      ...productRouteMetadata('DELETE', INVITE_ITEM),
      productTransport: {
        allowedQuery: [], acceptedMediaTypes: [], bodyLimitBytes: 1, cacheControl: 'private-no-store',
      },
    },
  }, async (request, reply) => {
    const actor = await collaborationActor(request, deps, { csrf: true, touch: true });
    const collectionId = readCollectionIdParam(request);
    const inviteId = readInviteId(request);
    const commandId = readKnownCommandId(request);
    const ifMatch = readRequiredIfMatch(request);
    const route = `/api/v1/collections/${collectionId}/members/invites/${inviteId}`;
    const fingerprint = canonicalCommandFingerprint({
      method: 'DELETE', route, mediaType: '', body: null, query: {}, conditions: { ifMatch },
    });
    try {
      const outcome = await deps.unitOfWork.execute((ports) =>
        revokeInvite(ports, {
          actor,
          command: { commandId, fingerprint, commandScope: revokeInviteCommandScope(collectionId) },
          collectionId,
          inviteId,
          ifMatch,
        }));
      return sendWrite(reply, outcome);
    } catch (error) {
      throw mapCollaborationHttpError(error);
    }
  });

  app.patch(MEMBER_ITEM, {
    config: {
      ...productRouteMetadata('PATCH', MEMBER_ITEM),
      productTransport: {
        allowedQuery: [],
        acceptedMediaTypes: ['application/merge-patch+json'],
        bodyLimitBytes: BODY_LIMIT,
        cacheControl: 'private-no-store',
      },
    },
  }, async (request, reply) => {
    const actor = await collaborationActor(request, deps, { csrf: true, touch: true });
    const collectionId = readCollectionIdParam(request);
    const subjectId = readSubjectId(request);
    const commandId = readKnownCommandId(request);
    const ifMatch = readRequiredIfMatch(request);
    const patch = rolePatch(request.body);
    const route = `/api/v1/collections/${collectionId}/members/${subjectId}`;
    const fingerprint = canonicalCommandFingerprint({
      method: 'PATCH',
      route,
      mediaType: 'application/merge-patch+json',
      body: patch,
      query: {},
      conditions: { ifMatch },
    });
    try {
      const outcome = await deps.unitOfWork.execute((ports) =>
        updateMemberRole(ports, {
          actor,
          command: { commandId, fingerprint, commandScope: updateMemberRoleCommandScope(collectionId) },
          collectionId,
          subjectId,
          role: patch.role,
          ifMatch,
        }));
      return sendWrite(reply, outcome);
    } catch (error) {
      throw mapCollaborationHttpError(error);
    }
  });

  app.delete(MEMBER_ITEM, {
    config: {
      ...productRouteMetadata('DELETE', MEMBER_ITEM),
      productTransport: {
        allowedQuery: [], acceptedMediaTypes: [], bodyLimitBytes: 1, cacheControl: 'private-no-store',
      },
    },
  }, async (request, reply) => {
    const actor = await collaborationActor(request, deps, { csrf: true, touch: true });
    const collectionId = readCollectionIdParam(request);
    const subjectId = readSubjectId(request);
    const commandId = readKnownCommandId(request);
    const ifMatch = readRequiredIfMatch(request);
    const route = `/api/v1/collections/${collectionId}/members/${subjectId}`;
    const fingerprint = canonicalCommandFingerprint({
      method: 'DELETE', route, mediaType: '', body: null, query: {}, conditions: { ifMatch },
    });
    try {
      const outcome = await deps.unitOfWork.execute((ports) =>
        removeMember(ports, {
          actor,
          command: { commandId, fingerprint, commandScope: removeMemberCommandScope(collectionId) },
          collectionId,
          subjectId,
          ifMatch,
        }));
      return sendWrite(reply, outcome);
    } catch (error) {
      throw mapCollaborationHttpError(error);
    }
  });

  app.get(MY_INVITES, {
    config: {
      ...productRouteMetadata('GET', MY_INVITES),
      productTransport: { allowedQuery: ['cursor'], cacheControl: 'private-no-store' },
    },
  }, async (request, reply) => {
    const actor = await collaborationActor(request, deps, { csrf: false, touch: false });
    const cursor = readOptionalCursor(request);
    try {
      const body = await deps.unitOfWork.execute((ports) => listMyCollaborationInvites({
        ...ports,
        cursors: deps.cursors.myInvites,
      }, {
        actor: { subjectId: actor.subjectId, email: actor.email },
        now: nowOf(deps),
        ...(cursor === undefined ? {} : { cursor }),
      }));
      return reply.code(200).type('application/json; charset=utf-8').send(body);
    } catch (error) {
      throw mapCollaborationHttpError(error);
    }
  });

  app.post(ACCEPT, {
    config: {
      ...productRouteMetadata('POST', ACCEPT),
      productTransport: {
        allowedQuery: [], acceptedMediaTypes: [], bodyLimitBytes: 1, cacheControl: 'private-no-store',
      },
    },
  }, async (request, reply) => {
    const actor = await collaborationActor(request, deps, { csrf: true, touch: true });
    await consumeAcceptRate(deps.rateLimiter, actor.principalId);
    const inviteId = readInviteId(request);
    const commandId = readKnownCommandId(request);
    const route = `/api/v1/me/collaboration-invites/${inviteId}/accept`;
    const fingerprint = canonicalCommandFingerprint({
      method: 'POST', route, mediaType: '', body: null, query: {}, conditions: {},
    });
    try {
      const outcome = await deps.unitOfWork.execute(async (ports) => {
        const invite = await ports.store.findInviteById(inviteId);
        if (!invite) throw new CollaborationError('conceal', 'Resource was not found.');
        return acceptInvite(ports, {
          actor,
          command: { commandId, fingerprint, commandScope: acceptInviteCommandScope(inviteId) },
          collectionId: invite.collectionId,
          inviteId,
        });
      });
      return sendWrite(reply, outcome);
    } catch (error) {
      throw mapCollaborationHttpError(error);
    }
  });

  app.post(DECLINE, {
    config: {
      ...productRouteMetadata('POST', DECLINE),
      productTransport: {
        allowedQuery: [], acceptedMediaTypes: [], bodyLimitBytes: 1, cacheControl: 'private-no-store',
      },
    },
  }, async (request, reply) => {
    const actor = await collaborationActor(request, deps, { csrf: true, touch: true });
    await consumeAcceptRate(deps.rateLimiter, actor.principalId);
    const inviteId = readInviteId(request);
    const commandId = readKnownCommandId(request);
    const route = `/api/v1/me/collaboration-invites/${inviteId}/decline`;
    const fingerprint = canonicalCommandFingerprint({
      method: 'POST', route, mediaType: '', body: null, query: {}, conditions: {},
    });
    try {
      const outcome = await deps.unitOfWork.execute(async (ports) => {
        const invite = await ports.store.findInviteById(inviteId);
        if (!invite) throw new CollaborationError('conceal', 'Resource was not found.');
        return declineInvite(ports, {
          actor,
          command: { commandId, fingerprint, commandScope: declineInviteCommandScope(inviteId) },
          collectionId: invite.collectionId,
          inviteId,
        });
      });
      return sendWrite(reply, outcome);
    } catch (error) {
      throw mapCollaborationHttpError(error);
    }
  });
}

function sendWrite(
  reply: Parameters<typeof sendProductCommandReceiptOutcome>[0],
  outcome: CollaborationCommandResult,
) {
  if (outcome.kind === 'replay' || outcome.kind === 'in_progress'
    || outcome.kind === 'reused' || outcome.kind === 'expired') {
    return sendProductCommandReceiptOutcome(reply, outcome);
  }
  if (outcome.kind === 'invited') {
    const body = {
      inviteId: outcome.invite.inviteId,
      collectionId: outcome.invite.collectionId,
      role: outcome.invite.role,
      expiresAt: outcome.invite.expiresAt,
      policyEtag: strongPolicyEtag(outcome.policyRevision),
    };
    for (const key of Object.keys(body)) {
      if (INVITE_201_FORBIDDEN_KEYS.has(key)) {
        throw new Error('invite 201 body leaked a forbidden key');
      }
    }
    return reply.code(201)
      .header('location', `/api/v1/collections/${outcome.invite.collectionId}/members/invites/${outcome.invite.inviteId}`)
      .type('application/json; charset=utf-8')
      .send(body);
  }
  if (outcome.kind === 'accepted' || outcome.kind === 'updated') {
    return reply.code(200).type('application/json; charset=utf-8').send({
      ...outcome.membership,
      policyEtag: strongPolicyEtag(outcome.policyRevision),
    });
  }
  return reply.code(204).send();
}

async function collaborationActor(
  request: FastifyRequest,
  deps: ProductCollaborationRouteDependencies,
  options: { readonly csrf: boolean; readonly touch: boolean },
): Promise<CollaborationActor> {
  const authenticated = options.csrf
    ? await requireMutationActor(request, {
      identityUnitOfWork: deps.identityUnitOfWork,
      allowedOrigins: deps.allowedOrigins,
      csrfMatches: deps.csrfMatches ?? secretsMatch,
    })
    : await requireSessionActor(request, deps.identityUnitOfWork, { touch: options.touch });
  const { account } = authenticated;
  if (typeof account.email !== 'string' || account.email.trim().length === 0) {
    throw new ProductHttpError({
      statusCode: 400,
      code: 'invalid_request',
      message: 'A verified email is required.',
    });
  }
  return {
    principalId: account.id,
    subjectId: account.subjectId,
    kind: 'account',
    email: account.email,
  };
}

async function consumeInviteRate(limiter: CollaborationInviteRateLimiter, principalId: string): Promise<void> {
  const outcome = await limiter.consumeInvite(principalId);
  throwIfRateLimitBlocked(outcome);
}

async function consumeAcceptRate(limiter: CollaborationInviteRateLimiter, principalId: string): Promise<void> {
  const outcome = await limiter.consumeAcceptOrDecline(principalId);
  throwIfRateLimitBlocked(outcome);
}

function throwIfRateLimitBlocked(
  outcome: Awaited<ReturnType<CollaborationInviteRateLimiter['consumeInvite']>>,
): void {
  if (outcome.kind === 'denied') throw rateLimited(outcome.decision.retryAfterSeconds);
  if (outcome.kind === 'failed') throw rateLimitUnavailable();
}

function rateLimited(retryAfterSeconds: number): ProductHttpError {
  return new ProductHttpError({
    statusCode: 429,
    code: 'rate_limited',
    message: 'Too many collaboration invite requests. Please try again later.',
    recovery: 'same_request',
    sameRequestRetrySafe: true,
    retryAfterSeconds,
    headers: { 'Retry-After': String(retryAfterSeconds) },
  });
}

function rateLimitUnavailable(): ProductHttpError {
  return new ProductHttpError({
    statusCode: productErrorStatus('feature_temporarily_unavailable'),
    code: 'feature_temporarily_unavailable',
    message: 'Rate limiting service is temporarily unavailable. Please try again later.',
    recovery: 'same_request',
    sameRequestRetrySafe: true,
  });
}

function nowOf(deps: ProductCollaborationRouteDependencies): Date {
  return deps.now?.() ?? new Date();
}

function readOptionalCursor(request: FastifyRequest): string | undefined {
  const query = request.query as Record<string, unknown>;
  if (!Object.hasOwn(query, 'cursor')) return undefined;
  const cursor = query.cursor;
  if (typeof cursor !== 'string' || cursor.length < 1 || cursor.length > 2048) {
    throw invalidCursor();
  }
  return cursor;
}

function invalidCursor(): ProductHttpError {
  return new ProductHttpError({
    statusCode: 400,
    code: 'invalid_cursor',
    message: 'The collaboration list cursor is invalid.',
    recovery: 'restart_from_first_page',
  });
}

function toPrincipal(actor: CollaborationActor) {
  return { principalId: actor.principalId, subjectId: actor.subjectId, kind: 'account' as const };
}

function inviteBody(raw: unknown): { email: string; role: CollaboratorGrantRole } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalidRequest('Request body is invalid.');
  const body = raw as Record<string, unknown>;
  if (typeof body.email !== 'string' || typeof body.role !== 'string') {
    throw invalidRequest('email and role are required.');
  }
  if (body.role !== 'editor' && body.role !== 'viewer') {
    throw invalidRequest('Collaborator grant role is not allowed.');
  }
  return { email: body.email, role: body.role };
}

function rolePatch(raw: unknown): { role: CollaboratorGrantRole } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalidRequest('Request body is invalid.');
  const body = raw as Record<string, unknown>;
  if (body.role !== 'editor' && body.role !== 'viewer') {
    throw invalidRequest('Collaborator grant role is not allowed.');
  }
  return { role: body.role };
}

function readInviteId(request: FastifyRequest): string {
  const value = (request.params as { inviteId?: string }).inviteId;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalidRequest('inviteId path parameter is required.');
  }
  return value;
}

function readSubjectId(request: FastifyRequest): string {
  const value = (request.params as { subjectId?: string }).subjectId;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalidRequest('subjectId path parameter is required.');
  }
  return value;
}

function invalidRequest(message: string): ProductHttpError {
  return new ProductHttpError({ statusCode: 400, code: 'invalid_request', message });
}

export function mapCollaborationHttpError(error: unknown): ProductHttpError {
  if (error instanceof ProductHttpError) return error;
  if (error instanceof CollaborationListCursorError) return invalidCursor();
  if (error instanceof CollaborationPreconditionError) {
    return new ProductHttpError({
      statusCode: 412,
      code: 'precondition_failed',
      message: error.message,
      recovery: 'refresh_and_retry',
      precondition: 'resource',
      currentEtag: error.currentEtag,
    });
  }
  if (!(error instanceof CollaborationError)) {
    return new ProductHttpError({
      statusCode: productErrorStatus('internal_error'),
      code: 'internal_error',
      message: 'The request could not be completed.',
      recovery: 'same_request',
    });
  }
  switch (error.code) {
    case 'conceal':
      return new ProductHttpError({
        statusCode: 404,
        code: 'resource_not_found',
        message: 'The requested resource was not found.',
        recovery: 'none',
      });
    case 'insufficient_role':
      return new ProductHttpError({
        statusCode: 403,
        code: 'insufficient_permission',
        message: 'You do not have permission to perform this action.',
        recovery: 'user_action',
      });
    case 'already_member':
      return conflict(ALREADY_MEMBER_MESSAGE);
    case 'invite_already_pending':
      return conflict(INVITE_ALREADY_PENDING_MESSAGE);
    case 'invite_expired':
    case 'invite_not_pending':
    case 'owner_immutable':
    case 'self_invite':
    case 'member_limit':
    case 'pending_invite_limit':
      return conflict(error.message);
    case 'invalid_email':
    case 'invalid_role':
      return invalidRequest(error.message);
    default: {
      const _exhaustive: never = error.code;
      return invalidRequest(String(_exhaustive));
    }
  }
}

function conflict(message: string): ProductHttpError {
  return new ProductHttpError({
    statusCode: productErrorStatus('mutation_conflict'),
    code: 'mutation_conflict',
    message,
    recovery: 'user_action',
  });
}
