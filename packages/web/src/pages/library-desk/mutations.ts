import { useCallback, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { NavigateFunction } from 'react-router-dom'
import {
  isProductApiError,
  productClient,
  type EditableNodeView,
  type EditorSnapshot,
} from '../../api'
import type { ToastAction } from '../../components/AppToast'
import type { DestinationPick } from '../../components/CollectionDestinationPicker'
import { useConfirm } from '../../components/ConfirmModal'
import type { BookmarkNode, FolderNode } from '../../lib/libraryTree'
import { retag } from '../../lib/libraryTags'
import { plural } from '../../lib/plural'
import type { TreeEntry } from './data'
import { libraryDeleteRequest } from './LibraryOverlays'
import type { BulkProgress } from './selection'

export type ComposeKind = 'bookmark' | 'folder'

/** What Undo keeps of a deleted bookmark (new id on rebuild; annotations and
    uploaded favicons are not recoverable). */
/**
 * Progress of one batch action, so a retry after a partial failure does not redo
 * what already succeeded.
 *
 * A failed batch reports e.g. "Copied 3, 4 failed" and the only way forward is to
 * run the same action again over the same selection. Every item used to be
 * re-issued with a fresh command id, so the three that had already been created
 * were created a second time. The record below is created per user action,
 * consulted per item, and only retired once every item has been confirmed — a
 * failure keeps it so the retry can skip.
 *
 * Items are identified by their INDEX in this attempt's selection, never by a
 * property of the bookmark. A selection may legitimately contain two entries
 * that share every property a content-derived key could use — two deleted
 * bookmarks with the same parent and url, or the same node listed twice — and
 * such a key would silently collapse them, rebuild one, and still report the
 * full count. An index is unique by construction, and a retry re-runs the same
 * action over the same selection in the same order, so the index is stable
 * across attempts.
 */
interface BatchProgress {
  readonly scope: string
  /** Indices of `scope`'s selection that this action has confirmed. */
  readonly done: Set<string>
}
function scopeKey(parts: readonly (string | number | null)[]): string {
  return parts.map((part) => String(part ?? '')).join('\u0000')
}

export type RestorableBookmark = Pick<
  BookmarkNode,
  'title' | 'url' | 'description' | 'tags' | 'visibility' | 'parentId'
>

/** childrenRevision of a parent (root included) from the loaded snapshot. */
export function snapshotParentRevision(parentId: string, snap: EditorSnapshot): string {
  if (parentId === snap.root.id) return snap.root.childrenRevision
  const folder = snap.nodes.find((node) => node.id === parentId && node.kind === 'folder') as
    | FolderNode
    | undefined
  return folder?.childrenRevision ?? snap.root.childrenRevision
}

export function useLibraryDeskMutations(options: {
  snap: EditorSnapshot | null
  parentId: string
  loadTree: (key: string, opts?: { silent?: boolean }) => Promise<void>
  treesRef: MutableRefObject<Record<string, TreeEntry>>
  navigate: NavigateFunction
  toast: (message: string) => void
  success: (message: string, extra?: { action: ToastAction }) => void
  error: (message: string) => void
  refreshSession: () => Promise<void>
  exitSelectMode: () => void
  setBulk: Dispatch<SetStateAction<BulkProgress | null>>
}) {
  const {
    snap,
    loadTree,
    treesRef,
    navigate,
    toast,
    success,
    error,
    refreshSession,
    exitSelectMode,
    setBulk,
  } = options

  const confirm = useConfirm()
  const batchProgress = useRef<BatchProgress | null>(null)
  /**
   * The record for this action's selection. A different scope starts over —
   * including a different destination, which is part of the scope for actions
   * whose target is chosen per action.
   */
  const batchFor = (scope: string): { record: BatchProgress; isDone: (itemKey: string) => boolean } => {
    // Completion is keyed by ITEM, not by position, and that is the whole fix for
    // two opposite failures:
    //
    //  - POSITIONAL skipping re-ran the wrong work. After a partial bulk failure
    //    the component reloads and re-derives the selection, so if it changed at all
    //    — a moved node gone from it, a folder collapsed — index N named a
    //    DIFFERENT node and the retry skipped the one that actually failed while
    //    reporting success.
    //  - A per-selection SKIP LIST is not enough either, which an independent
    //    verifier caught in my first attempt: for Copy the source nodes stay in the
    //    selection, so adding a bookmark changed the selection, started the record
    //    over, and re-copied everything that had already succeeded.
    //
    // Keying by item id makes both correct: an item that finished is skipped
    // wherever it now sits, and an item that did not is always retried.
    const existing = batchProgress.current
    const record = existing !== null && existing.scope === scope
      ? existing
      : { scope, done: new Set<string>() }
    batchProgress.current = record
    return {
      record,
      // Out-of-range indices belong to a different selection, so they are never
      // treated as done.
      isDone: (itemKey) => record.done.has(itemKey),
    }
  }
  const completeBatch = (): void => { batchProgress.current = null }
  const snapCollectionIdRef = useRef(snap?.collection.id)
  snapCollectionIdRef.current = snap?.collection.id

  const [compose, setCompose] = useState<ComposeKind | null>(null)
  const [busy, setBusy] = useState(false)
  const [createTitle, setCreateTitle] = useState('')
  const [createUrl, setCreateUrl] = useState('https://')
  const [createUrlError, setCreateUrlError] = useState<string | null>(null)
  const [createTitleError, setCreateTitleError] = useState<string | null>(null)

  const resetCompose = useCallback(() => {
    setCompose(null)
    setCreateTitle('')
    setCreateUrl('https://')
    setCreateUrlError(null)
    setCreateTitleError(null)
  }, [])

  const openCompose = (kind: ComposeKind) => {
    setCompose(kind)
    setCreateTitle('')
    setCreateUrl('https://')
    setCreateUrlError(null)
    setCreateTitleError(null)
  }

  const onCreate = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!snap || !compose || !snap.capabilities.createNode) return
    let title = createTitle.trim()
    if (compose === 'folder') {
      if (!title) {
        setCreateTitleError('Title is required')
        return
      }
      setCreateTitleError(null)
    }
    const rawUrl = createUrl.trim()
    if (compose === 'bookmark') {
      // Validation stays inline under the field (role=alert), never a toast.
      if (!rawUrl) {
        setCreateUrlError('URL is required')
        return
      }
      let parsed: URL
      try {
        parsed = new URL(rawUrl)
      } catch {
        setCreateUrlError('Enter a valid URL')
        return
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        setCreateUrlError('URL must be http or https')
        return
      }
      setCreateUrlError(null)
      // Title is optional for bookmarks: an empty one falls back to the host.
      if (!title) title = parsed.hostname.replace(/^www\./, '') || rawUrl
    }
    const parentId = options.parentId || snap.root.id
    setBusy(true)
    try {
      const intentId = productClient.mutationIntentKey(
        `create-node:${snap.collection.id}:${parentId}`,
        productClient.newCommandId(),
      )
      await productClient.createCollectionNode(
        snap.collection.id,
        {
          parentId,
          afterId: null,
          beforeId: null,
          node:
            compose === 'folder'
              ? { kind: 'folder', title, description: null, tags: [], visibility: 'inherit' }
              : { kind: 'bookmark', title, url: rawUrl, description: null, tags: [], visibility: 'inherit' },
        },
        { intentId },
      )
      success(compose === 'folder' ? 'Folder created' : 'Bookmark created')
      setCompose(null)
      setCreateTitle('')
      setCreateUrl('https://')
      await loadTree(snap.collection.id, { silent: true })
    } catch (err) {
      if (isProductApiError(err) && err.isAuthRequired) {
        toast('Sign in required')
        navigate(`/login?returnTo=${encodeURIComponent(`/library/${snap.collection.id}`)}`)
      } else if (isProductApiError(err) && err.isCsrfFailed) {
        await refreshSession()
        toast('Your session was refreshed. Try again.')
      } else {
        error(isProductApiError(err) ? err.recoveryHint : 'Could not add to this collection')
      }
    } finally {
      setBusy(false)
    }
  }

  /** Library route for a destination: /library/{collection}[?folder={parent}]. */
  const destinationPath = (destination: DestinationPick) =>
    destination.parentTitle === null
      ? `/library/${encodeURIComponent(destination.collectionId)}`
      : `/library/${encodeURIComponent(destination.collectionId)}?folder=${encodeURIComponent(destination.parentId)}`

  /** "View in {folder}" — the collection title stands in for the root. */
  const destinationAction = (destination: DestinationPick) => ({
    label: `View in ${destination.parentTitle ?? destination.collectionTitle}`,
    to: destinationPath(destination),
  })

  /** Stopped on the first failure: succeeded rows stay, the rest are skipped. */
  const bulkFailure = (
    err: unknown,
    verbPast: 'Moved' | 'Copied' | 'Deleted' | 'Tagged',
    done: number,
    total: number,
    fallback: string,
  ) => {
    if (total > 1) error(`${verbPast} ${done}, ${total - done} failed`)
    else error(isProductApiError(err) ? err.recoveryHint : fallback)
  }

  const runMove = async (nodes: EditableNodeView[], destination: DestinationPick) => {
    if (!snap || !snap.capabilities.moveNode || nodes.length === 0) return
    const operationCollectionId = snap.collection.id
    const total = nodes.length
    setBulk({ verb: 'Moving', done: 0, total })
    // Each MoveNodeResult returns the refreshed childrenRevision of both
    // parents; the next chained call must send those refreshed values or the
    // backend answers 409 position_context_stale.
    const revisions = new Map<string, string>()
    const revisionOf = (parentId: string) =>
      revisions.get(parentId) ?? snapshotParentRevision(parentId, snap)
    let done = 0
    // The destination is part of the action's identity: a retry aimed somewhere
    // else is a new move, not a resumption of this one, and must not inherit
    // this record's skips.
    const batch = batchFor(scopeKey(['move', operationCollectionId, destination.parentId]))
    try {
      for (const [index, node] of nodes.entries()) {
        if (batch.isDone(node.id)) continue
        const intentId = productClient.mutationIntentKey(
          `move-node:${node.id}`,
          productClient.newCommandId(),
        )
        const result = await productClient.moveCollectionNode(
          operationCollectionId,
          node.id,
          {
            newParentId: destination.parentId,
            afterId: null,
            beforeId: null,
            baseSourceParentRevision: revisionOf(node.parentId),
            baseTargetParentRevision: revisionOf(destination.parentId),
          },
          node.etag,
          { intentId },
        )
        revisions.set(result.sourceParent.id, result.sourceParent.childrenRevision)
        revisions.set(result.targetParent.id, result.targetParent.childrenRevision)
        batch.record.done.add(node.id)
        done += 1
        setBulk({ verb: 'Moving', done: batch.record.done.size, total })
      }
      success(
        total === 1
          ? (nodes[0]?.kind === 'folder' ? 'Folder moved' : 'Bookmark moved')
          : `Moved ${plural(total, nodes.some((n) => n.kind === 'folder') ? 'item' : 'bookmark')}`,
        { action: destinationAction(destination) },
      )
      completeBatch()
      exitSelectMode()
    } catch (err) {
      bulkFailure(err, 'Moved', done, total, 'Could not move this bookmark')
    } finally {
      setBulk(null)
      await loadTree(operationCollectionId, { silent: true })
    }
  }

  /* Copy stays bookmark-only: a folder has no url to duplicate and the copy
     picker never sees one. */
  const runCopy = async (allNodes: EditableNodeView[], destination: DestinationPick) => {
    const nodes = allNodes.filter((node): node is BookmarkNode => node.kind === 'bookmark')
    if (nodes.length === 0) return
    const total = nodes.length
    setBulk({ verb: 'Copying', done: 0, total })
    let done = 0
    const batch = batchFor(scopeKey(['copy', destination.collectionId, destination.parentId]))
    try {
      for (const [index, node] of nodes.entries()) {
        if (batch.isDone(node.id)) continue
        const intentId = productClient.mutationIntentKey(
          `copy-node:${destination.collectionId}:${node.id}`,
          productClient.newCommandId(),
        )
        // Copies carry title/url/note/tags/visibility; favicon uploads and
        // annotations stay with the original bookmark.
        await productClient.createCollectionNode(
          destination.collectionId,
          {
            parentId: destination.parentId,
            afterId: null,
            beforeId: null,
            node: {
              kind: 'bookmark',
              title: node.title,
              url: node.url,
              description: node.description,
              tags: node.tags,
              visibility: node.visibility,
            },
          },
          { intentId },
        )
        batch.record.done.add(node.id)
        done += 1
        setBulk({ verb: 'Copying', done: batch.record.done.size, total })
      }
      success(total === 1 ? 'Bookmark copied' : `Copied ${total} bookmarks`, {
        action: destinationAction(destination),
      })
      completeBatch()
      exitSelectMode()
    } catch (err) {
      bulkFailure(err, 'Copied', done, total, 'Could not copy this bookmark')
    } finally {
      setBulk(null)
      // Refresh the destination tree when the desk already shows it.
      if (treesRef.current[destination.collectionId]) {
        await loadTree(destination.collectionId, { silent: true })
      }
    }
  }

  /** Adds and removes tags across the selection; bookmarks already in that state are left alone. */
  const runTag = async (allNodes: EditableNodeView[], change: { add: string[]; remove: string[] }) => {
    if (!snap || !snap.capabilities.updateNode) return
    const nodes = allNodes.filter((node): node is BookmarkNode => node.kind === 'bookmark' && !node.readOnly)
    const pending = nodes
      .map((node) => ({ node, tags: retag(node.tags, change.add, change.remove) }))
      .filter(({ node, tags }) => tags.length !== node.tags.length || tags.some((tag, index) => tag !== node.tags[index]))
    if (pending.length === 0) {
      exitSelectMode()
      return
    }
    const operationCollectionId = snap.collection.id
    const total = pending.length
    setBulk({ verb: 'Tagging', done: 0, total })
    let done = 0
    const batch = batchFor(scopeKey(['tag', operationCollectionId, change.add.join('\n'), change.remove.join('\n')]))
    try {
      for (const { node, tags } of pending) {
        if (batch.isDone(node.id)) continue
        const intentId = productClient.mutationIntentKey(`retag-node:${node.id}`, productClient.newCommandId())
        await productClient.updateCollectionNode(operationCollectionId, node.id, { tags }, node.etag, { intentId })
        batch.record.done.add(node.id)
        done += 1
        setBulk({ verb: 'Tagging', done: batch.record.done.size, total })
      }
      success(total === 1 ? 'Tags updated' : `Updated tags on ${total} bookmarks`)
      completeBatch()
      exitSelectMode()
    } catch (err) {
      bulkFailure(err, 'Tagged', done, total, "Couldn't update these tags")
    } finally {
      setBulk(null)
      await loadTree(operationCollectionId, { silent: true })
    }
  }

  /**
   * Rebuilds deleted bookmarks from their cached payloads via Undo. The nodes
   * get new ids; annotations and uploaded favicons are not recoverable
   * (accepted boundary). A parent folder that vanished in the meantime falls
   * back to the collection root.
   */
  const undoDelete = async (collectionId: string, payloads: RestorableBookmark[]) => {
    // A restore payload carries no id (it is the deleted bookmark's data), so its
    // completion key is built from the fields that identify it.
    const restoreKeyOf = (payload: { readonly parentId: string; readonly url: string;
      readonly title: string; readonly description?: string | null }): string =>
      [payload.parentId, payload.url, payload.title, payload.description ?? ''].join('\u0000')
    // Position is the identity here — two deleted bookmarks can legitimately share
    // parent and url, so a content key would collapse them (aaf76fac4). The payload
    // COUNT goes into the scope so a different deletion does not inherit the
    // positions of this one.
    const batch = batchFor(scopeKey(['restore', collectionId, payloads.length]))
    let done = 0
    try {
      for (const [index, payload] of payloads.entries()) {
        // The payload carries no node id (the node is gone), so the item is
        // identified by its position in the deletion this Undo belongs to. Its
        // parent and url must NOT be part of the identity: two deleted bookmarks
        // can legitimately share both, and a content-derived key would rebuild
        // one of them and still report the full count.
        if (batch.isDone(String(index))) continue
        const currentSnap = treesRef.current[collectionId]?.snap
        const parentAlive = currentSnap != null && (
          payload.parentId === currentSnap.root.id
          || currentSnap.nodes.some((node) => node.id === payload.parentId && node.kind === 'folder')
        )
        // The effective parent is recomputed per attempt: a vanished folder
        // falls back to the collection root.
        const parentId = parentAlive ? payload.parentId : currentSnap?.root.id ?? payload.parentId
        // The index is part of the intent scope: two restores that share a
        // parent and url (the same pair two deleted duplicates produce) would
        // otherwise carry one idempotency key, and the API would treat the
        // second rebuild as a replay of the first and create nothing.
        const intentId = productClient.mutationIntentKey(
          `restore-node:${collectionId}:${parentId}:${index}`,
          productClient.newCommandId(),
        )
        await productClient.createCollectionNode(
          collectionId,
          {
            parentId,
            afterId: null,
            beforeId: null,
            node: {
              kind: 'bookmark',
              title: payload.title,
              url: payload.url,
              description: payload.description,
              tags: payload.tags,
              visibility: payload.visibility,
            },
          },
          { intentId },
        )
        batch.record.done.add(String(index))
        done += 1
      }
      // The success copy counts what this attempt rebuilt, because that is the
      // work the user just watched happen. A retry that finishes an earlier
      // partial failure rebuilt fewer than the whole deletion, so saying
      // "Restored 2 bookmarks" there would overstate this attempt; the record is
      // retired only here, after every item has been confirmed.
      const rebuilt = batch.record.done.size
      const finished = rebuilt === done ? '' : ` (${rebuilt} of ${payloads.length} restored)`
      success(`${done === 1 ? 'Bookmark restored' : `Restored ${done} bookmarks`}${finished}`)
      completeBatch()
    } catch (err) {
      // Stopped on the first failure: rebuilt rows stay, the rest are skipped.
      // `total` is the whole selection, so the leftover includes the items a
      // previous attempt already rebuilt.
      const total = payloads.length
      if (total > 1) error(`Restored ${batch.record.done.size}, ${total - batch.record.done.size} failed`)
      else error(isProductApiError(err) ? err.recoveryHint : 'Could not restore this bookmark')
    } finally {
      await loadTree(collectionId, { silent: true })
    }
  }

  const runDelete = async (nodes: EditableNodeView[], confirmedContentEtag = snap?.collection.contentEtag) => {
    if (!snap || !snap.capabilities.deleteNode || nodes.length === 0) return
    let contentEtag = confirmedContentEtag
    const operationCollectionId = snap.collection.id
    // Captured before the delete so Undo can rebuild each bookmark. A folder
    // takes its subtree with it and is not restorable, so a delete containing
    // a folder offers no Undo affordance.
    const hasFolder = nodes.some((node) => node.kind === 'folder')
    const restorable: RestorableBookmark[] = nodes
      .filter((node): node is BookmarkNode => node.kind === 'bookmark')
      .map((node) => ({
        title: node.title,
        url: node.url,
        description: node.description,
        tags: node.tags,
        visibility: node.visibility,
        parentId: node.parentId,
      }))
    const total = nodes.length
    setBulk({ verb: 'Deleting', done: 0, total })
    let done = 0
    const batch = batchFor(scopeKey(['delete', operationCollectionId]))
    try {
      for (const [index, node] of nodes.entries()) {
        if (batch.isDone(node.id)) continue
        const intentId = productClient.mutationIntentKey(
          `delete-node:${node.id}`,
          productClient.newCommandId(),
        )
        const result = await productClient.deleteCollectionNode(operationCollectionId, node.id, node.etag, {
          intentId,
          ...(node.kind === 'folder' ? { recursive: true, ifContentMatch: contentEtag } : {}),
        })
        // Advance only from our committed result, never from an unrelated reload.
        contentEtag = result?.fence.contentEtag ?? contentEtag
        batch.record.done.add(node.id)
        done += 1
        setBulk({ verb: 'Deleting', done: batch.record.done.size, total })
      }
      success(
        total === 1
          ? (hasFolder ? 'Folder deleted' : 'Bookmark deleted')
          : `Deleted ${plural(total, hasFolder ? 'item' : 'bookmark')}`,
        hasFolder || restorable.length === 0
          ? undefined
          : { action: { label: 'Undo', onClick: () => void undoDelete(operationCollectionId, restorable) } },
      )
      completeBatch()
      exitSelectMode()
    } catch (err) {
      bulkFailure(err, 'Deleted', done, total, 'Could not delete this bookmark')
    } finally {
      setBulk(null)
      await loadTree(operationCollectionId, { silent: true })
    }
  }

  const runDeleteRef = useRef(runDelete)
  runDeleteRef.current = runDelete

  const requestDelete = useCallback(async (nodes: EditableNodeView[]) => {
    if (nodes.length === 0) return
    const collectionId = snapCollectionIdRef.current
    const contentEtag = snap?.collection.contentEtag
    const ok = await confirm(libraryDeleteRequest(nodes, snap?.nodes ?? []))
    if (!ok || snapCollectionIdRef.current !== collectionId) return
    await runDeleteRef.current(nodes, contentEtag)
  }, [confirm, snap])

  return {
    compose,
    setCompose,
    busy,
    createTitle,
    setCreateTitle,
    createUrl,
    setCreateUrl,
    createUrlError,
    setCreateUrlError,
    createTitleError,
    setCreateTitleError,
    resetCompose,
    openCompose,
    onCreate,
    runMove,
    runCopy,
    runTag,
    runDelete,
    requestDelete,
  }
}

export type LibraryDeskMutations = ReturnType<typeof useLibraryDeskMutations>
