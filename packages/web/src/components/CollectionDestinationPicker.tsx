import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  isProductApiError,
  productClient,
  type EditableNodeView,
  type LibraryCollection,
  type OwnedCollectionListItem,
} from '../api'
import { isBrowserFolderRole } from '../generated/browser-folder-roles'
import { childrenOf, isAbort, rootTitle } from '../lib/libraryTree'
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
  | { status: 'ready'; rootId: string; nodes: EditableNodeView[]; library: boolean }
  | { status: 'error'; message: string }

type Props = {
  mode: 'move' | 'copy'
  /** Move mode: the current collection is locked as the only destination. */
  current?: {
    collection: { id: string; title: string; library?: boolean }
    rootId: string
    nodes: EditableNodeView[]
  }
  /** The account’s one library is the owned destination. */
  library?: LibraryCollection
  /** Copy mode: shared collections; only capabilities.createNode may receive. */
  shared?: OwnedCollectionListItem[]
  /** Number of bookmarks the action applies to. */
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
  library = false,
): FolderOption[] {
  const options: FolderOption[] = []
  const visit = (parentId: string, depth: number, lineage: ReadonlySet<string>) => {
    for (const node of childrenOf(parentId, nodes)) {
      if (node.kind !== 'folder' || lineage.has(node.id) || exclude?.has(node.id)) continue
      if (library && parentId === rootId && !isBrowserFolderRole(node.folderRole)) continue
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
  library = false,
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
  library?: boolean
  excludeIds?: ReadonlySet<string>
  onPick: (destination: DestinationPick) => void
}) {
  const options = folderOptions(rootId, nodes, excludeIds, library)
  return (
    <ul className="library-dest-list" aria-label={`Folders in ${collectionTitle}`}>
      {!library && <li>
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
      </li>}
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
 * Destination picker for bookmark Move / Copy.
 *
 * Move stays inside the current collection (the backend rejects cross
 * collection moves), so that collection is locked and only its folders are
 * offered. Copy lists owned ∪ shared-with-createNode collections; picking one
 * loads its tree on demand so a folder inside it can be chosen.
 */
export function CollectionDestinationPicker({
  mode,
  current,
  library,
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
    const eligible: { collection: { id: string; title: string; library?: boolean } }[] = library ? [{ collection: library }] : []
    if (library) seen.add(library.id)
    for (const item of shared) {
      if (!item.capabilities.createNode || seen.has(item.collection.id)) continue
      seen.add(item.collection.id)
      eligible.push(item)
    }
    return eligible
  }, [library, shared])

  useEffect(() => () => loaderRef.current?.abort(), [])

  const openTarget = useCallback((id: string, title: string) => {
    loaderRef.current?.abort()
    const controller = new AbortController()
    loaderRef.current = controller
    setTarget({ id, title })
    setTree({ status: 'loading' })
    void productClient.loadEditorSnapshot(id, { signal: controller.signal, maxRetries: 0 })
      .then((snapshot) => {
        if (controller.signal.aborted) return
        setTree({ status: 'ready', rootId: snapshot.root.id, nodes: snapshot.nodes, library: snapshot.collection.library === true })
      })
      .catch((err) => {
        if (controller.signal.aborted || isAbort(err)) return
        setTree({
          status: 'error',
          message: isProductApiError(err) ? err.recoveryHint : "Couldn't load this collection",
        })
      })
  }, [])

  /* Copying into the library alone (no shared collection takes copies)
     skips a one-row Destinations list and opens its folders directly. */
  const sole = mode === 'copy' && candidates.length === 1 ? candidates[0]!.collection : null
  const soleId = sole?.id ?? null
  const soleTitle = sole ? rootTitle(sole) : ''
  useEffect(() => {
    if (soleId) openTarget(soleId, soleTitle)
  }, [openTarget, soleId, soleTitle])

  const title = mode === 'move' ? 'Move to…' : 'Copy to…'
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
              {current.collection.library
                ? <>Move {plural(count, noun)} to another folder.</>
                : <>Move {plural(count, noun)} within <strong>{current.collection.title}</strong>.</>}
            </p>
            <FolderList
              collectionId={current.collection.id}
              collectionTitle={rootTitle(current.collection)}
              library={current.collection.library}
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
            {!sole && <button
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
              Destinations
            </button>}
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
                library={tree.library}
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
            title="Your library is unavailable"
            description="Close this dialog and reload your library, then try again."
          />
        ) : (
          <>
            <p className="library-dest-note">
              Copy {plural(count, 'bookmark')}. Copies the link, title and note. The icon, TL;DR and other annotations stay with the original.
            </p>
            <ul
              className="library-dest-list"
              aria-label="Destinations"
            >
              {candidates.map((item) => (
                <li key={item.collection.id}>
                  <button
                    type="button"
                    className="library-dest-item"
                    data-testid="destination-option"
                    disabled={busy}
                    onClick={() => openTarget(item.collection.id, rootTitle(item.collection))}
                  >
                    <Icon name="folder" />
                    <span className="library-dest-label">{rootTitle(item.collection)}</span>
                    <Icon name="chevron-right" />
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
