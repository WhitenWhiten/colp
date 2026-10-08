import { useCallback, useEffect, useRef, useState } from 'react'
import {
  isProductApiError,
  productClient,
  type EditableNodeView,
  type EditorSnapshot,
} from '../../api'
import { childrenOf } from '../../lib/libraryTree'
import { snapshotParentRevision } from './mutations'

/**
 * FO-06 collection-internal manual ordering.
 *
 * The current folder layer (folders + bookmarks, sharing one canonical
 * position space per parent) can be reordered by drag or by keyboard inside
 * the reorder list; every committed change goes through the preserved
 * canonical moveCollectionNode endpoint with afterId/beforeId anchors and
 * the same-per-gesture Known-Command-Id, exactly like the sidebar reorder
 * persists through updateMyLibraryOrder. The Library sidebar order stays a
 * separate authority (see ordering.ts).
 */

export type LayerReorderStep = {
  nodeId: string
  /** Anchor for the canonical move; both are always sent, nulls append. */
  afterId: string | null
  beforeId: string | null
}

/**
 * Plans the minimal sequence of same-parent moves that turns `current` into
 * `target`. Each step is anchored to the already-fixed prefix (front-building)
 * so a step never depends on a sibling that will move later. Only moves that
 * actually change the order are emitted; the result is `[]` for identical
 * orders so the caller can skip the mutation entirely.
 */
export function planLayerMoves(
  current: readonly string[],
  target: readonly string[],
): LayerReorderStep[] {
  if (current.length !== target.length) return []
  const setEqual = current.length === target.length
    && new Set(current).size === new Set(target).size
    && current.every((id) => target.includes(id))
  if (!setEqual || current.length < 2) return []

  const work = [...current]
  const steps: LayerReorderStep[] = []
  for (let i = 0; i < target.length; i += 1) {
    const wanted = target[i]!
    if (work[i] === wanted) continue
    const from = work.indexOf(wanted)
    if (from === -1) continue
    steps.push({
      nodeId: wanted,
      afterId: i === 0 ? null : target[i - 1]!,
      beforeId: i === 0 ? work[0]! : null,
    })
    work.splice(from, 1)
    work.splice(i, 0, wanted)
  }
  return steps
}

export const PIN_ORDER_NOTICE = 'Pinned bookmarks stay above other bookmarks. Pin or unpin them in the browser extension.'

/**
 * How often an unpinned bookmark sits above a pinned one in `ids`. Folders
 * never count: pins only order the bookmarks among themselves. The web shows
 * pins but does not set them, so a reorder may not add to this count.
 */
export function pinInversions(snap: EditorSnapshot, ids: readonly string[]): number {
  const kinds = new Map(snap.nodes.map((node) => [node.id, node]))
  let others = 0
  let inversions = 0
  for (const id of ids) {
    const node = kinds.get(id)
    if (node?.kind !== 'bookmark') continue
    if (node.pinned) inversions += others
    else others += 1
  }
  return inversions
}

/** Canonical order of the layer under `parentId` (position token order). */
export function layerEntryIds(
  snap: EditorSnapshot | null,
  parentId: string | null,
): readonly string[] {
  if (!snap) return []
  const rootId = snap.root.id
  const effectiveParent = parentId && snap.nodes.some(
    (node) => node.id === parentId && node.kind === 'folder',
  )
    ? parentId
    : rootId
  return childrenOf(effectiveParent, snap.nodes).map((node) => node.id)
}

export function layerEntryTitle(snap: EditorSnapshot, nodeId: string): string {
  if (nodeId === snap.root.id) return snap.root.title
  const node = snap.nodes.find((candidate) => candidate.id === nodeId)
  if (!node) return nodeId
  return node.title || (node.kind === 'bookmark' ? node.url : nodeId)
}

function isStaleMoveError(err: unknown): boolean {
  return isProductApiError(err) && (
    err.code === 'precondition_failed'
    || err.code === 'position_context_stale'
    || err.code === 'revision_conflict'
  )
}

function isUnknownOutcome(err: unknown): boolean {
  return isProductApiError(err) && (err.code === 'transport_error' || err.status === 0)
}

export type LayerReorderOptions = {
  snap: EditorSnapshot | null
  /** Collection id whose tree is shown; its snapshot is what reorder reads. */
  collectionId: string | null
  /** The folder whose layer is being reordered (null = collection root). */
  parentId: string | null
  loadTree: (key: string, opts?: { silent?: boolean }) => Promise<void>
  success: (message: string) => void
  error: (message: string) => void
  /** Neutral notice, e.g. why a pinned bookmark cannot be passed. */
  notice?: (message: string) => void
}

/**
 * Reorder session for one folder layer. Drag and keyboard both call
 * `change` (the same list state), so they reach the same command path;
 * `finish` persists the session's order through moveCollectionNode with one
 * Known-Command-Id per node per gesture.
 */
export function useLibraryLayerReorder(options: LayerReorderOptions) {
  const { snap, collectionId, parentId, loadTree, success, error, notice } = options
  const noticedRef = useRef(false)

  const [active, setActive] = useState(false)
  const [ids, setIds] = useState<readonly string[]>([])
  const [saving, setSaving] = useState(false)
  const [refreshRound, setRefreshRound] = useState(0)

  const idsRef = useRef(ids)
  idsRef.current = ids
  const snapRef = useRef(snap)
  snapRef.current = snap
  const activeRef = useRef(active)
  activeRef.current = active
  const savingRef = useRef(saving)
  savingRef.current = saving

  const sessionRef = useRef<{
    collectionId: string
    parentId: string
    nonce: string
  } | null>(null)
  const pendingTargetRef = useRef<readonly string[] | null>(null)
  const executingRef = useRef(false)

  /* Exit the reorder mode (and drop a pending session) when the viewed
     collection or folder changes; the local arrangement never leaks into
     another folder's list. */
  useEffect(() => {
    setActive(false)
    setSaving(false)
    pendingTargetRef.current = null
    setRefreshRound(0)
    // keyed on the visible layer: collection + parent
  }, [collectionId, parentId])

  /**
   * One move invocation for a planned step. The node etag travels as
   * If-Match; the parent's children revision is refreshed from the previous
   * result so chained moves never send a stale position fence.
   */
  const runStep = useCallback(async (
    step: LayerReorderStep,
    currentSnap: EditorSnapshot,
    revisionOf: () => string,
  ) => {
    const session = sessionRef.current
    if (!session) throw new Error('reorder session missing')
    const node = currentSnap.nodes.find((candidate) => candidate.id === step.nodeId)
    if (!node) throw new Error('A reordered item no longer exists in this collection')
    const intentId = productClient.mutationIntentKey(
      `layer-reorder:${session.collectionId}:${session.parentId}:${step.nodeId}`,
      session.nonce,
    )
    return productClient.moveCollectionNode(
      session.collectionId,
      step.nodeId,
      {
        newParentId: session.parentId,
        afterId: step.afterId,
        beforeId: step.beforeId,
        baseSourceParentRevision: revisionOf(),
        baseTargetParentRevision: revisionOf(),
      },
      node.etag,
      { intentId, signal: undefined },
    )
  }, [])

  const execute = useCallback(async (
    target: readonly string[],
    allowRefresh: boolean,
  ): Promise<'done' | 'resume-needed'> => {
    const currentSnap = snapRef.current
    const session = sessionRef.current
    if (!currentSnap || !session) return 'done'
    let steps = planLayerMoves(layerEntryIds(currentSnap, session.parentId), target)
    let unknownRetried = false
    let refreshedOnce = false
    let childrenRevision = snapshotParentRevision(session.parentId, currentSnap)
    while (steps.length > 0) {
      const step = steps[0]!
      try {
        const result = await runStep(step, currentSnap, () => childrenRevision)
        childrenRevision = result.sourceParent.childrenRevision
        /* Same-parent reorder: both fences report the same parent. */
        unknownRetried = false
        steps = steps.slice(1)
      } catch (err) {
        if (isStaleMoveError(err) && allowRefresh && !refreshedOnce) {
          refreshedOnce = true
          /* 412/409 stale position or node revision: refresh the current
             snapshot (new ETag/revision), then re-plan against it. */
          pendingTargetRef.current = target
          await loadTree(session.collectionId, { silent: true })
          setRefreshRound((round) => round + 1)
          return 'resume-needed'
        }
        if (isUnknownOutcome(err) && !unknownRetried) {
          /* Network result unknown: retry the SAME step with the SAME
             Known-Command-Id (the intent id is unchanged), so the server
             receipt replay can never produce a second position. */
          unknownRetried = true
          continue
        }
        throw err
      }
    }
    return 'done'
  }, [loadTree, runStep])

  /* After a stale-move refresh landed, re-plan against the fresh snapshot. */
  useEffect(() => {
    if (refreshRound === 0 || !activeRef.current || executingRef.current) return
    const target = pendingTargetRef.current
    if (!target) return
    const session = sessionRef.current
    if (!session) return
    executingRef.current = true
    void (async () => {
      try {
        const outcome = await execute(target, false)
        if (outcome === 'done') {
          success('Order saved')
          finishExit()
        }
      } catch (err) {
        finishExit()
        error(describeMoveError(err))
      } finally {
        executingRef.current = false
        /* Reconcile the layer against the server after any resumed attempt. */
        void loadTree(session.collectionId, { silent: true })
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshRound, snap])

  const finishExit = useCallback(() => {
    setSaving(false)
    setActive(false)
    pendingTargetRef.current = null
    setRefreshRound(0)
  }, [])

  const describeMoveError = useCallback((err: unknown): string => {
    if (isProductApiError(err)) {
      if (err.code === 'insufficient_permission') return 'You do not have permission to reorder this collection'
      return err.recoveryHint ?? 'Could not save this order'
    }
    return 'Could not save this order'
  }, [])

  const begin = useCallback(() => {
    const currentSnap = snapRef.current
    if (!currentSnap || !collectionId || savingRef.current) return
    sessionRef.current = {
      collectionId,
      parentId: parentId ?? currentSnap.root.id,
      nonce: productClient.newCommandId(),
    }
    setRefreshRound(0)
    noticedRef.current = false
    setIds(layerEntryIds(currentSnap, parentId))
    setActive(true)
    setSaving(false)
  }, [collectionId, parentId])

  const change = useCallback((next: readonly string[]) => {
    if (!activeRef.current || savingRef.current) return
    const currentSnap = snapRef.current
    // A pinned bookmark and an unpinned one never swap sides; say why once per session.
    if (currentSnap && pinInversions(currentSnap, next) > pinInversions(currentSnap, idsRef.current)) {
      if (!noticedRef.current) notice?.(PIN_ORDER_NOTICE)
      noticedRef.current = true
      return
    }
    setIds(next)
  }, [notice])

  const finish = useCallback(async () => {
    if (!activeRef.current || savingRef.current) return
    const currentSnap = snapRef.current
    const session = sessionRef.current
    if (!currentSnap || !session) return
    const target = idsRef.current
    if (planLayerMoves(layerEntryIds(currentSnap, session.parentId), target).length === 0) {
      finishExit()
      return
    }
    setSaving(true)
    let handedOff = false
    try {
      const outcome = await execute(target, true)
      if (outcome === 'done') {
        success('Order saved')
        finishExit()
      } else {
        /* 'resume-needed': the refresh effect continues; keep saving=true. */
        handedOff = true
      }
    } catch (err) {
      finishExit()
      error(describeMoveError(err))
    } finally {
      /* The layer may have changed under us; reconcile once against the
         server after any attempt that finished here (the resumed path
         reconciles in its own effect). */
      if (!handedOff) void loadTree(session.collectionId, { silent: true })
    }
  }, [describeMoveError, error, execute, finishExit, loadTree, success])

  /* Escape while reordering dismisses like the sidebar (same persist path). */
  useEffect(() => {
    if (!active) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') void finish()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [active, finish])

  return {
    active,
    saving,
    ids,
    begin,
    change,
    finish,
  }
}

export type LibraryLayerReorder = ReturnType<typeof useLibraryLayerReorder>