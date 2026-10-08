import type { FastifyInstance, FastifyReply } from 'fastify';
import { canonicalCommandFingerprint } from '../../modules/commands/index.js';
import {
  BookmarkPreferencesError,
  BookmarkPreferencesPreconditionError,
  getBookmarkPreferences,
  parseBookmarkPreferencesPatch,
  updateBookmarkPreferences,
  type BookmarkPreferencesPorts,
  type BookmarkPreferencesStore,
  type BookmarkPreferencesView,
} from '../../modules/identity/index.js';
import { strongEntityTag } from '../../modules/collections/index.js';
import { requireMutationActor } from '../mutation-actor.js';
import { mapCollectionMutationError, mapProductDatabaseError, sendProductCommandReceiptOutcome } from '../product-command-mapping.js';
import { DatabaseOperationError } from '../../infrastructure/database/errors.js';
import { ProductHttpError } from '../product-error.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { requireSessionActor } from '../session-auth.js';
import { readKnownCommandId, readRequiredIfMatch } from './collection-route-helpers.js';
import { httpCommandScopeV1 } from '../http-command-scope.js';
import type { IdentityUnitOfWork } from '../../modules/identity/index.js';

const ROUTE = '/api/v1/me/bookmark-preferences';

export interface BookmarkPreferencesRoutesDeps {
  readonly identityUnitOfWork: IdentityUnitOfWork;
  readonly allowedOrigins: readonly string[];
  readonly csrfMatches?: (raw: string, expectedHash: string) => boolean;
  readonly queryStore: BookmarkPreferencesStore;
  readonly commandUnitOfWork: { execute<Result>(work: (ports: BookmarkPreferencesPorts) => Promise<Result>): Promise<Result> };
}

function sendView(reply: FastifyReply, view: BookmarkPreferencesView): FastifyReply {
  return reply.code(200).header('etag', strongEntityTag(view.revision))
    .header('cache-control', 'private, no-store').send({
      bookmarkInsertPosition: view.bookmarkInsertPosition,
      foldersFirst: view.foldersFirst,
      captureMode: view.captureMode,
      resultPanelAutoDismissMs: view.resultPanelAutoDismissMs,
      learnFromCorrections: view.learnFromCorrections,
      resumeClassificationWhenOnline: view.resumeClassificationWhenOnline,
      aiTagMode: view.aiTagMode,
      subscriptionOnUnfollow: view.subscriptionOnUnfollow,
      subscriptionOnUnsubscribe: view.subscriptionOnUnsubscribe,
      subscriptionDefaultCheckIntervalMinutes: view.subscriptionDefaultCheckIntervalMinutes,
      subscriptionDefaultDigestMode: view.subscriptionDefaultDigestMode,
      subscriptionDefaultEditionLimit: view.subscriptionDefaultEditionLimit,

      revision: view.revision,
      updatedAt: view.updatedAt,
    });
}

function mapError(error: unknown): never {
  if (error instanceof BookmarkPreferencesError) {
    throw new ProductHttpError({ statusCode: 400, code: error.code, message: error.message });
  }
  if (error instanceof BookmarkPreferencesPreconditionError) {
    throw new ProductHttpError({ statusCode: 412, code: error.code, message: error.message,
      recovery: 'refresh_and_retry', precondition: error.precondition, currentEtag: error.currentEtag });
  }
  if (error instanceof DatabaseOperationError) throw mapProductDatabaseError(error);
  const mapped = mapCollectionMutationError(error);
  if (mapped) throw mapped;
  throw error;
}

export function registerBookmarkPreferencesRoutes(app: FastifyInstance, deps: BookmarkPreferencesRoutesDeps): void {
  app.get(ROUTE, {
    exposeHeadRoute: false,
    config: { ...productRouteMetadata('GET', ROUTE), productTransport: {
      allowedQuery: [], cacheControl: 'private-no-store', rejectRequestBody: true,
    } },
  }, async (request, reply) => {
    const actor = await requireSessionActor(request, deps.identityUnitOfWork, { touch: false });
    const { account } = actor;
    // Bind response metadata to the same authenticated request as the preferences.
    // This is a public session ID, never the cookie/token or an account identifier.
    if ('session' in actor) reply.header('Known-Bookmark-Session', actor.session.id);
    try {
      return sendView(reply, await getBookmarkPreferences(deps.queryStore, {
        accountId: account.id, createdAt: account.createdAt,
      }));
    } catch (error: unknown) { mapError(error); }
  });

  app.patch(ROUTE, {
    config: { ...productRouteMetadata('PATCH', ROUTE), productTransport: {
      allowedQuery: [], acceptedMediaTypes: ['application/json'], bodyLimitBytes: 4_096,
      cacheControl: 'private-no-store',
    } },
  }, async (request, reply) => {
    const actor = await requireMutationActor(request, {
      identityUnitOfWork: deps.identityUnitOfWork, allowedOrigins: deps.allowedOrigins,
      csrfMatches: deps.csrfMatches,
    });
    const { account } = actor;
    if ('session' in actor) reply.header('Known-Bookmark-Session', actor.session.id);
    const commandId = readKnownCommandId(request);
    const ifMatch = readRequiredIfMatch(request);
    let patch;
    try { patch = parseBookmarkPreferencesPatch(request.body); } catch (error: unknown) { mapError(error); }
    const fingerprint = canonicalCommandFingerprint({
      method: 'PATCH', route: ROUTE, mediaType: 'application/json', body: patch,
      query: {}, conditions: { ifMatch },
    });
    try {
      const outcome = await deps.commandUnitOfWork.execute((ports) => updateBookmarkPreferences(ports, {
        actor: { principalId: account.id, accountId: account.id, createdAt: account.createdAt },
        commandId, fingerprint, commandScope: httpCommandScopeV1('PATCH', ROUTE), ifMatch, patch,
      }));
      if (outcome.kind !== 'updated') return sendProductCommandReceiptOutcome(reply, outcome);
      return sendView(reply, outcome.preferences);
    } catch (error: unknown) { mapError(error); }
  });
}
