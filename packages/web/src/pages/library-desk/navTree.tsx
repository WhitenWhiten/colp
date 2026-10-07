import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { EditorSnapshot } from '../../api'
import { Collapse } from '../../components/Collapse'
import { LoadingState } from '../../components/EmptyState'
import { Icon, LibraryNavMark as LibraryNavGlyph } from '../../components/Icon'
import {
  childFolders,
  flattenBookmarks,
  folderTrail,
  type FolderNode,
} from '../../lib/libraryTree'
import { plural, pluralNoun } from '../../lib/plural'
import type { TreeEntry } from './data'

export function LibraryNavMark() {
  return (
    <span className="library-nav-mark" aria-hidden>
      <LibraryNavGlyph />
    </span>
  )
}

export function LibraryNavSection({
  sectionId,
  title,
  collapsed,
  onToggle,
  reordering = false,
  canReorder = false,
  onBeginReorder,
  onFinishReorder,
  children,
}: {
  sectionId: string
  title: string
  collapsed: boolean
  onToggle: () => void
  /** True while this section's collections are being reordered. */
  reordering?: boolean
  canReorder?: boolean
  onBeginReorder?: () => void
  onFinishReorder?: () => void
  children: ReactNode
}) {
  const bodyId = `library-nav-section-${sectionId}`
  return (
    <section
      className={reordering ? 'library-nav-section is-reorder-active' : 'library-nav-section'}
      data-testid={`library-nav-${sectionId}`}
    >
      <h2 className="library-nav-section-head">
        <button
          type="button"
          className="library-nav-section-toggle"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          aria-disabled={reordering || undefined}
          onClick={reordering ? undefined : onToggle}
        >
          <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} />
          <span>{title}</span>
        </button>
        {reordering && onFinishReorder ? (
          <button
            type="button"
            className="chip chip--rail library-nav-section-action"
            data-testid={`library-nav-${sectionId}-done`}
            onClick={onFinishReorder}
          >
            Done
          </button>
        ) : canReorder && onBeginReorder ? (
          <button
            type="button"
            className="chip chip--rail library-nav-section-action library-nav-section-action--icon"
            data-testid={`library-nav-${sectionId}-reorder`}
            aria-label={`Reorder ${title}`}
            title="Reorder"
            onClick={onBeginReorder}
          >
            <Icon name="reorder" />
          </button>
        ) : null}
      </h2>
      <Collapse open={!collapsed} id={bodyId} className="library-nav-section-body">
        {children}
      </Collapse>
    </section>
  )
}

/**
 * A followed collection whose target can no longer be opened (soft-deleted,
 * made private, or the owner is inactive). The row stays visible so the
 * follower knows what happened, but it never navigates anywhere.
 */
export function FollowedUnavailableRow({ title }: { title: string }) {
  return (
    <div className="library-nav-group" data-testid="library-nav-following-unavailable">
      <div className="library-nav-row library-nav-row--unavailable" aria-disabled="true">
        <span className="library-nav-icon" aria-hidden>
          <Icon name="folder" />
        </span>
        <span className="library-nav-label" title={title}>{title}</span>
        <span className="library-nav-flag">Unavailable</span>
      </div>
    </div>
  )
}

export function CollectionBranch({
  collection,
  bookmarkCount,
  linkTo,
  folderLinkTo,
  selectedId,
  folderId,
  expanded,
  tree,
  onToggle,
  onSelect,
  selectValue,
  listItem = false,
}: {
  /** Owned/shared rows pass the collection view; followed rows pass id+title. */
  collection: { id: string; title: string }
  bookmarkCount?: number
  linkTo?: string
  folderLinkTo?: (folderId: string) => string
  selectedId: string | null
  folderId: string | null
  expanded: boolean
  tree?: TreeEntry
  onToggle: () => void
  /** Picker sheets intercept navigation and keep the {collection}::{folder} contract. */
  onSelect?: (value: string) => void
  selectValue?: (folderId: string | null) => string
  /** Render as a list item itself (the mobile sheet); inside the reorder
      list the wrapper carries that role instead. */
  listItem?: boolean
}) {
  const snap = tree?.snap
  const folders = snap ? childFolders(snap.root.id, snap.nodes) : []
  const bookmarkTotal = snap
    ? flattenBookmarks(snap.root, snap.nodes).length
    : typeof bookmarkCount === 'number'
      ? bookmarkCount
      : null
  const selected = collection.id === selectedId && (!folderId || !expanded)
  const open = expanded && (folders.length > 0 || tree?.status === 'loading' || tree?.status === 'error')
  const rowTo = linkTo ?? `/library/${encodeURIComponent(collection.id)}`
  const folderTo = folderLinkTo
    ?? ((folder: string) => `/library/${encodeURIComponent(collection.id)}?folder=${encodeURIComponent(folder)}`)
  const valueOf = (id: string | null) =>
    selectValue ? selectValue(id) : id ? `${collection.id}::${id}` : collection.id

  /* Nested folder disclosure. The chain to the folder the visitor stands in
     opens automatically; manual toggles stay sticky while the branch lives. */
  const currentFolderId = collection.id === selectedId ? folderId : null
  const [openFolders, setOpenFolders] = useState<ReadonlySet<string>>(() => new Set<string>())

  useEffect(() => {
    if (!currentFolderId || !snap) return
    setOpenFolders((current) => {
      const next = new Set(current)
      for (const node of folderTrail(snap.root, snap.nodes, currentFolderId)) next.add(node.id)
      next.add(currentFolderId)
      return next.size === current.size ? current : next
    })
  }, [currentFolderId, snap])

  const toggleFolder = (id: string) => {
    setOpenFolders((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    // R15-44: the list item role comes from the container (the reorder list
    // wrapper or the mobile sheet); disclosure lives on the toggle button.
    <div className="library-nav-group" role={listItem ? 'listitem' : undefined}>
      <div className={selected ? 'library-nav-row is-current' : 'library-nav-row'}>
        <button
          type="button"
          className="library-nav-toggle"
          aria-expanded={open}
          aria-label={open ? `Collapse ${collection.title}` : `Expand ${collection.title}`}
          onClick={onToggle}
        >
          <Icon name={open ? 'chevron-down' : 'chevron-right'} />
        </button>
        {onSelect ? (
          <button
            type="button"
            className="library-nav-link"
            data-collection-id={collection.id}
            aria-current={selected ? 'page' : undefined}
            onClick={() => onSelect(valueOf(null))}
          >
            <NavRowMarks title={collection.title} count={bookmarkTotal} container="collection" />
          </button>
        ) : (
          <Link
            className="library-nav-link"
            to={rowTo}
            data-collection-id={collection.id}
            aria-current={selected ? 'page' : undefined}
          >
            <NavRowMarks title={collection.title} count={bookmarkTotal} container="collection" />
          </Link>
        )}
      </div>
      <Collapse open={open} className="library-nav-children" role="list">
        {tree?.status === 'loading' && folders.length === 0 && (
          <LoadingState label="Loading folders…" />
        )}
        {tree?.status === 'error' && folders.length === 0 && (
          <p className="library-nav-hint">{tree.message ?? "Couldn't load folders"}</p>
        )}
        {snap && folders.map((folder) => (
          <FolderBranch
            key={folder.id}
            folder={folder}
            snap={snap}
            folderTo={folderTo}
            currentFolderId={currentFolderId}
            openFolders={openFolders}
            onToggleFolder={toggleFolder}
            onPick={onSelect ? (id) => onSelect(valueOf(id)) : undefined}
          />
        ))}
      </Collapse>
    </div>
  )
}

/** A folder row plus its recursively nested subfolders — the sidebar shows
    the whole hierarchy, not just the first level. */
function FolderBranch({
  folder,
  snap,
  folderTo,
  currentFolderId,
  openFolders,
  onToggleFolder,
  onPick,
}: {
  folder: FolderNode
  snap: EditorSnapshot
  folderTo: (folderId: string) => string
  currentFolderId: string | null
  openFolders: ReadonlySet<string>
  onToggleFolder: (id: string) => void
  onPick?: (folderId: string) => void
}) {
  const children = childFolders(folder.id, snap.nodes)
  const open = children.length > 0 && openFolders.has(folder.id)
  const current = currentFolderId === folder.id
  return (
    <div className="library-nav-group" role="listitem">
      <div className="library-nav-branch">
        {children.length > 0 ? (
          <button
            type="button"
            className="library-nav-toggle"
            aria-expanded={open}
            aria-label={open ? `Collapse ${folder.title}` : `Expand ${folder.title}`}
            onClick={() => onToggleFolder(folder.id)}
          >
            <Icon name={open ? 'chevron-down' : 'chevron-right'} />
          </button>
        ) : (
          <span className="library-nav-toggle library-nav-toggle--void" aria-hidden />
        )}
        <FolderLink
          folder={folder}
          to={folderTo(folder.id)}
          current={current}
          count={flattenBookmarks(snap.root, snap.nodes, folder.id).length}
          onPick={onPick ? () => onPick(folder.id) : undefined}
        />
      </div>
      <Collapse open={open} className="library-nav-children" role="list">
        {children.map((child) => (
          <FolderBranch
            key={child.id}
            folder={child}
            snap={snap}
            folderTo={folderTo}
            currentFolderId={currentFolderId}
            openFolders={openFolders}
            onToggleFolder={onToggleFolder}
            onPick={onPick}
          />
        ))}
      </Collapse>
    </div>
  )
}

function NavRowMarks({ title, count, container }: {
  title: string
  count: number | null
  container: 'collection' | 'folder'
}) {
  return (
    <>
      <span className="library-nav-icon" aria-hidden>
        <Icon name="folder" />
      </span>
      <span className="library-nav-label" title={title}>{title}</span>
      {count != null && (
        <span className="library-nav-count" title={`${plural(count, 'bookmark')} in this ${container}`}>
          {count}
          <span className="visually-hidden"> {pluralNoun(count, 'bookmark')}</span>
        </span>
      )}
    </>
  )
}

function FolderLink({
  folder,
  to,
  current,
  count,
  onPick,
}: {
  folder: FolderNode
  to: string
  current: boolean
  count: number | null
  onPick?: () => void
}) {
  const className = current
    ? 'library-nav-row library-nav-row--child is-current'
    : 'library-nav-row library-nav-row--child'
  if (onPick) {
    return (
      <button
        type="button"
        className={className}
        data-folder-id={folder.id}
        aria-current={current ? 'page' : undefined}
        onClick={onPick}
      >
        <NavRowMarks title={folder.title} count={count} container="folder" />
      </button>
    )
  }
  return (
    <Link
      className={className}
      to={to}
      data-folder-id={folder.id}
      aria-current={current ? 'page' : undefined}
    >
      <NavRowMarks title={folder.title} count={count} container="folder" />
    </Link>
  )
}
