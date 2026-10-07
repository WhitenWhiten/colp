import type { FastifyInstance, FastifyReply } from 'fastify';
import type { IdentityUnitOfWork } from '../../modules/identity/index.js';
import {
  COMMUNITY_COMMENTS_ENDPOINT,
  COMMUNITY_COMMENT_REPLIES_ENDPOINT,
  communityCommentEtag,
  communityCommentSettingsEtag,
  communityCurationEtag,
  createCommunityComment,
  createCommunityCommentCursorCodec,
  deleteCommunityComment,
  editCommunityComment,
  getCommentCuration,
  getCommunityComment,
  getCommunityCommentSettings,
  listCommunityCommentReplies,
  listCommunityComments,
  parseCommunityCommentCreateBody,
  parseCommunityCommentEditBody,
  parseCommunityCommentId,
  parseCommunityCommentRepliesQuery,
  parseCommunityCommentSettingsBody,
  parseCommunityCommentSettingsQuery,
  parseCommunityCommentsQuery,
  parseCommunityCurationBody,
  setCommentCuration,
  setCommunityCommentSettings,
  type CommunityComment,
  type CommunityCommentCommandPorts,
  type CommunityCommentManagePorts,
  type CommunityCommentPageView,
  type CommunityCommentQueryPorts,
  type CommunityCommentSettings,
  type CommunityCuration,
} from '../../modules/community/index.js';
import type { CommunityRateLimiters } from '../http-security.js';
import { readKnownCommandId, readRequiredIfMatch } from './collection-route-helpers.js';
import { sendProductCommandReceiptOutcome } from '../product-command-mapping.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { requireMutationActor } from '../mutation-actor.js';
import {
  communityAdmission,
  communityNotFound,
  communitySessionActor,
  communityUnavailable,
  mapCommunityError,
  withCommunityCancellation,
} from './community-routes.js';

const COMMENTS = '/api/v1/community/comments';
const COMMENT = '/api/v1/community/comments/:commentId';
const REPLIES = '/api/v1/community/comments/:commentId/replies';
const CURATION = '/api/v1/community/comments/:commentId/curation';
const SETTINGS = '/api/v1/community/comment-settings';
const COMMENT_BODY_LIMIT_BYTES = 32_768;
const UNAVAILABLE_MESSAGE = 'Community comments are temporarily unavailable.';

export interface CommunityCommentRoutesDependencies {
  readonly enabled: boolean;
  readonly allowedOrigins: readonly string[];
  readonly identityUnitOfWork: IdentityUnitOfWork;
  /** CS-03: comment/reply read ports (shared target resolution authority). */
  readonly commentQueryUnitOfWork: {
    execute<Result>(
      work: (ports: CommunityCommentQueryPorts) => Promise<Result>,
      options?: { readonly signal?: AbortSignal },
    ): Promise<Result>;
  };
  /** CS-03: comment create command ports (receipt + generation fencing). */
  readonly commentCommandUnitOfWork: {
    execute<Result>(
      work: (ports: CommunityCommentCommandPorts) => Promise<Result>,
      options?: { readonly signal?: AbortSignal },
    ): Promise<Result>;
  };
  /** CS-04: comment management write ports (edit/delete/curation/settings CAS). */
  readonly commentManageUnitOfWork: {
    execute<Result>(
      work: (ports: CommunityCommentManagePorts) => Promise<Result>,
      options?: { readonly signal?: AbortSignal },
    ): Promise<Result>;
  };
  /**
   * CS contract families: the three public comment reads consume
   * `publicReads`; comment create/edit/delete consume `comment`; the
   * curation and comment-settings surface consumes `curation`.
   */
  readonly rateLimits: CommunityRateLimiters;
  readonly timeoutMs: number;
  /** COMMUNITY_CURSOR_HMAC_KEY: keyed ETag + opaque cursor derivation. */
  readonly etagHmacKey: Buffer;
  readonly csrfMatches?: (raw: string, expectedHash: string) => boolean;
  readonly createComment?: typeof createCommunityComment;
  readonly listComments?: typeof listCommunityComments;
  readonly getComment?: typeof getCommunityComment;
  readonly listReplies?: typeof listCommunityCommentReplies;
  readonly editComment?: typeof editCommunityComment;
  readonly deleteComment?: typeof deleteCommunityComment;
  readonly getCuration?: typeof getCommentCuration;
  readonly setCuration?: typeof setCommentCuration;
  readonly getSettings?: typeof getCommunityCommentSettings;
  readonly setSettings?: typeof setCommunityCommentSettings;
}

/**
 * CS-03 comment routes: the two list/get reads are anonymous-safe public
 * operations; create requires the same session + Origin + CSRF +
 * Known-Command-Id admission as the CS-01 vote. Both cursor codecs are
 * endpoint-bound derivations of the configured community HMAC key.
 */
export function registerCommunityCommentRoutes(
  app: FastifyInstance,
  deps: CommunityCommentRoutesDependencies,
): void {
  const unavailable = () => communityUnavailable(UNAVAILABLE_MESSAGE);
  const commentsCursorCodec = createCommunityCommentCursorCodec(
    deps.etagHmacKey, COMMUNITY_COMMENTS_ENDPOINT,
  );
  const repliesCursorCodec = createCommunityCommentCursorCodec(
    deps.etagHmacKey, COMMUNITY_COMMENT_REPLIES_ENDPOINT,
  );
  app.get(COMMENTS, {
    exposeHeadRoute: false,
    config: {
      ...productRouteMetadata('GET', '/api/v1/community/comments'),
      productTransport: {
        allowedQuery: ['kind', 'id', 'collectionId', 'seriesId', 'generation', 'limit', 'cursor'],
        duplicateQueryErrorCode: 'invalid_query',
        queryErrorCode: 'invalid_query',
        cacheControl: 'private-no-store',
      },
    },
    onRequest: communityAdmission(deps, 'publicReads'),
  }, async (request, reply) => {
    if (!deps.enabled) throw communityNotFound();
    const session = await communitySessionActor(request, deps.identityUnitOfWork);
    const viewer = session === null
      ? { accountId: null, subjectId: null }
      : { accountId: session.account.id, subjectId: session.account.subjectId };
    let query;
    try {
      query = parseCommunityCommentsQuery(request.query as Record<string, unknown>);
    } catch (error) {
      throw mapCommunityError(error);
    }
    try {
      const page = await withCommunityCancellation(request, deps.timeoutMs, (signal) =>
        deps.commentQueryUnitOfWork.execute((ports) =>
          (deps.listComments ?? listCommunityComments)(ports, {
            viewer, query, cursorCodec: commentsCursorCodec,
          }), { signal }), unavailable);
      return sendCommentPage(reply, page);
    } catch (error) {
      throw mapCommunityError(error);
    }
  });

  app.post(COMMENTS, {
    exposeHeadRoute: false,
    config: {
      ...productRouteMetadata('POST', '/api/v1/community/comments'),
      productTransport: {
        allowedQuery: [],
        acceptedMediaTypes: ['application/json'],
        bodyLimitBytes: COMMENT_BODY_LIMIT_BYTES,
        cacheControl: 'private-no-store',
      },
    },
    onRequest: communityAdmission(deps, 'comment'),
  }, async (request, reply) => {
    const { account } = await requireMutationActor(request, {
      identityUnitOfWork: deps.identityUnitOfWork,
      allowedOrigins: deps.allowedOrigins,
      csrfMatches: deps.csrfMatches,
    });
    if (!deps.enabled) throw communityNotFound();
    let parsed;
    try {
      // Closed CreateComment object: unknown keys, missing replyToId, and
      // unnormalized/over-length bodies reject here at the wire boundary;
      // the command re-validates before writing.
      parsed = parseCommunityCommentCreateBody(request.body);
    } catch (error) {
      throw mapCommunityError(error);
    }
    const input = {
      actor: { principalId: account.id, subjectId: account.subjectId },
      target: parsed.target,
      body: parsed.body,
      replyToId: parsed.replyToId,
      commandId: readKnownCommandId(request),
    } as const;
    try {
      const outcome = await withCommunityCancellation(request, deps.timeoutMs, (signal) =>
        deps.commentCommandUnitOfWork.execute((ports) =>
          (deps.createComment ?? createCommunityComment)(ports, input),
        { signal }), unavailable);
      if (outcome.kind !== 'succeeded') return sendProductCommandReceiptOutcome(reply, outcome);
      return sendComment(reply, 201, outcome.comment, deps.etagHmacKey);
    } catch (error) {
      throw mapCommunityError(error);
    }
  });

  app.get(COMMENT, {
    exposeHeadRoute: false,
    config: {
      ...productRouteMetadata('GET', '/api/v1/community/comments/{commentId}'),
      productTransport: {
        allowedQuery: [],
        duplicateQueryErrorCode: 'invalid_query',
        queryErrorCode: 'invalid_query',
        cacheControl: 'private-no-store',
      },
    },
    onRequest: communityAdmission(deps, 'publicReads'),
  }, async (request, reply) => {
    if (!deps.enabled) throw communityNotFound();
    const session = await communitySessionActor(request, deps.identityUnitOfWork);
    const viewer = session === null
      ? { accountId: null, subjectId: null }
      : { accountId: session.account.id, subjectId: session.account.subjectId };
    let commentId;
    try {
      commentId = parseCommunityCommentId((request.params as Record<string, unknown>).commentId);
    } catch (error) {
      throw mapCommunityError(error);
    }
    try {
      const comment = await withCommunityCancellation(request, deps.timeoutMs, (signal) =>
        deps.commentQueryUnitOfWork.execute((ports) =>
          (deps.getComment ?? getCommunityComment)(ports, { viewer, commentId }), { signal }),
        unavailable);
      return sendComment(reply, 200, comment, deps.etagHmacKey);
    } catch (error) {
      throw mapCommunityError(error);
    }
  });

  app.get(REPLIES, {
    exposeHeadRoute: false,
    config: {
      ...productRouteMetadata('GET', '/api/v1/community/comments/{commentId}/replies'),
      productTransport: {
        allowedQuery: ['limit', 'cursor'],
        duplicateQueryErrorCode: 'invalid_query',
        queryErrorCode: 'invalid_query',
        cacheControl: 'private-no-store',
      },
    },
    onRequest: communityAdmission(deps, 'publicReads'),
  }, async (request, reply) => {
    if (!deps.enabled) throw communityNotFound();
    const session = await communitySessionActor(request, deps.identityUnitOfWork);
    const viewer = session === null
      ? { accountId: null, subjectId: null }
      : { accountId: session.account.id, subjectId: session.account.subjectId };
    let commentId;
    let query;
    try {
      commentId = parseCommunityCommentId((request.params as Record<string, unknown>).commentId);
      query = parseCommunityCommentRepliesQuery(request.query as Record<string, unknown>);
    } catch (error) {
      throw mapCommunityError(error);
    }
    try {
      const page = await withCommunityCancellation(request, deps.timeoutMs, (signal) =>
        deps.commentQueryUnitOfWork.execute((ports) =>
          (deps.listReplies ?? listCommunityCommentReplies)(ports, {
            viewer, commentId, query, cursorCodec: repliesCursorCodec,
          }), { signal }), unavailable);
      return sendCommentPage(reply, page);
    } catch (error) {
      throw mapCommunityError(error);
    }
  });

  /* ------------------------------------------------------------ */
  /* CS-04: author edit/delete, curator curation, area settings.   */
  /* ------------------------------------------------------------ */

  const manageActor = async (request: Parameters<typeof requireMutationActor>[0]) => {
    const { account } = await requireMutationActor(request, {
      identityUnitOfWork: deps.identityUnitOfWork,
      allowedOrigins: deps.allowedOrigins,
      csrfMatches: deps.csrfMatches,
    });
    return { principalId: account.id, subjectId: account.subjectId } as const;
  };

  app.patch(COMMENT, {
    exposeHeadRoute: false,
    config: {
      ...productRouteMetadata('PATCH', '/api/v1/community/comments/{commentId}'),
      productTransport: {
        allowedQuery: [],
        acceptedMediaTypes: ['application/json'],
        bodyLimitBytes: COMMENT_BODY_LIMIT_BYTES,
        cacheControl: 'private-no-store',
      },
    },
    onRequest: communityAdmission(deps, 'comment'),
  }, async (request, reply) => {
    const actor = await manageActor(request);
    if (!deps.enabled) throw communityNotFound();
    let body: string;
    try {
      // Closed EditComment object {body}: unknown keys and unnormalized
      // bodies reject at the wire boundary; the command re-validates.
      body = parseCommunityCommentEditBody(request.body);
    } catch (error) {
      throw mapCommunityError(error);
    }
    const input = {
      actor,
      commentId: (request.params as Record<string, unknown>).commentId,
      body,
      ifMatch: readRequiredIfMatch(request),
      commandId: readKnownCommandId(request),
    } as const;
    try {
      const outcome = await withCommunityCancellation(request, deps.timeoutMs, (signal) =>
        deps.commentManageUnitOfWork.execute((ports) =>
          (deps.editComment ?? editCommunityComment)(ports, input),
        { signal }), unavailable);
      if (outcome.kind !== 'succeeded') return sendProductCommandReceiptOutcome(reply, outcome);
      return sendComment(reply, 200, outcome.value, deps.etagHmacKey);
    } catch (error) {
      throw mapCommunityError(error);
    }
  });

  app.delete(COMMENT, {
    exposeHeadRoute: false,
    config: {
      ...productRouteMetadata('DELETE', '/api/v1/community/comments/{commentId}'),
      productTransport: {
        allowedQuery: [],
        cacheControl: 'private-no-store',
      },
    },
    onRequest: communityAdmission(deps, 'comment'),
  }, async (request, reply) => {
    const actor = await manageActor(request);
    if (!deps.enabled) throw communityNotFound();
    const input = {
      actor,
      commentId: (request.params as Record<string, unknown>).commentId,
      ifMatch: readRequiredIfMatch(request),
      commandId: readKnownCommandId(request),
    } as const;
    try {
      const outcome = await withCommunityCancellation(request, deps.timeoutMs, (signal) =>
        deps.commentManageUnitOfWork.execute((ports) =>
          (deps.deleteComment ?? deleteCommunityComment)(ports, input),
        { signal }), unavailable);
      if (outcome.kind !== 'succeeded') return sendProductCommandReceiptOutcome(reply, outcome);
      return sendComment(reply, 200, outcome.value, deps.etagHmacKey);
    } catch (error) {
      throw mapCommunityError(error);
    }
  });

  app.get(CURATION, {
    exposeHeadRoute: false,
    config: {
      ...productRouteMetadata('GET', '/api/v1/community/comments/{commentId}/curation'),
      productTransport: {
        allowedQuery: [],
        duplicateQueryErrorCode: 'invalid_query',
        queryErrorCode: 'invalid_query',
        cacheControl: 'private-no-store',
      },
    },
    onRequest: communityAdmission(deps, 'curation'),
  }, async (request, reply) => {
    if (!deps.enabled) throw communityNotFound();
    const session = await communitySessionActor(request, deps.identityUnitOfWork);
    const viewer = session === null
      ? { accountId: null, subjectId: null }
      : { accountId: session.account.id, subjectId: session.account.subjectId };
    let commentId;
    try {
      commentId = parseCommunityCommentId((request.params as Record<string, unknown>).commentId);
    } catch (error) {
      throw mapCommunityError(error);
    }
    try {
      const curation = await withCommunityCancellation(request, deps.timeoutMs, (signal) =>
        deps.commentQueryUnitOfWork.execute((ports) =>
          (deps.getCuration ?? getCommentCuration)(ports, { viewer, commentId }), { signal }),
        unavailable);
      return sendCuration(reply, curation, deps.etagHmacKey);
    } catch (error) {
      throw mapCommunityError(error);
    }
  });

  app.put(CURATION, {
    exposeHeadRoute: false,
    config: {
      ...productRouteMetadata('PUT', '/api/v1/community/comments/{commentId}/curation'),
      productTransport: {
        allowedQuery: [],
        acceptedMediaTypes: ['application/json'],
        bodyLimitBytes: COMMENT_BODY_LIMIT_BYTES,
        cacheControl: 'private-no-store',
      },
    },
    onRequest: communityAdmission(deps, 'curation'),
  }, async (request, reply) => {
    const actor = await manageActor(request);
    if (!deps.enabled) throw communityNotFound();
    let write;
    try {
      // Closed {hidden, reason} object: unknown keys and bad fields
      // reject at the wire boundary; the command re-validates.
      write = parseCommunityCurationBody(request.body);
    } catch (error) {
      throw mapCommunityError(error);
    }
    const input = {
      actor,
      commentId: (request.params as Record<string, unknown>).commentId,
      hidden: write.hidden,
      reason: write.reason,
      ifMatch: readRequiredIfMatch(request),
      commandId: readKnownCommandId(request),
    } as const;
    try {
      const outcome = await withCommunityCancellation(request, deps.timeoutMs, (signal) =>
        deps.commentManageUnitOfWork.execute((ports) =>
          (deps.setCuration ?? setCommentCuration)(ports, input),
        { signal }), unavailable);
      if (outcome.kind !== 'succeeded') return sendProductCommandReceiptOutcome(reply, outcome);
      return sendCuration(reply, outcome.value, deps.etagHmacKey);
    } catch (error) {
      throw mapCommunityError(error);
    }
  });

  app.get(SETTINGS, {
    exposeHeadRoute: false,
    config: {
      ...productRouteMetadata('GET', '/api/v1/community/comment-settings'),
      productTransport: {
        allowedQuery: ['kind', 'id', 'collectionId', 'seriesId', 'generation'],
        duplicateQueryErrorCode: 'invalid_query',
        queryErrorCode: 'invalid_query',
        cacheControl: 'private-no-store',
      },
    },
    onRequest: communityAdmission(deps, 'curation'),
  }, async (request, reply) => {
    if (!deps.enabled) throw communityNotFound();
    const session = await communitySessionActor(request, deps.identityUnitOfWork);
    const viewer = session === null
      ? { accountId: null, subjectId: null }
      : { accountId: session.account.id, subjectId: session.account.subjectId };
    let query;
    try {
      query = parseCommunityCommentSettingsQuery(request.query as Record<string, unknown>);
    } catch (error) {
      throw mapCommunityError(error);
    }
    try {
      const settings = await withCommunityCancellation(request, deps.timeoutMs, (signal) =>
        deps.commentQueryUnitOfWork.execute((ports) =>
          (deps.getSettings ?? getCommunityCommentSettings)(ports, { viewer, query }), { signal }),
        unavailable);
      return sendSettings(reply, settings, deps.etagHmacKey);
    } catch (error) {
      throw mapCommunityError(error);
    }
  });

  app.put(SETTINGS, {
    exposeHeadRoute: false,
    config: {
      ...productRouteMetadata('PUT', '/api/v1/community/comment-settings'),
      productTransport: {
        allowedQuery: [],
        acceptedMediaTypes: ['application/json'],
        bodyLimitBytes: COMMENT_BODY_LIMIT_BYTES,
        cacheControl: 'private-no-store',
      },
    },
    onRequest: communityAdmission(deps, 'curation'),
  }, async (request, reply) => {
    const actor = await manageActor(request);
    if (!deps.enabled) throw communityNotFound();
    let write;
    try {
      // Closed PutCommentSettings {target, locked, reason}: unknown keys
      // and bad fields reject at the wire boundary; the command re-validates.
      write = parseCommunityCommentSettingsBody(request.body);
    } catch (error) {
      throw mapCommunityError(error);
    }
    const input = {
      actor,
      target: write.target,
      locked: write.locked,
      reason: write.reason,
      ifMatch: readRequiredIfMatch(request),
      commandId: readKnownCommandId(request),
    } as const;
    try {
      const outcome = await withCommunityCancellation(request, deps.timeoutMs, (signal) =>
        deps.commentManageUnitOfWork.execute((ports) =>
          (deps.setSettings ?? setCommunityCommentSettings)(ports, input),
        { signal }), unavailable);
      if (outcome.kind !== 'succeeded') return sendProductCommandReceiptOutcome(reply, outcome);
      return sendSettings(reply, outcome.value, deps.etagHmacKey);
    } catch (error) {
      throw mapCommunityError(error);
    }
  });
}

function sendCommentPage(reply: FastifyReply, page: CommunityCommentPageView) {
  return reply
    .code(200)
    .type('application/json; charset=utf-8')
    .header('cache-control', 'private, no-store')
    .send({
      items: page.items,
      nextCursor: page.nextCursor,
    });
}

function sendComment(
  reply: FastifyReply,
  status: 200 | 201,
  comment: CommunityComment,
  hmacKey: Buffer,
) {
  return reply
    .code(status)
    .type('application/json; charset=utf-8')
    .header('cache-control', 'private, no-store')
    .header('etag', communityCommentEtag(comment, hmacKey))
    .send(comment);
}

function sendCuration(reply: FastifyReply, curation: CommunityCuration, hmacKey: Buffer) {
  return reply
    .code(200)
    .type('application/json; charset=utf-8')
    .header('cache-control', 'private, no-store')
    .header('etag', communityCurationEtag(curation, hmacKey))
    .send(curation);
}

function sendSettings(reply: FastifyReply, settings: CommunityCommentSettings, hmacKey: Buffer) {
  return reply
    .code(200)
    .type('application/json; charset=utf-8')
    .header('cache-control', 'private, no-store')
    .header('etag', communityCommentSettingsEtag(settings, hmacKey))
    .send(settings);
}
