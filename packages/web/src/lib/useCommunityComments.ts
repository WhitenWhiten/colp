/* CS-03 community comments workflow shared by the four target pages
   (collection, bookmark, digest series, digest edition). The hook first
   resolves the live target — its generation pins every comment list query
   and every create — then pages root comments createdAt DESC via the
   opaque cursor. Replies are loaded lazily per root (flattened depth 1-2,
   createdAt ASC). A successful create inserts the returned Comment into
   the local projection: roots prepend, replies append and bump the root's
   replyCount; no server list is ever re-ordered client-side. revision_
   conflict on create re-resolves the target so the next explicit submit is
   the user's confirmation on the new generation.

   CS-04 adds author edit/delete and curator hide/unhide + area lock.
   Every CS-04 write is conditional on its OWN ETag authority: author
   mutations send the comment's tag (obtained from a fresh read, the tag is
   minted server-side and never derivable client-side), curation sends the
   independent curation tag, and the area lock sends the independent
   settings tag. A 412 abandons the intent, refreshes the affected
   projection, and asks the user to review-and-retry — the same receipt
   discipline as every other Product mutation. */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  isProductApiError,
  productClient,
  type CommunityComment,
  type CommunityTargetQuery,
  type CommunityTargetView,
} from '../api'

export const COMMUNITY_COMMENTS_PAGE_SIZE = 20

export type CommunityCommentsStatus = 'loading' | 'ready' | 'error' | 'unavailable'

export interface CommunityRepliesState {
  readonly items: readonly CommunityComment[]
  readonly nextCursor: string | null
  readonly loading: boolean
  readonly loadingMore: boolean
  readonly error: string | null
  readonly expanded: boolean
  /** True once a server page of the thread has been received. Locally
     inserted replies must not count: they only reflect what the user
     posted, so expanding must still fetch the authoritative thread. */
  readonly loaded: boolean
}

/** CS-04 comment-area settings as held client-side: the wire settings plus
   the response ETag that conditions the next lock/unlock write. */
export interface CommunityCommentAreaSettings {
  readonly locked: boolean
  readonly reason: string | null
  readonly etag: string | null
}

export interface CommunityCommentsBoard {
  readonly status: CommunityCommentsStatus
  /** Resolved target view (target incl. generation, canComment, canCurateComments). */
  readonly view: CommunityTargetView | null
  readonly roots: readonly CommunityComment[]
  readonly nextCursor: string | null
  readonly loadingMore: boolean
  readonly error: string | null
  /** A create is in flight; the composer stays disabled. */
  readonly pending: boolean
  /** A CS-04 management write is in flight; its controls stay disabled. */
  readonly managePending: boolean
  /** Latest user-facing status/error line from the last operation. */
  readonly message: string | null
  readonly outcome: string | null
  readonly replies: ReadonlyMap<string, CommunityRepliesState>
  /** CS-04: comment-area settings for curators; null for non-curators. */
  readonly settings: CommunityCommentAreaSettings | null
  /**
   * CS-04: non-concealment failure of the curator settings read (5xx,
   * transport, rate-limit). The settings copy stays null — the write path
   * re-fetches the ETag — but the failure is reported to the curator
   * instead of silently hiding the management surface.
   */
  readonly settingsError: string | null
  reload(): void
  loadMore(): void
  toggleReplies(rootId: string): void
  loadMoreReplies(rootId: string): void
  create(body: string, replyToId: string | null): Promise<CommunityComment | null>
  /** Author edit; returns the updated comment or null on failure/abort. */
  edit(comment: CommunityComment, body: string): Promise<CommunityComment | null>
  /** Author permanent soft delete; returns the tombstone or null. */
  remove(comment: CommunityComment): Promise<CommunityComment | null>
  /** Curator hide/unhide; returns true when the write landed. */
  curate(comment: CommunityComment, hidden: boolean, reason: string): Promise<boolean>
  /** Curator comment-area lock/unlock; returns true when the write landed. */
  setAreaLocked(locked: boolean, reason: string): Promise<boolean>
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function isUnexposedCommunity(error: unknown): boolean {
  return isProductApiError(error)
    && (error.status === 404 || error.code === 'resource_not_found')
}

function isRevisionConflict(error: unknown): boolean {
  return isProductApiError(error) && error.code === 'revision_conflict'
}

function isPreconditionFailed(error: unknown): boolean {
  return isProductApiError(error) && error.code === 'precondition_failed'
}

function queryKey(query: CommunityTargetQuery): string {
  return `${query.kind}:${query.id}:${query.collectionId ?? ''}:${query.seriesId ?? ''}`
}

const EMPTY_REPLIES: CommunityRepliesState = {
  items: [], nextCursor: null, loading: false, loadingMore: false,
  error: null, expanded: false, loaded: false,
}

export function useCommunityComments(input: {
  /** Target selector; null keeps the hook idle (page not ready / no target). */
  query: CommunityTargetQuery | null
  /** Exposure gate: feature flag + page readiness. */
  enabled: boolean
}): CommunityCommentsBoard {
  const { query, enabled } = input
  const [status, setStatus] = useState<CommunityCommentsStatus>('loading')
  const [view, setView] = useState<CommunityTargetView | null>(null)
  const [roots, setRoots] = useState<readonly CommunityComment[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [managePending, setManagePending] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  /* The same line split by channel: `message` feeds the aria-live region,
     `outcome` the visible status line. Write results set both; the load
     announcement and hard errors stay on their own surfaces. */
  const [outcome, setOutcome] = useState<string | null>(null)
  const [settings, setSettings] = useState<CommunityCommentAreaSettings | null>(null)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [replies, setReplies] = useState<ReadonlyMap<string, CommunityRepliesState>>(new Map())
  const operation = useRef(0)
  const intent = useRef<string | null>(null)
  /* The authority read is replaced by the next authority read (reload, retry,
     post-conflict refresh), so it gets its own slot; the target-scoped follow-up
     reads (a cursor page, one root's replies) can overlap each other and are
     tracked as a set. The mount/scope effect aborts both on unmount or target
     change — an abandoned read must not paint into the new target's board. */
  const authorityController = useRef<AbortController | null>(null)
  const scopeControllers = useRef(new Set<AbortController>())

  const patchReplies = useCallback((rootId: string, patch: Partial<CommunityRepliesState>) => {
    setReplies((previous) => {
      const next = new Map(previous)
      next.set(rootId, { ...(next.get(rootId) ?? EMPTY_REPLIES), ...patch })
      return next
    })
  }, [])

  const loadRoots = useCallback(async (
    resolvedView: CommunityTargetView,
    cursor: string | null,
    signal: AbortSignal,
  ) => {
    const target = resolvedView.target
    /* The caller owns cancellation: this list read keeps its default retry
       budget and only adds the signal. */
    const page = await productClient.getCommunityComments({
      kind: target.kind,
      id: target.id,
      ...(target.collectionId !== null ? { collectionId: target.collectionId } : {}),
      ...(target.seriesId !== null ? { seriesId: target.seriesId } : {}),
      generation: target.generation,
      limit: COMMUNITY_COMMENTS_PAGE_SIZE,
      ...(cursor !== null ? { cursor } : {}),
    }, { signal })
    return page
  }, [])

  /* CS-04: comment-area settings are a curator-only read — non-curators
     get no copy of the settings surface at all (uniform concealment of the
     management surface). A concealed read (404/not-found/forbidden) simply
     leaves the settings null, but a real read failure (5xx, transport,
     rate-limit) is REPORTED to the curator: the settings copy stays absent
     and the write path re-fetches the ETag, yet the management surface
     never silently pretends everything is fine. */
  const loadSettings = useCallback(async (
    resolvedView: CommunityTargetView,
    signal: AbortSignal,
  ): Promise<{ value: CommunityCommentAreaSettings | null; error: string | null }> => {
    if (resolvedView.canCurateComments !== true) return { value: null, error: null }
    const target = resolvedView.target
    try {
      const result = await productClient.getCommunityCommentSettings({
        kind: target.kind,
        id: target.id,
        ...(target.collectionId !== null ? { collectionId: target.collectionId } : {}),
        ...(target.seriesId !== null ? { seriesId: target.seriesId } : {}),
        generation: target.generation,
      }, { maxRetries: 0, signal })
      return {
        value: {
          locked: result.data.locked,
          reason: result.data.reason,
          etag: result.etag,
        },
        error: null,
      }
    } catch (cause) {
      if (signal.aborted || isAbortError(cause) || isUnexposedCommunity(cause)
          || (isProductApiError(cause) && (cause.status === 401 || cause.status === 403))) {
        return { value: null, error: null }
      }
      return {
        value: null,
        error: isProductApiError(cause)
          ? cause.recoveryHint
          : "Couldn't load comment settings.",
      }
    }
  }, [])

  const readAuthority = useCallback(async () => {
    if (!enabled || !query) return
    authorityController.current?.abort()
    const controller = new AbortController()
    authorityController.current = controller
    const current = ++operation.current
    setStatus('loading')
    setError(null)
    try {
      const resolved = await productClient.resolveCommunityTarget(query, {
        maxRetries: 0, signal: controller.signal,
      })
      if (controller.signal.aborted || current !== operation.current) return
      const [page, areaSettings] = await Promise.all([
        loadRoots(resolved, null, controller.signal),
        loadSettings(resolved, controller.signal),
      ])
      /* Late-response guard: an aborted or superseded read must not paint into
         the target that replaced it. */
      if (controller.signal.aborted || current !== operation.current) return
      setView(resolved)
      setRoots(page.items)
      setNextCursor(page.nextCursor)
      setSettings(areaSettings.value)
      setSettingsError(areaSettings.error)
      setReplies(new Map())
      setStatus('ready')
      setMessage('Comments loaded')
    } catch (cause) {
      if (controller.signal.aborted || current !== operation.current || isAbortError(cause)) return
      if (isUnexposedCommunity(cause)) {
        setStatus('unavailable')
        setView(null)
        setRoots([])
        setNextCursor(null)
        setSettings(null)
        setSettingsError(null)
        setReplies(new Map())
        return
      }
      setStatus('error')
      setError(isProductApiError(cause) ? cause.recoveryHint : "Couldn't load comments.")
    } finally {
      if (authorityController.current === controller) authorityController.current = null
    }
  }, [query?.kind, query?.id, query?.collectionId, query?.seriesId, enabled, loadRoots, loadSettings]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    operation.current += 1
    intent.current = null
    setRoots([])
    setNextCursor(null)
    setLoadingMore(false)
    setReplies(new Map())
    setSettings(null)
    setSettingsError(null)
    setOutcome(null)
    setMessage(null)
    const abortScope = () => {
      authorityController.current?.abort()
      authorityController.current = null
      for (const controller of scopeControllers.current) controller.abort()
      scopeControllers.current.clear()
    }
    if (!enabled || !query) {
      setStatus('loading')
      setView(null)
      return abortScope
    }
    void readAuthority()
    /* Unmount and every target change cancel every read this scope started. */
    return abortScope
  }, [queryKey(query ?? { kind: 'collection', id: '' }), enabled, readAuthority]) // eslint-disable-line react-hooks/exhaustive-deps

  const reload = useCallback(() => { void readAuthority() }, [readAuthority])

  const loadMore = useCallback(() => {
    if (loadingMore || nextCursor === null || view === null) return
    // The same generation guard `readAuthority` uses: a page requested before a
    // reload or a revision conflict must not append its items into the new list
    // or write its cursor over the new one.
    const current = operation.current
    const controller = new AbortController()
    scopeControllers.current.add(controller)
    setLoadingMore(true)
    setError(null)
    void loadRoots(view, nextCursor, controller.signal)
      .then((page) => {
        if (controller.signal.aborted || current !== operation.current) return
        setRoots((previous) => [...previous, ...page.items])
        setNextCursor(page.nextCursor)
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || current !== operation.current || isAbortError(cause)) return
        if (isUnexposedCommunity(cause)) {
          setStatus('unavailable')
          return
        }
        setError(isProductApiError(cause) ? cause.recoveryHint : "Couldn't load more comments.")
      })
      .finally(() => {
        scopeControllers.current.delete(controller)
        /* A superseded page still clears the flag; an aborted one (unmount or
           target change) must not write state at all. */
        if (!controller.signal.aborted) setLoadingMore(false)
      })
  }, [loadingMore, nextCursor, view, loadRoots])

  const loadReplies = useCallback(async (
    rootId: string,
    cursor: string | null,
    reset: boolean,
    signal: AbortSignal,
  ) => {
    const page = await productClient.getCommunityCommentReplies(rootId, {
      limit: COMMUNITY_COMMENTS_PAGE_SIZE,
      ...(cursor !== null ? { cursor } : {}),
    }, { signal })
    /* Late-response guard: a thread read abandoned by a target change must not
       repopulate the new target's replies map. */
    if (signal.aborted) return
    patchReplies(rootId, {
      items: reset ? page.items : [...(replies.get(rootId)?.items ?? []), ...page.items],
      nextCursor: page.nextCursor,
      loading: false,
      loadingMore: false,
      error: null,
      expanded: true,
      loaded: true,
    })
  }, [patchReplies, replies])

  const toggleReplies = useCallback((rootId: string) => {
    const current = replies.get(rootId) ?? EMPTY_REPLIES
    if (current.expanded) {
      patchReplies(rootId, { expanded: false })
      return
    }
    /* Loaded threads re-expand locally; threads holding only locally
       inserted replies (loaded=false) still fetch so pre-existing
       replies are not hidden behind the user's own new comment. */
    if (current.loaded) {
      patchReplies(rootId, { expanded: true })
      return
    }
    const controller = new AbortController()
    scopeControllers.current.add(controller)
    patchReplies(rootId, { loading: true, expanded: true, error: null })
    void loadReplies(rootId, null, true, controller.signal)
      .catch((cause: unknown) => {
        if (controller.signal.aborted || isAbortError(cause)) return
        patchReplies(rootId, {
          loading: false,
          error: isProductApiError(cause) ? cause.recoveryHint : "Couldn't load replies.",
        })
      })
      .finally(() => { scopeControllers.current.delete(controller) })
  }, [replies, patchReplies, loadReplies])

  const loadMoreReplies = useCallback((rootId: string) => {
    const current = replies.get(rootId) ?? EMPTY_REPLIES
    if (current.nextCursor === null || current.loadingMore) return
    const controller = new AbortController()
    scopeControllers.current.add(controller)
    patchReplies(rootId, { loadingMore: true, error: null })
    void loadReplies(rootId, current.nextCursor, false, controller.signal)
      .catch((cause: unknown) => {
        if (controller.signal.aborted || isAbortError(cause)) return
        patchReplies(rootId, {
          loadingMore: false,
          error: isProductApiError(cause) ? cause.recoveryHint : "Couldn't load more replies.",
        })
      })
      .finally(() => { scopeControllers.current.delete(controller) })
  }, [replies, patchReplies, loadReplies])

  const create = useCallback(async (body: string, replyToId: string | null) => {
    const target = view?.target
    if (pending || !enabled || view === null || !target) return null
    setPending(true)
    setError(null)
    /* One intent id per (target generation, reply parent, exact body): an
       exact request retry replays the saved outcome; a new body or a new
       generation allocates a fresh command id. Success clears the intent
       (mutationCall default) so a deliberate repeat post is a new command. */
    const intentId = `community-comment:${target.kind}:${target.id}:${target.generation}:${replyToId ?? 'root'}:${body.trim()}`
    intent.current = intentId
    try {
      const comment = await productClient.createCommunityComment(
        { target, body, replyToId },
        { intentId },
      )
      if (replyToId === null) {
        setRoots((previous) => [comment, ...previous])
      } else {
        // The root's replyCount counts every visible descendant; a depth-2
        // reply additionally bumps its direct parent's replyCount.
        setRoots((previous) => previous.map((root) => (
          root.id === comment.rootId
            ? { ...root, replyCount: root.replyCount + 1 }
            : root
        )))
        const thread = replies.get(comment.rootId)?.items ?? []
        const updatedThread = comment.depth === 2
          ? [...thread.map((item) => (
              item.id === comment.replyToId
                ? { ...item, replyCount: item.replyCount + 1 }
                : item
            )), comment]
          : [...thread, comment]
        patchReplies(comment.rootId, { items: updatedThread })
      }
      intent.current = null
      setOutcome('Comment posted')
      setMessage('Comment posted')
      return comment
    } catch (cause) {
      if (isAbortError(cause)) return null
      if (isRevisionConflict(cause)) {
        // Stale generation: re-resolve so the next submit is the user's
        // confirmation on the new generation.
        productClient.abandonCommunityCommentIntent(intentId)
        intent.current = null
        setOutcome('The target changed; comments were refreshed. Review and submit again.')
        setMessage('The target changed; comments were refreshed. Review and submit again.')
        void readAuthority()
        return null
      }
      if (isUnexposedCommunity(cause)) {
        setStatus('unavailable')
        return null
      }
      const hint = isProductApiError(cause) ? cause.recoveryHint : 'The comment could not be posted.'
      setError(hint)
      setMessage(hint)
      return null
    } finally {
      setPending(false)
    }
  }, [pending, enabled, view, replies, patchReplies, readAuthority])

  /* CS-04: replace one comment everywhere it is projected (root list and
     any loaded reply thread). Tombstones keep their slot — nothing is
     re-ordered or removed client-side. */
  const patchComment = useCallback((updated: CommunityComment) => {
    setRoots((previous) => previous.map((root) => (
      root.id === updated.id ? updated : root
    )))
    setReplies((previous) => {
      let changed = false
      const next = new Map(previous)
      for (const [rootId, thread] of previous) {
        if (thread.items.some((item) => item.id === updated.id)) {
          next.set(rootId, {
            ...thread,
            items: thread.items.map((item) => (item.id === updated.id ? updated : item)),
          })
          changed = true
        }
      }
      return changed ? next : previous
    })
  }, [])

  /* Shared CS-04 failure path. A 412 precondition_failed (or a stale
     generation surfacing as revision_conflict) abandons the intent and
     refreshes the projection so the user reviews the fresh state before
     retrying — the same receipt discipline as create. The notice is set
     only after the refresh lands: readAuthority's own 'Comments loaded'
     line must not clobber the review-and-retry prompt. Returns true when
     the failure was fully handled. */
  const manageConflict = useCallback(async (cause: unknown, intentId: string, what: string): Promise<boolean> => {
    if (!isPreconditionFailed(cause) && !isRevisionConflict(cause)) return false
    productClient.abandonCommunityCommentManageIntent(intentId)
    intent.current = null
    await readAuthority()
    setOutcome(`The ${what} changed; it was refreshed. Review and try again.`)
    setMessage(`The ${what} changed; it was refreshed. Review and try again.`)
    return true
  }, [readAuthority])

  const edit = useCallback(async (comment: CommunityComment, body: string) => {
    if (managePending || !enabled || view === null) return null
    setManagePending(true)
    setError(null)
    const intentId = `community-comment-edit:${comment.id}:${body.trim()}`
    intent.current = intentId
    try {
      /* The comment's strong ETag is minted server-side and never rides on
         list projections: a fresh single-comment read supplies the tag that
         conditions the write. */
      const current = await productClient.getCommunityCommentWithEtag(comment.id, { maxRetries: 0 })
      if (current.etag === null) {
        await readAuthority()
        setOutcome('The comment could not be confirmed; it was refreshed. Try again.')
        setMessage('The comment could not be confirmed; it was refreshed. Try again.')
        return null
      }
      const result = await productClient.editCommunityComment(
        comment.id, { body }, current.etag, { intentId },
      )
      patchComment(result.data)
      intent.current = null
      setOutcome('Comment updated')
      setMessage('Comment updated')
      return result.data
    } catch (cause) {
      if (isAbortError(cause)) return null
      if (await manageConflict(cause, intentId, 'comment')) return null
      if (isUnexposedCommunity(cause)) {
        setStatus('unavailable')
        return null
      }
      const hint = isProductApiError(cause) ? cause.recoveryHint : 'The comment could not be updated.'
      setError(hint)
      setMessage(hint)
      return null
    } finally {
      setManagePending(false)
    }
  }, [managePending, enabled, view, patchComment, manageConflict, readAuthority])

  const remove = useCallback(async (comment: CommunityComment) => {
    if (managePending || !enabled || view === null) return null
    setManagePending(true)
    setError(null)
    const intentId = `community-comment-delete:${comment.id}`
    intent.current = intentId
    try {
      const current = await productClient.getCommunityCommentWithEtag(comment.id, { maxRetries: 0 })
      if (current.etag === null) {
        await readAuthority()
        setOutcome('The comment could not be confirmed; it was refreshed. Try again.')
        setMessage('The comment could not be confirmed; it was refreshed. Try again.')
        return null
      }
      const result = await productClient.deleteCommunityComment(
        comment.id, current.etag, { intentId },
      )
      // The permanent tombstone replaces the comment in place; its replies
      // stay readable in the thread.
      patchComment(result.data)
      intent.current = null
      setOutcome('Comment deleted')
      setMessage('Comment deleted')
      return result.data
    } catch (cause) {
      if (isAbortError(cause)) return null
      if (await manageConflict(cause, intentId, 'comment')) return null
      if (isUnexposedCommunity(cause)) {
        setStatus('unavailable')
        return null
      }
      const hint = isProductApiError(cause) ? cause.recoveryHint : 'The comment could not be deleted.'
      setError(hint)
      setMessage(hint)
      return null
    } finally {
      setManagePending(false)
    }
  }, [managePending, enabled, view, patchComment, manageConflict, readAuthority])

  const curate = useCallback(async (comment: CommunityComment, hidden: boolean, reason: string) => {
    if (managePending || !enabled || view === null || view.canCurateComments !== true) return false
    setManagePending(true)
    setError(null)
    const intentId = `community-comment-curate:${comment.id}:${hidden}:${reason.trim()}`
    intent.current = intentId
    try {
      /* The curation overlay is an independent ETag authority: the tag comes
         from its own read, never from the comment's revision. */
      const curation = await productClient.getCommentCuration(comment.id, { maxRetries: 0 })
      if (curation.etag === null) {
        await readAuthority()
        setOutcome('The comment could not be confirmed; it was refreshed. Try again.')
        setMessage('The comment could not be confirmed; it was refreshed. Try again.')
        return false
      }
      await productClient.setCommentCuration(
        comment.id, { hidden, reason }, curation.etag, { intentId },
      )
      /* The write returns the overlay, not the comment: a fresh single read
         supplies the authoritative tombstone/restored projection. */
      const refreshed = await productClient.getCommunityComment(comment.id, { maxRetries: 0 })
      patchComment(refreshed)
      intent.current = null
      setOutcome(hidden ? 'Comment hidden' : 'Comment restored')
      setMessage(hidden ? 'Comment hidden' : 'Comment restored')
      return true
    } catch (cause) {
      if (isAbortError(cause)) return false
      if (await manageConflict(cause, intentId, 'comment')) return false
      if (isUnexposedCommunity(cause)) {
        setStatus('unavailable')
        return false
      }
      const hint = isProductApiError(cause) ? cause.recoveryHint : 'The comment could not be curated.'
      setError(hint)
      setMessage(hint)
      return false
    } finally {
      setManagePending(false)
    }
  }, [managePending, enabled, view, patchComment, manageConflict, readAuthority])

  const setAreaLocked = useCallback(async (locked: boolean, reason: string) => {
    const target = view?.target
    if (managePending || !enabled || view === null || !target
      || view.canCurateComments !== true) return false
    setManagePending(true)
    setError(null)
    const intentId = `community-comment-settings:${target.kind}:${target.id}:${locked}:${reason.trim()}`
    intent.current = intentId
    try {
      /* The settings ETag is the third independent authority. The tag held
         from the authority read conditions the write; a missing copy (the
         curator read failed earlier) is re-fetched so the write never goes
         out unconditional. */
      let tag = settings?.etag ?? null
      if (tag === null) {
        const fresh = await productClient.getCommunityCommentSettings({
          kind: target.kind,
          id: target.id,
          ...(target.collectionId !== null ? { collectionId: target.collectionId } : {}),
          ...(target.seriesId !== null ? { seriesId: target.seriesId } : {}),
          generation: target.generation,
        }, { maxRetries: 0 })
        tag = fresh.etag
      }
      if (tag === null) {
        await readAuthority()
        setOutcome('The comment area settings could not be confirmed; they were refreshed. Try again.')
        setMessage('The comment area settings could not be confirmed; they were refreshed. Try again.')
        return false
      }
      const result = await productClient.setCommunityCommentSettings(
        { target, locked, reason }, tag, { intentId },
      )
      setSettings({ locked: result.data.locked, reason: result.data.reason, etag: result.etag })
      intent.current = null
      setOutcome(locked ? 'Comment area locked' : 'Comment area unlocked')
      setMessage(locked ? 'Comment area locked' : 'Comment area unlocked')
      return true
    } catch (cause) {
      if (isAbortError(cause)) return false
      if (await manageConflict(cause, intentId, 'comment area')) return false
      if (isUnexposedCommunity(cause)) {
        setStatus('unavailable')
        return false
      }
      const hint = isProductApiError(cause) ? cause.recoveryHint : 'The comment area could not be updated.'
      setError(hint)
      setMessage(hint)
      return false
    } finally {
      setManagePending(false)
    }
  }, [managePending, enabled, view, settings, manageConflict, readAuthority])

  return {
    status,
    view,
    roots,
    nextCursor,
    loadingMore,
    error,
    pending,
    managePending,
    message,
    outcome,
    replies,
    settings,
    settingsError,
    reload,
    loadMore,
    toggleReplies,
    loadMoreReplies,
    create,
    edit,
    remove,
    curate,
    setAreaLocked,
  }
}
