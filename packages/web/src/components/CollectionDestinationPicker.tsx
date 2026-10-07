import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  isProductApiError,
  productClient,
  type EditableNodeView,
  type OwnedCollectionListItem,
} from '../api'
import { childrenOf, isAbort } from '../lib/libraryTree'
import { plural } from '../lib/plural'
import { EmptyState, LoadingState } from './EmptyState'
import { Icon } from './Icon'
import { Modal } from './Modal'

export type DestinationPick = {
  collectionId: string
  parentId: string
  /** Human labels so callers can point at the destination ("View in …"). */
  collectionTitle: string
  /** Folder title; null when parentId is the collection root. */
  parentTitle: string | null
}

type FolderOption = { id: string; title: string; depth: number }

type TargetTree =
  | { status: 'loading' }
  | { status: 'ready'; rootId: string; nodes: EditableNodeView[] }
  | { status: 'error'; message: string }

type Props = {
  mode: 'move' | 'copy' | 'collection'
  /** Move mode: the current collection is locked as the only destination. */
  current?: {
    collection: { id: string; title: string }
    rootId: string
    nodes: EditableNodeView[]
  }
  /** Copy / collection modes: owned collections (destination or source candidates). */
  owned?: OwnedCollectionListItem[]
  /** Copy mode: shared collections; only capabilities.createNode may receive. */
  shared?: OwnedCollectionListItem[]
  /** Number of bookmarks the action applies to. Unused in collection mode. */
  count?: number
  /** What the moved selection is made of — names the count honestly. */
  noun?: 'bookmark' | 'folder' | 'item'
  busy?: boolean
  /**
   * Move mode: the shared current parent of every moved bookmark, disabled
   * and flagged "(current)". Null (mixed parents) disables nothing.
   */
  currentParentId?: string | null
  /**
   * Move mode: ids of the nodes being moved. Moved folders — and everything
   * inside them — are never offered as destinations (a folder cannot move
   * into its own subtree).
   */
  movingIds?: readonly string[]
  onPick: (destination: DestinationPick) => void
  onClose: () => void
}

/** Depth-first folder list with indentation depth; cycles and excluded ids are skipped. */
function folderOptions(
  rootId: string,
  nodes: EditableNodeView[],
  exclude?: ReadonlySet<string>,
): FolderOption[] {
  const options: FolderOption[] = []
  const visit = (parentId: string, depth: number, lineage: ReadonlySet<string>) => {
    for (const node of childrenOf(parentId, nodes)) {
      if (node.kind !== 'folder' || lineage.has(node.id) || exclude?.has(node.id)) continue
      options.push({ id: node.id, title: node.title, depth })
      const next = new Set(lineage)
      next.add(node.id)
      visit(node.id, depth + 1, next)
    }
  }
  visit(rootId, 0, new Set([rootId]))
  return options
}

/** The moved folders plus every id inside them — destinations a move must never offer. */
function movedSubtreeIds(nodes: EditableNodeView[], movingIds: readonly string[]): Set<string> {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const excluded = new Set<string>()
  const stack = movingIds.filter((id) => byId.get(id)?.kind === 'folder')
  while (stack.length > 0) {
    const id = stack.pop()!
    if (excluded.has(id)) continue
    excluded.add(id)
    for (const child of childrenOf(id, nodes)) stack.push(child.id)
  }
  return excluded
}

function FolderList({
  collectionId,
  collectionTitle,
  rootId,
  nodes,
  busy,
  currentParentId = null,
  excludeIds,
  onPick,
}: {
  collectionId: string
  collectionTitle: string
  rootId: string
  nodes: EditableNodeView[]
  busy: boolean
  /** Move mode: the bookmarks' shared current parent is inert and flagged. */
  currentParentId?: string | null
  /** Move mode: moved folders and their subtrees — never destinations. */
  excludeIds?: ReadonlySet<string>
  onPick: (destination: DestinationPick) => void
}) {
  const options = folderOptions(rootId, nodes, excludeIds)
  return (
    <ul className="library-dest-list" aria-label={`Folders in ${collectionTitle}`}>
      <li>
        <button
          type="button"
          className="library-dest-item"
          data-testid="destination-option"
          disabled={busy || currentParentId === rootId}
          onClick={() => onPick({ collectionId, parentId: rootId, collectionTitle, parentTitle: null })}
        >
          <Icon name="folder" />
          Top level
          {currentParentId === rootId && <span className="library-dest-current">(current)</span>}
        </button>
      </li>
      {options.map((folder) => (
        <li key={folder.id} style={{ marginInlineStart: `${folder.depth * 0.85}rem` }}>
          <button
            type="button"
            className="library-dest-item"
            data-testid="destination-option"
            disabled={busy || currentParentId === folder.id}
            onClick={() => onPick({ collectionId, parentId: folder.id, collectionTitle, parentTitle: folder.title })}
          >
            <Icon name="folder" />
            {folder.title}
            {currentParentId === folder.id && <span className="library-dest-current">(current)</span>}
          </button>
        </li>
      ))}
    </ul>
  )
}

/**
 * Destination picker for bookmark Move / Copy, and a collection-only pick
 * for digest attach (R10-05).
 *
 * Move stays inside the current collection (the backend rejects cross
 * collection moves), so that collection is locked and only its folders are
 * offered. Copy lists owned ∪ shared-with-createNode collections; picking one
 * loads its tree on demand so a folder inside it can be chosen. Collection
 * mode lists owned collections and returns as soon as one is chosen — the
 * digest issue attaches the whole collection, not a folder.
 */
export function CollectionDestinationPicker({
  mode,
  current,
  owned = [],
  shared = [],
  count = 0,
  noun = 'bookmark',
  busy = false,
  currentParentId = null,
  movingIds,
  onPick,
  onClose,
}: Props) {
  const [target, setTarget] = useState<{ id: string; title: string } | null>(null)
  const [tree, setTree] = useState<TargetTree | null>(null)
  const loaderRef = useRef<AbortController | null>(null)

  const candidates = useMemo(() => {
    const seen = new Set<string>()
    const eligible: OwnedCollectionListItem[] = []
    const pool = mode === 'collection' ? owned : [...owned, ...shared]
    for (const item of pool) {
      if (mode !== 'collection' && !item.capabilities.createNode) continue
      if (seen.has(item.collection.id)) continue
      seen.add(item.collection.id)
      eligible.push(item)
    }
    return eligible
  }, [mode, owned, shared])

  useEffect(() => () => loaderRef.current?.abort(), [])

  const openTarget = (id: string, title: string) => {
    loaderRef.current?.abort()
    const controller = new AbortController()
    loaderRef.current = controller
    setTarget({ id, title })
    setTree({ status: 'loading' })
    void productClient.loadEditorSnapshot(id, { signal: controller.signal, maxRetries: 0 })
      .then((snapshot) => {
        if (controller.signal.aborted) return
        setTree({ status: 'ready', rootId: snapshot.root.id, nodes: snapshot.nodes })
      })
      .catch((err) => {
        if (controller.signal.aborted || isAbort(err)) return
        setTree({
          status: 'error',
          message: isProductApiError(err) ? err.recoveryHint : "Couldn't load this collection",
        })
      })
  }

  const title = mode === 'move' ? 'Move to…' : mode === 'copy' ? 'Copy to…' : 'Choose a collection'
  const excludeIds = mode === 'move' && current && movingIds && movingIds.length > 0
    ? movedSubtreeIds(current.nodes, movingIds)
    : undefined

  return (
    <Modal
      open
      onClose={onClose}
      label={title}
      title={title}
      size="sm"
      panelClassName="library-dest-panel"
    >
      <div data-testid="destination-picker" data-mode={mode}>
        {mode === 'move' && current ? (
          <>
            <p className="library-dest-note">
              Move {plural(count, noun)} within <strong>{current.collection.title}</strong>.
            </p>
            <FolderList
              collectionId={current.collection.id}
              collectionTitle={current.collection.title}
              rootId={current.rootId}
              nodes={current.nodes}
              busy={busy}
              currentParentId={currentParentId}
              excludeIds={excludeIds}
              onPick={onPick}
            />
          </>
        ) : target ? (
          <>
            <button
              type="button"
              className="library-dest-item library-dest-back"
              data-testid="destination-option"
              disabled={busy}
              onClick={() => {
                loaderRef.current?.abort()
                setTarget(null)
                setTree(null)
              }}
            >
              <Icon name="chevron-right" />
              All collections
            </button>
            <p className="library-dest-note">
              Copy {plural(count, 'bookmark')} into <strong>{target.title}</strong>. Copies the link,
              title and note. The icon, TL;DR and other annotations stay with the original.
            </p>
            {tree?.status === 'loading' && <LoadingState label="Loading folders…" />}
            {tree?.status === 'error' && (
              /* R9-31: an alert reads as a field error, not the muted note
                 styling the informational paragraphs above use. */
              <p className="field-error" role="alert">{tree.message}</p>
            )}
            {tree?.status === 'ready' && (
              <FolderList
                collectionId={target.id}
                collectionTitle={target.title}
                rootId={tree.rootId}
                nodes={tree.nodes}
                busy={busy}
                onPick={onPick}
              />
            )}
          </>
        ) : candidates.length === 0 ? (
          <EmptyState
            icon="folder"
            title={mode === 'collection' ? 'No collections' : 'No destination collections'}
            description={
              mode === 'collection'
                ? 'Create a collection you can publish as a digest issue.'
                : 'Create a collection you can copy bookmarks into.'
            }
            action={(
              <Link to="/library/new" className="btn btn-secondary btn-sm">
                New collection
              </Link>
            )}
          />
        ) : (
          <>
            <p className="library-dest-note">
              {mode === 'collection'
                ? "The collection's bookmarks become the issue's entries."
                : `Copy ${plural(count, 'bookmark')}. Copies the link, title and note. The icon, TL;DR and other annotations stay with the original.`}
            </p>
            <ul
              className="library-dest-list"
              aria-label={mode === 'collection' ? 'Your collections' : 'Destination collections'}
            >
              {candidates.map((item) => (
                <li key={item.collection.id}>
                  <button
                    type="button"
                    className="library-dest-item"
                    data-testid="destination-option"
                    disabled={busy}
                    onClick={() => {
                      if (mode === 'collection') {
                        onPick({
                          collectionId: item.collection.id,
                          parentId: item.collection.rootNodeId,
                          collectionTitle: item.collection.title,
                          parentTitle: null,
                        })
                        return
                      }
                      openTarget(item.collection.id, item.collection.title)
                    }}
                  >
                    <Icon name="folder" />
                    <span className="library-dest-label">{item.collection.title}</span>
                    {mode !== 'collection' ? <Icon name="chevron-right" /> : null}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Modal>
  )
}
