import {
  createProductCollaborationClient,
  createProductCommunityClient,
  createProductFeedClient,
  createProductCollectionFollowClient,
  createProductFollowClient,
  createProductLibraryOrderClient,
  createProductNotificationClient,
  createProductPublishingInsightsClient,
  createProductReportsClient,
  createProductGovernanceClient,
  type CollectionInviteCreated,
  type CollectionMemberRoleMergePatch,
  type CollectionMembersPage,
  type CollaborationMembershipResult,
  type MyCollaborationInvitesPage,
  type SharedCollectionPage,
  type ProductFeedPage,
  type CollectionFollowState,
  type CommunityComment,
  type CommunityCommentPage,
  type CommunityCommentRepliesQuery,
  type CommunityCommentSettings,
  type CommunityCommentSettingsQuery,
  type CommunityCommentsQuery,
  type CommunityCreateComment,
  type CommunityCuration,
  type CommunityEditComment,
  type CommunityEntityResult,
  type CommunityNotificationInbox,
  type CommunityNotificationPreference,
  type CommunityNotificationsQuery,
  type CommunityPutCommentSettings,
  type CommunityPutCuration,
  type CommunityPutNotificationPreference,
  type CommunityReadNotifications,
  type CommunityReadNotificationsResult,
  type CommunityRankingPage,
  type CommunityRankingQuery,
  type CommunityTarget,
  type CommunityTargetView,
  type CommunityVoteRequest,
  type CommunityVoteState,
  type FollowedCollectionPage,
  type LibraryOrderSectionName,
  type LibraryOrderSectionView,
  type LibraryOrderUpdateRequest,
  type LibraryOrderView,
  type FollowPage,
  type FollowRelation,
  type FollowingPage,
  type InviteCollectionMemberRequest,
  type NotificationBulkReadResult,
  type NotificationInboxPage,
  type NotificationPreference,
  type NotificationPreferenceUpdateResult,
  type NotificationReadResult,
  type PublishingInsights,
  type RecordInsightEventRequest,
  type PublicReportIssue,
  type PublicReportIssuePage,
  type PublicReportPage,
  type PublicReportSeries,
  type ReportEdition,
  type ReportEditionAttach,
  type ReportEditionPage,
  type ReportEditionPatch,
  type ReportFollowState,
  type ReportIssueTimelinePage,
  type ReportMember,
  type ReportMemberMutation,
  type ReportMemberPage,
  type ReportSchedule,
  type ReportScheduleEnvelope,
  type ReportScheduleInput,
  type ReportSeries,
  type ReportSeriesCreate,
  type ReportSeriesPage,
  type ReportSeriesPatch,
  type GovernanceCatalog,
  type GovernanceCatalogPatch,
  type GovernanceCatalogPreferences,
  type GovernanceCatalogPreferencesPatch,
  type GovernanceEvidence,
  type GovernanceMyCase,
  type GovernanceMyCasePage,
  type GovernanceOfficialCase,
  type GovernanceOfficialCasePage,
  type GovernanceReportInput,
  type GovernanceCasePatch,
  type GovernanceActionInput,
  type GovernanceAction,
  type GovernanceMyActionPage,
  type GovernanceAppeal,
  type GovernanceAppealInput,
  type GovernanceAppealPage,
  type GovernanceAppealDecision,
} from '@known/product-v1-client'
import { getApiBaseUrl } from './config'
import { clearCommandId, getOrCreateCommandId } from './commandId'
import { ProductApiError } from './errors'
import {
  withSameRequestRetry,
  wrapGeneratedFollowError,
  type MutationCall,
  type MutationOptions,
  type ReadOptions,
} from './product-client-shared'
import { timedFetch } from './requestTimeout'
import { productRequestCredentials } from './product-credentials'
import { getCsrfToken } from './sessionStore'
import type { CollectionKind, CollectionVisibility } from './types'

type OwnedCollectionQuery = {
  kind?: CollectionKind
  visibility?: CollectionVisibility
  limit?: number
}

export type RecordPublicCollectionInsightEventInput =
  | { slug: string; eventType: 'collection_view' | 'preview_open' }
  | { slug: string; eventType: 'resource_open'; nodeId: string }

export type RecordPublicCollectionInsightEventOptions = {
  signal?: AbortSignal
  keepalive?: boolean
}

/** Apply the same actor/cookie boundary as the hand-written Product transport. */
function timedProductFetch(signal?: AbortSignal): typeof globalThis.fetch {
  const transport = timedFetch(signal)
  return (input, init) => transport(input, {
    ...init,
    credentials: productRequestCredentials(init?.method ?? (input instanceof Request ? input.method : 'GET')),
  })
}

/** CS-01 community target selector (resolveCommunityTarget query shape). */
export type CommunityTargetQuery = {
  kind: 'collection' | 'bookmark' | 'digest_series' | 'digest_edition'
  id: string
  collectionId?: string
  seriesId?: string
}

/** CS-02 community hot ranking query (listCommunityRanking query shape). */
export type CommunityRankingQueryParams = CommunityRankingQuery

/** CS-03 community comments query (listCommunityComments query shape). */
export type CommunityCommentsQueryParams = CommunityCommentsQuery

/** CS-03 community comment replies query (listCommunityCommentReplies query shape). */
export type CommunityCommentRepliesQueryParams = CommunityCommentRepliesQuery

/** CS-04 comment-area settings query (getCommunityCommentSettings query shape). */
export type CommunityCommentSettingsQueryParams = CommunityCommentSettingsQuery

/** CS-05 community notifications inbox query (listMyCommunityNotifications query shape). */
export type CommunityNotificationsQueryParams = CommunityNotificationsQuery

/** Waits for `promise`, rejecting with AbortError as soon as `signal` aborts. */
function abortableWait<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}

export function createProductGeneratedClient(
  mutationCall: MutationCall,
  requireCsrf: () => Promise<string>,
) {
  function collectionFollowClient(csrfToken: string, signal?: AbortSignal) {
    const configured = getApiBaseUrl()
    const origin = configured || globalThis.location?.origin || 'http://localhost'
    const fetchWithSignal = timedProductFetch(signal)
    return createProductCollectionFollowClient({
      origin,
      csrfToken,
      fetch: fetchWithSignal,
    })
  }

  function libraryOrderClient(csrfToken: string, signal?: AbortSignal) {
    const configured = getApiBaseUrl()
    const origin = configured || globalThis.location?.origin || 'http://localhost'
    const fetchWithSignal = timedProductFetch(signal)
    return createProductLibraryOrderClient({
      origin,
      csrfToken,
      fetch: fetchWithSignal,
    })
  }

  function followClient(csrfToken: string, signal?: AbortSignal) {
    const configured = getApiBaseUrl()
    const origin = configured || globalThis.location?.origin || 'http://localhost'
    const fetchWithSignal = timedProductFetch(signal)
    return createProductFollowClient({
      origin,
      csrfToken,
      fetch: fetchWithSignal,
    })
  }

  function feedClient(signal?: AbortSignal) {
    const configured = getApiBaseUrl()
    const origin = configured || globalThis.location?.origin || 'http://localhost'
    const fetchWithSignal = timedProductFetch(signal)
    return createProductFeedClient({ origin, fetch: fetchWithSignal })
  }

  function notificationClient(csrfToken = '', signal?: AbortSignal) {
    const configured = getApiBaseUrl()
    const origin = configured || globalThis.location?.origin || 'http://localhost'
    const fetchWithSignal = timedProductFetch(signal)
    return createProductNotificationClient({
      origin,
      csrfToken,
      ...(typeof globalThis.location?.origin === 'string'
        ? { originHeader: globalThis.location.origin }
        : {}),
      fetch: fetchWithSignal,
    })
  }

  async function getNotificationPage(
    query: { state?: 'all' | 'read' | 'unread'; cursor?: string; limit?: number } = {},
    options?: ReadOptions,
  ): Promise<NotificationInboxPage> {
    return withSameRequestRetry(async () => {
      try {
        return await notificationClient('', options?.signal).notifications(query)
      } catch (error) {
        throw wrapGeneratedFollowError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function markNotificationRead(
    notificationId: string,
    stateRevision: string,
    options: MutationOptions,
  ): Promise<NotificationReadResult> {
    return mutationCall(async (csrf, intentId) => {
      try {
        return await notificationClient(csrf, options.signal).markOne(
          notificationId,
          stateRevision,
          getOrCreateCommandId(intentId),
        )
      } catch (error) {
        throw wrapGeneratedFollowError(error)
      }
    }, { ...options, rotateCommandOnConflict: false })
  }

  async function markNotificationsRead(
    notificationIds: readonly string[],
    options: MutationOptions,
  ): Promise<NotificationBulkReadResult> {
    return mutationCall(async (csrf, intentId) => {
      try {
        return await notificationClient(csrf, options.signal).markMany(
          notificationIds,
          getOrCreateCommandId(intentId),
        )
      } catch (error) {
        throw wrapGeneratedFollowError(error)
      }
    }, { ...options, rotateCommandOnConflict: false })
  }

  async function getNotificationPreference(options?: ReadOptions): Promise<NotificationPreference> {
    return withSameRequestRetry(async () => {
      try {
        return await notificationClient('', options?.signal).preferences()
      } catch (error) {
        throw wrapGeneratedFollowError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function updateNotificationPreference(
    channel: 'in_app' | 'email',
    value: { readonly mode: 'set'; readonly enabled: boolean } | { readonly mode: 'reset' },
    revision: string,
    options: MutationOptions,
  ): Promise<NotificationPreferenceUpdateResult> {
    return mutationCall(async (csrf, intentId) => {
      try {
        return await notificationClient(csrf, options.signal).updatePreference(
          channel,
          value,
          revision,
          getOrCreateCommandId(intentId),
        )
      } catch (error) {
        throw wrapGeneratedFollowError(error)
      }
    }, { ...options, rotateCommandOnConflict: false })
  }

  async function getFeedPage(
    query: { kind?: 'collection_change' | 'follow_activity'; cursor?: string; limit?: number } = {},
    options?: ReadOptions,
  ): Promise<ProductFeedPage> {
    return withSameRequestRetry(async () => {
      try {
        return await feedClient(options?.signal).feed(query)
      } catch (error) {
        throw wrapGeneratedFollowError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  function followListQuery(cursor: string | undefined, limit: number): { cursor: string } | { limit: number } {
    return cursor ? { cursor } : { limit }
  }

  async function getFollowingPage(
    actorProfileId: string,
    query: { cursor?: string; limit?: number } = {},
    options?: ReadOptions,
  ): Promise<FollowingPage> {
    return withSameRequestRetry(async () => {
      const csrf = await requireCsrf()
      try {
        return await followClient(csrf, options?.signal).following(actorProfileId, query)
      } catch (error) {
        throw wrapGeneratedFollowError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function getFollowersPage(
    profileId: string,
    query: { cursor?: string; limit?: number } = {},
    options?: ReadOptions,
  ): Promise<FollowPage> {
    return withSameRequestRetry(async () => {
      const csrf = await requireCsrf()
      try {
        return await followClient(csrf, options?.signal).followers(profileId, query)
      } catch (error) {
        throw wrapGeneratedFollowError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function isFollowingProfile(
    actorProfileId: string,
    targetProfileId: string,
    options?: ReadOptions,
  ): Promise<boolean> {
    let cursor: string | undefined
    const seen = new Set<string>()
    do {
      const page = await getFollowingPage(actorProfileId, followListQuery(cursor, 100), options)
      if (page.items.some((profile) => profile.profileId === targetProfileId)) return true
      cursor = page.nextCursor ?? undefined
      if (cursor && seen.has(cursor)) {
        throw new ProductApiError({ status: 400, code: 'invalid_cursor', message: 'Follow pagination returned an invalid continuation.' })
      }
      if (cursor) seen.add(cursor)
    } while (cursor)
    return false
  }

  const followMutationOptions = (options: MutationOptions): MutationOptions => ({
    ...options,
    rotateCommandOnConflict: false,
  })

  async function followProfile(targetProfileId: string, options: MutationOptions): Promise<FollowRelation> {
    return mutationCall(async (csrf, intentId) => {
      try {
        return await followClient(csrf, options.signal).follow(targetProfileId, getOrCreateCommandId(intentId))
      } catch (error) {
        throw wrapGeneratedFollowError(error)
      }
    }, followMutationOptions(options))
  }

  async function unfollowProfile(targetProfileId: string, options: MutationOptions): Promise<FollowRelation> {
    return mutationCall(async (csrf, intentId) => {
      try {
        return await followClient(csrf, options.signal).unfollow(targetProfileId, getOrCreateCommandId(intentId))
      } catch (error) {
        throw wrapGeneratedFollowError(error)
      }
    }, followMutationOptions(options))
  }

  function abandonFollowIntent(intentId: string): void { clearCommandId(intentId) }

  const collectionFollowMutationOptions = (options: MutationOptions): MutationOptions => ({
    ...options,
    rotateCommandOnConflict: false,
  })

  async function listFollowedCollections(
    query: { cursor?: string; limit?: number } = {},
    options?: ReadOptions,
  ): Promise<FollowedCollectionPage> {
    return withSameRequestRetry(async () => {
      const csrf = await requireCsrf()
      try {
        return await collectionFollowClient(csrf, options?.signal).list(query)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function getCollectionFollowState(
    collectionId: string,
    options?: ReadOptions,
  ): Promise<CollectionFollowState> {
    return withSameRequestRetry(async () => {
      const csrf = await requireCsrf()
      try {
        return await collectionFollowClient(csrf, options?.signal).state(collectionId)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function followCollection(collectionId: string, options: MutationOptions): Promise<CollectionFollowState> {
    return mutationCall(async (csrf, intentId) => {
      try {
        return await collectionFollowClient(csrf, options.signal).follow(
          collectionId, getOrCreateCommandId(intentId),
        )
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, collectionFollowMutationOptions(options))
  }

  async function unfollowCollection(collectionId: string, options: MutationOptions): Promise<CollectionFollowState> {
    return mutationCall(async (csrf, intentId) => {
      try {
        return await collectionFollowClient(csrf, options.signal).unfollow(
          collectionId, getOrCreateCommandId(intentId),
        )
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, collectionFollowMutationOptions(options))
  }

  function abandonCollectionFollowIntent(intentId: string): void { clearCommandId(intentId) }

  function communityClient(csrfToken: string, signal?: AbortSignal) {
    const configured = getApiBaseUrl()
    const origin = configured || globalThis.location?.origin || 'http://localhost'
    const fetchWithSignal = timedProductFetch(signal)
    return createProductCommunityClient({
      origin,
      csrfToken,
      originHeader: typeof globalThis.location?.origin === 'string'
        ? globalThis.location.origin
        : origin,
      fetch: fetchWithSignal,
    })
  }

  /* R15-29: the vote control and the comment thread on one page resolve
     the same target at mount. Concurrent reads of one target share a
     request; each caller can still abort its own wait. Nothing is cached
     after the request settles, so a post-vote re-read is always fresh. */
  const inflightTargets = new Map<string, Promise<CommunityTargetView>>()

  // Resolve is anonymous-readable: the session cookie rides on
  // credentials:'include' and CSRF is never required for a GET.
  async function resolveCommunityTarget(
    query: CommunityTargetQuery,
    options?: ReadOptions,
  ): Promise<CommunityTargetView> {
    const key = JSON.stringify([query.kind, query.id, query.collectionId ?? null, query.seriesId ?? null])
    let shared = inflightTargets.get(key)
    if (!shared) {
      shared = withSameRequestRetry(async () => {
        try {
          return await communityClient('').resolveTarget(query)
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') throw error
          throw wrapGeneratedFollowError(error)
        }
      }, { maxRetries: options?.maxRetries })
      const settled = shared.finally(() => {
        if (inflightTargets.get(key) === settled) inflightTargets.delete(key)
      })
      inflightTargets.set(key, settled)
      shared = settled
    }
    return abortableWait(shared, options?.signal)
  }

  const communityVoteMutationOptions = (options: MutationOptions): MutationOptions => ({
    ...options,
    // revision_conflict must surface to the control (fresh resolve + user
    // confirmation re-submits under a new intent); exact-request retries keep
    // the allocated command id.
    rotateCommandOnConflict: false,
  })

  async function setCommunityVote(
    target: CommunityTarget,
    value: -1 | 0 | 1,
    options: MutationOptions,
  ): Promise<CommunityVoteState> {
    const body: CommunityVoteRequest = { target, value }
    return mutationCall(async (csrf, intentId) => {
      try {
        return await communityClient(csrf, options.signal).setVote(
          body, getOrCreateCommandId(intentId),
        )
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, communityVoteMutationOptions(options))
  }

  function abandonCommunityVoteIntent(intentId: string): void { clearCommandId(intentId) }

  // CS-02: hot ranking is anonymous-readable; the session cookie rides on
  // credentials:'include' and CSRF is never required for a GET.
  async function getCommunityRanking(
    query: CommunityRankingQueryParams = {},
    options?: ReadOptions,
  ): Promise<CommunityRankingPage> {
    return withSameRequestRetry(async () => {
      try {
        return await communityClient('', options?.signal).listRanking(query)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  // CS-03: comment reads are anonymous-safe; creation is a session +
  // CSRF + Known-Command-Id mutation exactly like setCommunityVote.
  async function getCommunityComments(
    query: CommunityCommentsQueryParams,
    options?: ReadOptions,
  ): Promise<CommunityCommentPage> {
    return withSameRequestRetry(async () => {
      try {
        return await communityClient('', options?.signal).listComments(query)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function getCommunityComment(
    commentId: string,
    options?: ReadOptions,
  ): Promise<CommunityComment> {
    return withSameRequestRetry(async () => {
      try {
        return await communityClient('', options?.signal).getComment(commentId)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  // CS-04: same read as getCommunityComment plus the response ETag, which is
  // the only way a caller can obtain the If-Match an author edit/delete
  // requires (the tag is minted server-side, never derived client-side).
  async function getCommunityCommentWithEtag(
    commentId: string,
    options?: ReadOptions,
  ): Promise<CommunityEntityResult<CommunityComment>> {
    return withSameRequestRetry(async () => {
      try {
        return await communityClient('', options?.signal).getCommentWithEtag(commentId)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function getCommunityCommentReplies(
    commentId: string,
    query: CommunityCommentRepliesQueryParams = {},
    options?: ReadOptions,
  ): Promise<CommunityCommentPage> {
    return withSameRequestRetry(async () => {
      try {
        return await communityClient('', options?.signal).listReplies(commentId, query)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function createCommunityComment(
    body: CommunityCreateComment,
    options: MutationOptions,
  ): Promise<CommunityComment> {
    return mutationCall(async (csrf, intentId) => {
      try {
        return await communityClient(csrf, options.signal).createComment(
          body, getOrCreateCommandId(intentId),
        )
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, communityCommentMutationOptions(options))
  }

  function abandonCommunityCommentIntent(intentId: string): void { clearCommandId(intentId) }

  const communityCommentMutationOptions = (options: MutationOptions): MutationOptions => ({
    ...options,
    // revision_conflict (stale generation) must surface to the comments
    // panel: it re-resolves the target and the next explicit submit is the
    // user's confirmation on the new generation.
    rotateCommandOnConflict: false,
  })

  /* ------------------------------------------------------------ */
  /* CS-04: author edit/delete + curator curation/settings.        */
  /* ------------------------------------------------------------ */

  // Author-only edit; conditional on the comment's own ETag. A 412
  // surfaces so the caller can refresh the comment and retry.
  async function editCommunityComment(
    commentId: string,
    body: CommunityEditComment,
    ifMatch: string,
    options: MutationOptions,
  ): Promise<CommunityEntityResult<CommunityComment>> {
    return mutationCall(async (csrf, intentId) => {
      try {
        return await communityClient(csrf, options.signal).editComment(
          commentId, body, ifMatch, getOrCreateCommandId(intentId),
        )
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, communityCommentMutationOptions(options))
  }

  // Author-only permanent soft delete; conditional on the comment's own ETag.
  async function deleteCommunityComment(
    commentId: string,
    ifMatch: string,
    options: MutationOptions,
  ): Promise<CommunityEntityResult<CommunityComment>> {
    return mutationCall(async (csrf, intentId) => {
      try {
        return await communityClient(csrf, options.signal).deleteComment(
          commentId, ifMatch, getOrCreateCommandId(intentId),
        )
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, communityCommentMutationOptions(options))
  }

  // Curator read of the per-comment curation overlay (independent ETag).
  async function getCommentCuration(
    commentId: string,
    options?: ReadOptions,
  ): Promise<CommunityEntityResult<CommunityCuration>> {
    return withSameRequestRetry(async () => {
      try {
        return await communityClient('', options?.signal).getCuration(commentId)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  // Curator hide/unhide; conditional on the independent curation ETag.
  async function setCommentCuration(
    commentId: string,
    body: CommunityPutCuration,
    ifMatch: string,
    options: MutationOptions,
  ): Promise<CommunityEntityResult<CommunityCuration>> {
    return mutationCall(async (csrf, intentId) => {
      try {
        return await communityClient(csrf, options.signal).setCuration(
          commentId, body, ifMatch, getOrCreateCommandId(intentId),
        )
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, communityCommentMutationOptions(options))
  }

  // Curator read of the per-target comment-area settings (independent ETag).
  async function getCommunityCommentSettings(
    query: CommunityCommentSettingsQueryParams,
    options?: ReadOptions,
  ): Promise<CommunityEntityResult<CommunityCommentSettings>> {
    return withSameRequestRetry(async () => {
      try {
        return await communityClient('', options?.signal).getCommentSettings(query)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  // Curator lock/unlock; conditional on the independent settings ETag.
  async function setCommunityCommentSettings(
    body: CommunityPutCommentSettings,
    ifMatch: string,
    options: MutationOptions,
  ): Promise<CommunityEntityResult<CommunityCommentSettings>> {
    return mutationCall(async (csrf, intentId) => {
      try {
        return await communityClient(csrf, options.signal).setCommentSettings(
          body, ifMatch, getOrCreateCommandId(intentId),
        )
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, communityCommentMutationOptions(options))
  }

  function abandonCommunityCommentManageIntent(intentId: string): void { clearCommandId(intentId) }

  /* ------------------------------------------------------------ */
  /* CS-05: the private reply-notification inbox + community       */
  /* channel preference — session reads, receipt mutations.        */
  /* ------------------------------------------------------------ */

  // Session-scoped inbox page; unreadCount counts only still-servable
  // rows, so it can shrink without a write (deleted/hidden replies keep
  // position with a null preview; unresolved targets drop out).
  async function getCommunityNotificationsPage(
    query: CommunityNotificationsQueryParams = {},
    options?: ReadOptions,
  ): Promise<CommunityNotificationInbox> {
    return withSameRequestRetry(async () => {
      try {
        return await communityClient('', options?.signal).listNotifications(query)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  // Durable bulk read; changedIds echoes only the rows this write
  // transitioned — an exact retry replays the saved outcome.
  async function markCommunityNotificationsRead(
    body: CommunityReadNotifications,
    options: MutationOptions,
  ): Promise<CommunityReadNotificationsResult> {
    return mutationCall(async (csrf, intentId) => {
      try {
        return await communityClient(csrf, options.signal).markNotificationsRead(
          body, getOrCreateCommandId(intentId),
        )
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, communityCommentMutationOptions(options))
  }

  // Community-channel preference read; the response ETag is the If-Match
  // the PUT requires (minted server-side, the virtual tag before any write).
  async function getCommunityNotificationPreference(
    options?: ReadOptions,
  ): Promise<CommunityEntityResult<CommunityNotificationPreference>> {
    return withSameRequestRetry(async () => {
      try {
        return await communityClient('', options?.signal).getNotificationPreference()
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  // Preference CAS; conditional on the opaque preference ETag.
  async function updateCommunityNotificationPreference(
    body: CommunityPutNotificationPreference,
    ifMatch: string,
    options: MutationOptions,
  ): Promise<CommunityEntityResult<CommunityNotificationPreference>> {
    return mutationCall(async (csrf, intentId) => {
      try {
        return await communityClient(csrf, options.signal).putNotificationPreference(
          body, ifMatch, getOrCreateCommandId(intentId),
        )
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, communityCommentMutationOptions(options))
  }

  function abandonCommunityNotificationIntent(intentId: string): void { clearCommandId(intentId) }

  const libraryOrderMutationOptions = (options: MutationOptions): MutationOptions => ({
    ...options,
    rotateCommandOnConflict: false,
  })

  async function getMyLibraryOrder(options?: ReadOptions): Promise<LibraryOrderView> {
    return withSameRequestRetry(async () => {
      const csrf = await requireCsrf()
      try {
        return await libraryOrderClient(csrf, options?.signal).get()
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function updateMyLibraryOrder(
    section: LibraryOrderSectionName,
    body: LibraryOrderUpdateRequest,
    options: MutationOptions,
  ): Promise<LibraryOrderSectionView> {
    return mutationCall(async (csrf, intentId) => {
      try {
        return await libraryOrderClient(csrf, options.signal).update(
          section, body, getOrCreateCommandId(intentId),
        )
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, libraryOrderMutationOptions(options))
  }

  function abandonLibraryOrderIntent(intentId: string): void { clearCommandId(intentId) }

  function insightEventBody(input: RecordPublicCollectionInsightEventInput): RecordInsightEventRequest {
    if (input.eventType === 'resource_open') {
      return { eventType: 'resource_open', nodeId: input.nodeId }
    }
    return { eventType: input.eventType }
  }

  function publishingInsightsClient(options?: RecordPublicCollectionInsightEventOptions) {
    const configured = getApiBaseUrl()
    const origin = configured || globalThis.location?.origin || 'http://localhost'
    const csrf = getCsrfToken()
    const transport: typeof globalThis.fetch = (input, init) =>
      globalThis.fetch(input, {
        ...init,
        credentials: 'include',
        ...(options?.signal ? { signal: options.signal } : {}),
        ...(options?.keepalive === true ? { keepalive: true } : {}),
      })
    return createProductPublishingInsightsClient({
      origin,
      ...(csrf ? { csrfToken: csrf } : {}),
      originHeader: typeof globalThis.location?.origin === 'string'
        ? globalThis.location.origin
        : origin,
      fetch: transport,
    })
  }

  async function recordPublicCollectionInsightEvent(
    input: RecordPublicCollectionInsightEventInput,
    options: RecordPublicCollectionInsightEventOptions = {},
  ): Promise<void> {
    try {
      await publishingInsightsClient(options).recordPublicCollectionInsightEvent(
        input.slug,
        insightEventBody(input),
      )
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      throw wrapGeneratedFollowError(error)
    }
  }

  async function getMyPublishingInsights(options?: ReadOptions): Promise<PublishingInsights> {
    return withSameRequestRetry(async () => {
      try {
        return await publishingInsightsClient({ signal: options?.signal }).getMyPublishingInsights()
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  function collaborationClient(csrfToken: string, signal?: AbortSignal) {
    const configured = getApiBaseUrl()
    const origin = configured || globalThis.location?.origin || 'http://localhost'
    const fetchWithSignal = timedProductFetch(signal)
    return createProductCollaborationClient({
      origin,
      csrfToken,
      ...(typeof globalThis.location?.origin === 'string'
        ? { originHeader: globalThis.location.origin }
        : {}),
      fetch: fetchWithSignal,
    })
  }

  function collaborationMutationOptions(options: MutationOptions): MutationOptions {
    return { ...options, rotateCommandOnConflict: false }
  }

  async function listCollectionMembers(
    collectionId: string,
    options?: ReadOptions,
  ): Promise<CollectionMembersPage> {
    return withSameRequestRetry(async () => {
      try {
        return await collaborationClient(getCsrfToken() ?? '', options?.signal).listCollectionMembers(collectionId)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function listSharedCollections(
    query: OwnedCollectionQuery & { cursor?: string } = {},
    options?: ReadOptions,
  ): Promise<SharedCollectionPage> {
    return withSameRequestRetry(async () => {
      try {
        return await collaborationClient(getCsrfToken() ?? '', options?.signal).listSharedCollections(query)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function listMyCollaborationInvites(
    options?: ReadOptions,
  ): Promise<MyCollaborationInvitesPage> {
    return withSameRequestRetry(async () => {
      try {
        return await collaborationClient(getCsrfToken() ?? '', options?.signal).listMyCollaborationInvites()
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function acceptCollaborationInvite(
    inviteId: string,
    options: MutationOptions,
  ): Promise<CollaborationMembershipResult> {
    return mutationCall(async (csrf, intentId) => {
      try {
        return await collaborationClient(csrf, options.signal).acceptCollaborationInvite(
          inviteId,
          getOrCreateCommandId(intentId),
        )
      } catch (error) {
        throw wrapGeneratedFollowError(error)
      }
    }, collaborationMutationOptions(options))
  }

  async function declineCollaborationInvite(
    inviteId: string,
    options: MutationOptions,
  ): Promise<void> {
    return mutationCall(async (csrf, intentId) => {
      try {
        return await collaborationClient(csrf, options.signal).declineCollaborationInvite(
          inviteId,
          getOrCreateCommandId(intentId),
        )
      } catch (error) {
        throw wrapGeneratedFollowError(error)
      }
    }, collaborationMutationOptions(options))
  }

  async function inviteCollectionMember(
    collectionId: string,
    body: InviteCollectionMemberRequest,
    ifMatch: string,
    options: MutationOptions,
  ): Promise<CollectionInviteCreated> {
    return mutationCall(async (csrf, intentId) => {
      try {
        return await collaborationClient(csrf, options.signal).inviteCollectionMember(
          collectionId,
          body,
          getOrCreateCommandId(intentId),
          ifMatch,
        )
      } catch (error) {
        throw wrapGeneratedFollowError(error)
      }
    }, collaborationMutationOptions(options))
  }

  async function revokeCollectionInvite(
    collectionId: string,
    inviteId: string,
    ifMatch: string,
    options: MutationOptions,
  ): Promise<void> {
    return mutationCall(async (csrf, intentId) => {
      try {
        return await collaborationClient(csrf, options.signal).revokeCollectionInvite(
          collectionId,
          inviteId,
          getOrCreateCommandId(intentId),
          ifMatch,
        )
      } catch (error) {
        throw wrapGeneratedFollowError(error)
      }
    }, collaborationMutationOptions(options))
  }

  async function updateCollectionMemberRole(
    collectionId: string,
    subjectId: string,
    body: CollectionMemberRoleMergePatch,
    ifMatch: string,
    options: MutationOptions,
  ): Promise<CollaborationMembershipResult> {
    return mutationCall(async (csrf, intentId) => {
      try {
        return await collaborationClient(csrf, options.signal).updateCollectionMemberRole(
          collectionId,
          subjectId,
          body,
          getOrCreateCommandId(intentId),
          ifMatch,
        )
      } catch (error) {
        throw wrapGeneratedFollowError(error)
      }
    }, collaborationMutationOptions(options))
  }

  async function removeCollectionMember(
    collectionId: string,
    subjectId: string,
    ifMatch: string,
    options: MutationOptions,
  ): Promise<void> {
    return mutationCall(async (csrf, intentId) => {
      try {
        return await collaborationClient(csrf, options.signal).removeCollectionMember(
          collectionId,
          subjectId,
          getOrCreateCommandId(intentId),
          ifMatch,
        )
      } catch (error) {
        throw wrapGeneratedFollowError(error)
      }
    }, collaborationMutationOptions(options))
  }

  function reportsClient(csrfToken: string, signal?: AbortSignal) {
    const configured = getApiBaseUrl()
    const origin = configured || globalThis.location?.origin || 'http://localhost'
    const fetchWithSignal = timedProductFetch(signal)
    return createProductReportsClient({
      origin,
      csrfToken,
      fetch: fetchWithSignal,
    })
  }

  function governanceClient(csrfToken: string, signal?: AbortSignal) {
    const configured = getApiBaseUrl()
    const origin = configured || globalThis.location?.origin || 'http://localhost'
    const fetchWithSignal = timedProductFetch(signal)
    return createProductGovernanceClient({
      origin,
      csrfToken,
      ...(typeof globalThis.location?.origin === 'string'
        ? { originHeader: globalThis.location.origin }
        : {}),
      fetch: fetchWithSignal,
    })
  }

  async function getPublicReportsPage(
    query: { cursor?: string; limit?: number; language?: string } = {},
    options?: ReadOptions,
  ): Promise<PublicReportPage> {
    return withSameRequestRetry(async () => {
      try {
        return await reportsClient('', options?.signal).publicDirectory(query)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function getPublicReportSeries(
    slug: string,
    options?: ReadOptions,
  ): Promise<PublicReportSeries> {
    return withSameRequestRetry(async () => {
      try {
        return await reportsClient('', options?.signal).publicSeries(slug)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function getPublicReportIssuesPage(
    slug: string,
    query: { cursor?: string; limit?: number } = {},
    options?: ReadOptions,
  ): Promise<PublicReportIssuePage> {
    return withSameRequestRetry(async () => {
      try {
        return await reportsClient('', options?.signal).publicIssues(slug, query)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function getPublicReportIssue(
    slug: string,
    editionId: string,
    options?: ReadOptions,
  ): Promise<PublicReportIssue> {
    return withSameRequestRetry(async () => {
      try {
        return await reportsClient('', options?.signal).publicIssue(slug, editionId)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function listFollowedReports(
    query: { cursor?: string; limit?: number } = {},
    options?: ReadOptions,
  ): Promise<ReportSeriesPage> {
    return withSameRequestRetry(async () => {
      const csrf = await requireCsrf()
      try {
        return await reportsClient(csrf, options?.signal).followed(query)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function getFollowedReportIssuesPage(
    query: { cursor?: string; limit?: number } = {},
    options?: ReadOptions,
  ): Promise<ReportIssueTimelinePage> {
    return withSameRequestRetry(async () => {
      const csrf = await requireCsrf()
      try {
        return await reportsClient(csrf, options?.signal).timeline(query)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function getReportFollowState(
    reportId: string,
    options?: ReadOptions,
  ): Promise<ReportFollowState> {
    return withSameRequestRetry(async () => {
      const csrf = await requireCsrf()
      try {
        return await reportsClient(csrf, options?.signal).followState(reportId)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  const reportFollowMutationOptions = (options: MutationOptions): MutationOptions => ({
    ...options,
    rotateCommandOnConflict: false,
  })

  async function followReport(reportId: string, options: MutationOptions): Promise<ReportFollowState> {
    return mutationCall(async (csrf, intentId) => {
      try {
        return await reportsClient(csrf, options.signal).follow(
          reportId, getOrCreateCommandId(intentId),
        )
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, reportFollowMutationOptions(options))
  }

  async function unfollowReport(reportId: string, options: MutationOptions): Promise<ReportFollowState> {
    return mutationCall(async (csrf, intentId) => {
      try {
        return await reportsClient(csrf, options.signal).unfollow(
          reportId, getOrCreateCommandId(intentId),
        )
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, reportFollowMutationOptions(options))
  }

  function abandonReportFollowIntent(intentId: string): void { clearCommandId(intentId) }

  /* ——— Curator management (R10-05/36): the private /api/v1/reports surface.
     Reads mirror the followed-reports wrappers (session CSRF, same-request
     retry); mutations carry the intent's command id and the caller's
     If-Match revision — series/edition resourceRevision, members
     policyRevision, schedule optional. rotateCommandOnConflict stays off so
     a 412 surfaces to the manage hook instead of silently replaying. ——— */

  async function listMyReports(
    query: { cursor?: string; limit?: number } = {},
    options?: ReadOptions,
  ): Promise<ReportSeriesPage> {
    return withSameRequestRetry(async () => {
      const csrf = await requireCsrf()
      try {
        return await reportsClient(csrf, options?.signal).mine(query)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function getReport(reportId: string, options?: ReadOptions): Promise<ReportSeries> {
    return withSameRequestRetry(async () => {
      const csrf = await requireCsrf()
      try {
        return await reportsClient(csrf, options?.signal).get(reportId)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function listReportIssues(
    reportId: string,
    query: { cursor?: string; limit?: number } = {},
    options?: ReadOptions,
  ): Promise<ReportEditionPage> {
    return withSameRequestRetry(async () => {
      const csrf = await requireCsrf()
      try {
        return await reportsClient(csrf, options?.signal).issues(reportId, query)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function listReportMembers(reportId: string, options?: ReadOptions): Promise<ReportMemberPage> {
    return withSameRequestRetry(async () => {
      const csrf = await requireCsrf()
      try {
        return await reportsClient(csrf, options?.signal).members(reportId)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function getReportSchedule(reportId: string, options?: ReadOptions): Promise<ReportScheduleEnvelope> {
    return withSameRequestRetry(async () => {
      const csrf = await requireCsrf()
      try {
        return await reportsClient(csrf, options?.signal).schedule(reportId)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  const reportManageMutationOptions = (options: MutationOptions): MutationOptions => ({
    ...options,
    rotateCommandOnConflict: false,
  })

  async function createReport(body: ReportSeriesCreate, options: MutationOptions): Promise<ReportSeries> {
    return mutationCall(async (csrf, intentId) => {
      try {
        return await reportsClient(csrf, options.signal).create(body, getOrCreateCommandId(intentId))
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, reportManageMutationOptions(options))
  }

  async function patchReport(reportId: string, body: ReportSeriesPatch, ifMatch: string, options: MutationOptions): Promise<ReportSeries> {
    return mutationCall(async (csrf, intentId) => {
      try {
        return await reportsClient(csrf, options.signal).update(reportId, body, getOrCreateCommandId(intentId), ifMatch)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, reportManageMutationOptions(options))
  }

  async function deleteReport(reportId: string, ifMatch: string, options: MutationOptions): Promise<void> {
    return mutationCall(async (csrf, intentId) => {
      try {
        return await reportsClient(csrf, options.signal).archive(reportId, getOrCreateCommandId(intentId), ifMatch)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, reportManageMutationOptions(options))
  }

  async function createReportIssue(reportId: string, body: ReportEditionAttach, options: MutationOptions): Promise<ReportEdition> {
    return mutationCall(async (csrf, intentId) => {
      try {
        return await reportsClient(csrf, options.signal).attach(reportId, body, getOrCreateCommandId(intentId))
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, reportManageMutationOptions(options))
  }

  async function patchReportIssue(reportId: string, editionId: string, body: ReportEditionPatch, ifMatch: string, options: MutationOptions): Promise<ReportEdition> {
    return mutationCall(async (csrf, intentId) => {
      try {
        return await reportsClient(csrf, options.signal).updateIssue(reportId, editionId, body, getOrCreateCommandId(intentId), ifMatch)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, reportManageMutationOptions(options))
  }

  async function deleteReportIssue(reportId: string, editionId: string, ifMatch: string, options: MutationOptions): Promise<void> {
    return mutationCall(async (csrf, intentId) => {
      try {
        return await reportsClient(csrf, options.signal).detach(reportId, editionId, getOrCreateCommandId(intentId), ifMatch)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, reportManageMutationOptions(options))
  }

  async function publishReportIssue(reportId: string, editionId: string, ifMatch: string, options: MutationOptions): Promise<ReportEdition> {
    return mutationCall(async (csrf, intentId) => {
      try {
        return await reportsClient(csrf, options.signal).publish(reportId, editionId, getOrCreateCommandId(intentId), ifMatch)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, reportManageMutationOptions(options))
  }

  async function withdrawReportIssue(reportId: string, editionId: string, ifMatch: string, options: MutationOptions): Promise<ReportEdition> {
    return mutationCall(async (csrf, intentId) => {
      try {
        return await reportsClient(csrf, options.signal).withdraw(reportId, editionId, getOrCreateCommandId(intentId), ifMatch)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, reportManageMutationOptions(options))
  }

  async function putReportSchedule(reportId: string, body: ReportScheduleInput, ifMatch: string | undefined, options: MutationOptions): Promise<ReportSchedule> {
    return mutationCall(async (csrf, intentId) => {
      try {
        /* The generated signature requires a string, but writeHeaders omits
           If-Match on undefined — the backend treats it as optional, so an
           absent revision must stay undefined, never an empty header. */
        return await reportsClient(csrf, options.signal).putSchedule(reportId, body, getOrCreateCommandId(intentId), ifMatch as string)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, reportManageMutationOptions(options))
  }

  async function deleteReportSchedule(reportId: string, ifMatch: string | undefined, options: MutationOptions): Promise<void> {
    return mutationCall(async (csrf, intentId) => {
      try {
        return await reportsClient(csrf, options.signal).deleteSchedule(reportId, getOrCreateCommandId(intentId), ifMatch as string)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, reportManageMutationOptions(options))
  }

  async function putReportMember(reportId: string, subjectId: string, body: ReportMemberMutation, ifMatch: string, options: MutationOptions): Promise<ReportMember> {
    return mutationCall(async (csrf, intentId) => {
      try {
        return await reportsClient(csrf, options.signal).updateMember(reportId, subjectId, body, getOrCreateCommandId(intentId), ifMatch)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, reportManageMutationOptions(options))
  }

  async function deleteReportMember(reportId: string, subjectId: string, ifMatch: string, options: MutationOptions): Promise<void> {
    return mutationCall(async (csrf, intentId) => {
      try {
        return await reportsClient(csrf, options.signal).removeMember(reportId, subjectId, getOrCreateCommandId(intentId), ifMatch)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, reportManageMutationOptions(options))
  }

  function abandonReportManageIntent(intentId: string): void { clearCommandId(intentId) }

  async function getCollectionCatalog(collectionId: string, options?: ReadOptions): Promise<GovernanceCatalog> {
    return withSameRequestRetry(async () => {
      try {
        return await governanceClient('', options?.signal).getCollectionCatalog(collectionId)
      } catch (error) {
        throw wrapGeneratedFollowError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function updateCollectionCatalog(
    collectionId: string, body: GovernanceCatalogPatch, ifMatch: string, options: MutationOptions,
  ): Promise<GovernanceCatalog> {
    return mutationCall(async (csrf, intentId) => {
      try {
        return await governanceClient(csrf, options.signal).updateCollectionCatalog(
          collectionId, body, getOrCreateCommandId(intentId), ifMatch,
        )
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, options)
  }

  async function getReportCatalog(reportId: string, options?: ReadOptions): Promise<GovernanceCatalog> {
    return withSameRequestRetry(async () => {
      try {
        return await governanceClient('', options?.signal).getReportCatalog(reportId)
      } catch (error) {
        throw wrapGeneratedFollowError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function updateReportCatalog(
    reportId: string, body: GovernanceCatalogPatch, ifMatch: string, options: MutationOptions,
  ): Promise<GovernanceCatalog> {
    return mutationCall(async (csrf, intentId) => {
      try {
        return await governanceClient(csrf, options.signal).updateReportCatalog(
          reportId, body, getOrCreateCommandId(intentId), ifMatch,
        )
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, options)
  }

  async function getMyCatalogPreferences(options?: ReadOptions): Promise<GovernanceCatalogPreferences> {
    return withSameRequestRetry(async () => {
      try {
        return await governanceClient('', options?.signal).getMyCatalogPreferences()
      } catch (error) {
        throw wrapGeneratedFollowError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function submitModerationReport(
    body: GovernanceReportInput, options: MutationOptions,
  ): Promise<GovernanceMyCase> {
    return mutationCall(async (csrf, intentId) => {
      try {
        return await governanceClient(csrf, options.signal).submitModerationReport(
          body, getOrCreateCommandId(intentId),
        )
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, options)
  }

  async function listMyModerationReports(
    query: { status?: string; limit?: number; cursor?: string } = {},
    options?: ReadOptions,
  ): Promise<GovernanceMyCasePage> {
    return withSameRequestRetry(async () => {
      try {
        return await governanceClient('', options?.signal).listMyModerationReports(query)
      } catch (error) {
        throw wrapGeneratedFollowError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function getMyModerationReport(
    caseId: string, options?: ReadOptions,
  ): Promise<GovernanceMyCase> {
    return withSameRequestRetry(async () => {
      try {
        return await governanceClient('', options?.signal).getMyModerationReport(caseId)
      } catch (error) {
        throw wrapGeneratedFollowError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function listModerationCases(
    query: { status?: string; assignee?: string; limit?: number; cursor?: string } = {},
    options?: ReadOptions,
  ): Promise<GovernanceOfficialCasePage> {
    return withSameRequestRetry(async () => {
      try {
        return await governanceClient('', options?.signal).listModerationCases(query)
      } catch (error) {
        throw wrapGeneratedFollowError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function getModerationCase(
    caseId: string, options?: ReadOptions,
  ): Promise<GovernanceOfficialCase> {
    return withSameRequestRetry(async () => {
      try {
        return await governanceClient('', options?.signal).getModerationCase(caseId)
      } catch (error) {
        throw wrapGeneratedFollowError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function getModerationEvidence(
    caseId: string, evidenceId: string, options?: ReadOptions,
  ): Promise<GovernanceEvidence> {
    return withSameRequestRetry(async () => {
      try {
        return await governanceClient('', options?.signal).getModerationEvidence(caseId, evidenceId)
      } catch (error) {
        throw wrapGeneratedFollowError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function updateModerationCase(
    caseId: string, body: GovernanceCasePatch, ifMatch: string, options: MutationOptions,
  ): Promise<GovernanceOfficialCase> {
    return mutationCall(async (csrf, intentId) => {
      try {
        return await governanceClient(csrf, options.signal).updateModerationCase(
          caseId, body, getOrCreateCommandId(intentId), ifMatch,
        )
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, options)
  }

  async function createModerationAction(
    body: GovernanceActionInput, options: MutationOptions,
  ): Promise<GovernanceAction> {
    return mutationCall(async (csrf, intentId) => {
      try {
        return await governanceClient(csrf, options.signal).createModerationAction(
          body, getOrCreateCommandId(intentId),
        )
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, options)
  }

  async function getModerationAction(
    actionId: string, options?: ReadOptions,
  ): Promise<GovernanceAction> {
    return withSameRequestRetry(async () => {
      try {
        return await governanceClient('', options?.signal).getModerationAction(actionId)
      } catch (error) {
        throw wrapGeneratedFollowError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function revokeModerationAction(
    actionId: string, body: { reason: string }, ifMatch: string, options: MutationOptions,
  ): Promise<GovernanceAction> {
    return mutationCall(async (csrf, intentId) => {
      try {
        return await governanceClient(csrf, options.signal).revokeModerationAction(
          actionId, body, getOrCreateCommandId(intentId), ifMatch,
        )
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, options)
  }

  async function listActionsAffectingMe(
    query: { limit?: number; cursor?: string } = {},
    options?: ReadOptions,
  ): Promise<GovernanceMyActionPage> {
    return withSameRequestRetry(async () => {
      try {
        return await governanceClient('', options?.signal).listActionsAffectingMe(query)
      } catch (error) {
        throw wrapGeneratedFollowError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function createModerationAppeal(
    body: GovernanceAppealInput, options: MutationOptions,
  ): Promise<GovernanceAppeal> {
    return mutationCall(async (csrf, intentId) => {
      try {
        return await governanceClient(csrf, options.signal).createModerationAppeal(
          body, getOrCreateCommandId(intentId),
        )
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, options)
  }

  async function listModerationAppeals(
    query: { status?: string; limit?: number; cursor?: string } = {},
    options?: ReadOptions,
  ): Promise<GovernanceAppealPage> {
    return withSameRequestRetry(async () => {
      try {
        return await governanceClient('', options?.signal).listModerationAppeals(query)
      } catch (error) {
        throw wrapGeneratedFollowError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function listMyModerationAppeals(
    query: { limit?: number; cursor?: string } = {},
    options?: ReadOptions,
  ): Promise<GovernanceAppealPage> {
    return withSameRequestRetry(async () => {
      try {
        return await governanceClient('', options?.signal).listMyModerationAppeals(query)
      } catch (error) {
        throw wrapGeneratedFollowError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function getModerationAppeal(
    appealId: string, options?: ReadOptions,
  ): Promise<GovernanceAppeal> {
    return withSameRequestRetry(async () => {
      try {
        return await governanceClient('', options?.signal).getModerationAppeal(appealId)
      } catch (error) {
        throw wrapGeneratedFollowError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function decideModerationAppeal(
    appealId: string, body: GovernanceAppealDecision, ifMatch: string, options: MutationOptions,
  ): Promise<GovernanceAppeal> {
    return mutationCall(async (csrf, intentId) => {
      try {
        return await governanceClient(csrf, options.signal).decideModerationAppeal(
          appealId, body, getOrCreateCommandId(intentId), ifMatch,
        )
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, options)
  }

  async function updateMyCatalogPreferences(
    body: GovernanceCatalogPreferencesPatch, ifMatch: string, options: MutationOptions,
  ): Promise<GovernanceCatalogPreferences> {
    return mutationCall(async (csrf, intentId) => {
      try {
        return await governanceClient(csrf, options.signal).updateMyCatalogPreferences(
          body, getOrCreateCommandId(intentId), ifMatch,
        )
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, options)
  }

  return {
    getFollowingPage,
    getFollowersPage,
    isFollowingProfile,
    followProfile,
    unfollowProfile,
    abandonFollowIntent,
    getCollectionFollowState,
    listFollowedCollections,
    followCollection,
    unfollowCollection,
    abandonCollectionFollowIntent,
    resolveCommunityTarget,
    setCommunityVote,
    abandonCommunityVoteIntent,
    getCommunityRanking,
    getCommunityComments,
    getCommunityComment,
    getCommunityCommentWithEtag,
    getCommunityCommentReplies,
    createCommunityComment,
    abandonCommunityCommentIntent,
    editCommunityComment,
    deleteCommunityComment,
    getCommentCuration,
    setCommentCuration,
    getCommunityCommentSettings,
    setCommunityCommentSettings,
    abandonCommunityCommentManageIntent,
    getCommunityNotificationsPage,
    markCommunityNotificationsRead,
    getCommunityNotificationPreference,
    updateCommunityNotificationPreference,
    abandonCommunityNotificationIntent,
    getMyLibraryOrder,
    updateMyLibraryOrder,
    abandonLibraryOrderIntent,
    recordPublicCollectionInsightEvent,
    getMyPublishingInsights,
    listCollectionMembers,
    listSharedCollections,
    listMyCollaborationInvites,
    acceptCollaborationInvite,
    declineCollaborationInvite,
    inviteCollectionMember,
    revokeCollectionInvite,
    updateCollectionMemberRole,
    removeCollectionMember,
    getFeedPage,
    getNotificationPage,
    markNotificationRead,
    markNotificationsRead,
    getNotificationPreference,
    updateNotificationPreference,
    getPublicReportsPage,
    getPublicReportSeries,
    getPublicReportIssuesPage,
    getPublicReportIssue,
    listFollowedReports,
    getFollowedReportIssuesPage,
    getReportFollowState,
    followReport,
    unfollowReport,
    abandonReportFollowIntent,
    listMyReports,
    getCollectionCatalog,
    updateCollectionCatalog,
    getReportCatalog,
    updateReportCatalog,
    getMyCatalogPreferences,
    updateMyCatalogPreferences,
    submitModerationReport,
    listMyModerationReports,
    getMyModerationReport,
    listModerationCases,
    getModerationCase,
    getModerationEvidence,
    updateModerationCase,
    createModerationAction,
    getModerationAction,
    revokeModerationAction,
    listActionsAffectingMe,
    createModerationAppeal,
    listModerationAppeals,
    listMyModerationAppeals,
    getModerationAppeal,
    decideModerationAppeal,
    getReport,
    listReportIssues,
    listReportMembers,
    getReportSchedule,
    createReport,
    patchReport,
    deleteReport,
    createReportIssue,
    patchReportIssue,
    deleteReportIssue,
    publishReportIssue,
    withdrawReportIssue,
    putReportSchedule,
    deleteReportSchedule,
    putReportMember,
    deleteReportMember,
    abandonReportManageIntent,
  }
}
