import type { FastifyInstance, FastifyReply } from 'fastify';
import type { IdentityUnitOfWork } from '../../modules/identity/index.js';
import {
  communityNotificationPreferenceEtag,
  createCommunityNotificationCursorCodec,
  getCommunityNotificationPreference,
  listCommunityNotifications,
  markCommunityNotificationsRead,
  parseCommunityNotificationReadBody,
  parseCommunityNotificationPreferenceBody,
  parseCommunityNotificationsQuery,
  putCommunityNotificationPreference,
  type CommunityInbox,
  type CommunityNotificationCommandPorts,
  type CommunityNotificationPreference,
  type CommunityNotificationQueryPorts,
} from '../../modules/community/index.js';
import type { CommunityRateLimiters } from '../http-security.js';
import { readKnownCommandId, readRequiredIfMatch } from './collection-route-helpers.js';
import { sendProductCommandReceiptOutcome } from '../product-command-mapping.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { requireSessionActor } from '../session-auth.js';
import { requireMutationActor } from '../mutation-actor.js';
import {
  communityAdmission,
  communityNotFound,
  communityUnavailable,
  mapCommunityError,
  withCommunityCancellation,
} from './community-routes.js';

const INBOX = '/api/v1/me/community-notifications';
const INBOX_READ = '/api/v1/me/community-notifications/read';
const PREFERENCES = '/api/v1/me/community-notification-preferences';
const BODY_LIMIT_BYTES = 32_768;
const UNAVAILABLE_MESSAGE = 'Community notifications are temporarily unavailable.';

export interface CommunityNotificationRoutesDependencies {
  readonly enabled: boolean;
  readonly allowedOrigins: readonly string[];
  readonly identityUnitOfWork: IdentityUnitOfWork;
  /** CS-05: inbox + preference read ports. */
  readonly notificationQueryUnitOfWork: {
    execute<Result>(
      work: (ports: CommunityNotificationQueryPorts) => Promise<Result>,
      options?: { readonly signal?: AbortSignal },
    ): Promise<Result>;
  };
  /** CS-05: read + preference write ports (receipt + CAS). */
  readonly notificationCommandUnitOfWork: {
    execute<Result>(
      work: (ports: CommunityNotificationCommandPorts) => Promise<Result>,
      options?: { readonly signal?: AbortSignal },
    ): Promise<Result>;
  };
  /**
   * CS contract families: the per-recipient inbox/preference surface
   * consumes `publicReads` (account-keyed — every endpoint requires a
   * session, so the trusted-client fallback only ever bounds anonymous
   * attempts).
   */
  readonly rateLimits: CommunityRateLimiters;
  readonly timeoutMs: number;
  /** COMMUNITY_CURSOR_HMAC_KEY: keyed ETag + opaque cursor derivation. */
  readonly etagHmacKey: Buffer;
  readonly csrfMatches?: (raw: string, expectedHash: string) => boolean;
  readonly listNotifications?: typeof listCommunityNotifications;
  readonly readNotifications?: typeof markCommunityNotificationsRead;
  readonly getPreference?: typeof getCommunityNotificationPreference;
  readonly putPreference?: typeof putCommunityNotificationPreference;
}

/**
 * CS-05 community notification routes: the two reads require a session
 * (401 for anonymous — the inbox is per-recipient); the two mutations add
 * Origin + CSRF + Known-Command-Id admission, If-Match for the preference
 * CAS, and durable command receipts for exact replay.
 */
export function registerCommunityNotificationRoutes(
  app: FastifyInstance,
  deps: CommunityNotificationRoutesDependencies,
): void {
  const unavailable = () => communityUnavailable(UNAVAILABLE_MESSAGE);
  const inboxCursorCodec = createCommunityNotificationCursorCodec(deps.etagHmacKey);

  app.get(INBOX, {
    exposeHeadRoute: false,
    config: {
      ...productRouteMetadata('GET', INBOX),
      productTransport: {
        allowedQuery: ['read', 'limit', 'cursor'],
        duplicateQueryErrorCode: 'invalid_query',
        queryErrorCode: 'invalid_query',
        cacheControl: 'private-no-store',
      },
    },
    onRequest: communityAdmission(deps, 'publicReads'),
  }, async (request, reply) => {
    if (!deps.enabled) throw communityNotFound();
    const { account } = await requireSessionActor(request, deps.identityUnitOfWork, { touch: false });
    let query;
    try {
      query = parseCommunityNotificationsQuery(request.query as Record<string, unknown>);
    } catch (error) {
      throw mapCommunityError(error);
    }
    try {
      const inbox = await withCommunityCancellation(request, deps.timeoutMs, (signal) =>
        deps.notificationQueryUnitOfWork.execute((ports) =>
          (deps.listNotifications ?? listCommunityNotifications)(ports, {
            viewer: { accountId: account.id, subjectId: account.subjectId },
            query,
            cursorCodec: inboxCursorCodec,
          }), { signal }), unavailable);
      return sendInbox(reply, inbox);
    } catch (error) {
      throw mapCommunityError(error);
    }
  });

  app.post(INBOX_READ, {
    exposeHeadRoute: false,
    config: {
      ...productRouteMetadata('POST', INBOX_READ),
      productTransport: {
        allowedQuery: [],
        acceptedMediaTypes: ['application/json'],
        bodyLimitBytes: BODY_LIMIT_BYTES,
        cacheControl: 'private-no-store',
      },
    },
    onRequest: communityAdmission(deps, 'publicReads'),
  }, async (request, reply) => {
    const { account } = await requireMutationActor(request, {
      identityUnitOfWork: deps.identityUnitOfWork,
      allowedOrigins: deps.allowedOrigins,
      csrfMatches: deps.csrfMatches,
    });
    if (!deps.enabled) throw communityNotFound();
    let ids: readonly string[];
    try {
      ids = parseCommunityNotificationReadBody(request.body);
    } catch (error) {
      throw mapCommunityError(error);
    }
    const input = {
      actor: { principalId: account.id, subjectId: account.subjectId },
      ids,
      commandId: readKnownCommandId(request),
    } as const;
    try {
      const outcome = await withCommunityCancellation(request, deps.timeoutMs, (signal) =>
        deps.notificationCommandUnitOfWork.execute((ports) =>
          (deps.readNotifications ?? markCommunityNotificationsRead)(ports, input),
        { signal }), unavailable);
      if (outcome.kind !== 'succeeded') return sendProductCommandReceiptOutcome(reply, outcome);
      return sendReadResult(reply, outcome.value);
    } catch (error) {
      throw mapCommunityError(error);
    }
  });

  app.get(PREFERENCES, {
    exposeHeadRoute: false,
    config: {
      ...productRouteMetadata('GET', PREFERENCES),
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
    const { account } = await requireSessionActor(request, deps.identityUnitOfWork, { touch: false });
    try {
      const preference = await withCommunityCancellation(request, deps.timeoutMs, (signal) =>
        deps.notificationQueryUnitOfWork.execute((ports) =>
          (deps.getPreference ?? getCommunityNotificationPreference)(ports, {
            viewer: { accountId: account.id, subjectId: account.subjectId },
          }), { signal }), unavailable);
      return sendPreference(reply, preference, account.id, deps.etagHmacKey);
    } catch (error) {
      throw mapCommunityError(error);
    }
  });

  app.put(PREFERENCES, {
    exposeHeadRoute: false,
    config: {
      ...productRouteMetadata('PUT', PREFERENCES),
      productTransport: {
        allowedQuery: [],
        acceptedMediaTypes: ['application/json'],
        bodyLimitBytes: BODY_LIMIT_BYTES,
        cacheControl: 'private-no-store',
      },
    },
    onRequest: communityAdmission(deps, 'publicReads'),
  }, async (request, reply) => {
    const { account } = await requireMutationActor(request, {
      identityUnitOfWork: deps.identityUnitOfWork,
      allowedOrigins: deps.allowedOrigins,
      csrfMatches: deps.csrfMatches,
    });
    if (!deps.enabled) throw communityNotFound();
    let enabled: boolean;
    try {
      enabled = parseCommunityNotificationPreferenceBody(request.body);
    } catch (error) {
      throw mapCommunityError(error);
    }
    const input = {
      actor: { principalId: account.id, subjectId: account.subjectId },
      enabled,
      ifMatch: readRequiredIfMatch(request),
      commandId: readKnownCommandId(request),
    } as const;
    try {
      const outcome = await withCommunityCancellation(request, deps.timeoutMs, (signal) =>
        deps.notificationCommandUnitOfWork.execute((ports) =>
          (deps.putPreference ?? putCommunityNotificationPreference)(ports, input),
        { signal }), unavailable);
      if (outcome.kind !== 'succeeded') return sendProductCommandReceiptOutcome(reply, outcome);
      return sendPreference(reply, outcome.value, account.id, deps.etagHmacKey);
    } catch (error) {
      throw mapCommunityError(error);
    }
  });
}

function sendInbox(reply: FastifyReply, inbox: CommunityInbox) {
  return reply
    .code(200)
    .type('application/json; charset=utf-8')
    .header('cache-control', 'private, no-store')
    .send(inbox);
}

function sendReadResult(
  reply: FastifyReply,
  result: { readonly changedIds: readonly string[]; readonly unreadCount: number },
) {
  return reply
    .code(200)
    .type('application/json; charset=utf-8')
    .header('cache-control', 'private, no-store')
    .send(result);
}

function sendPreference(
  reply: FastifyReply,
  preference: CommunityNotificationPreference,
  recipientAccountId: string,
  hmacKey: Buffer,
) {
  return reply
    .code(200)
    .type('application/json; charset=utf-8')
    .header('cache-control', 'private, no-store')
    .header('etag', communityNotificationPreferenceEtag({
      recipientAccountId,
      revision: preference.revision,
    }, hmacKey))
    .send(preference);
}
