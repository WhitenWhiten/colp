import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { type PublicCollectionNode } from '../../api'
import { FolderEntries } from '../../components/FolderEntries'
import { Icon } from '../../components/Icon'
import { plural } from '../../lib/plural'
import {
  type PublicCollectionFolder,
  type PublicCollectionFolderEntry,
  type PublicFolderPreview,
  type PublicFolderTotals,
} from '../../lib/publicCollectionTree'
import { formatCompactCount, type ViewMode } from './format'
import { ResourceIcon } from './resources'

type OutlineItem = {
  folder: PublicCollectionFolder
  children: OutlineItem[]
}

/* The flattened walk is DFS, so a parent is always placed before its
   children; anything whose parent is not a listed folder is top level. */
function outlineTree(folders: readonly PublicCollectionFolder[]): OutlineItem[] {
  const byId = new Map<string, OutlineItem>()
  const roots: OutlineItem[] = []
  for (const folder of folders) {
    const item: OutlineItem = { folder, children: [] }
    byId.set(folder.node.id, item)
    const parent = folder.node.parentId ? byId.get(folder.node.parentId) : undefined
    if (parent) parent.children.push(item)
    else roots.push(item)
  }
  return roots
}

/* Outline disclosure lives in this child so expanding a folder row does not
   re-render the current layer's bookmark cards. A 12-level tree with a wide
   root used to retouch every card on each chevron click. The same tree is
   the ≥900px sidebar and, below it, the Contents sheet (`variant="sheet"`),
   where picking a row also closes the sheet (`onPick`). */
export function CollectionOutline({
  folders,
  totals,
  rootTitle,
  rootCount,
  activeFolderId,
  trail,
  openFolder,
  variant = 'sidebar',
  onPick,
}: {
  folders: PublicCollectionFolder[]
  totals: ReadonlyMap<string, PublicFolderTotals>
  /** The collection itself heads the tree: the way back to the top layer. */
  rootTitle: string
  rootCount: number
  activeFolderId: string | null
  trail: readonly PublicCollectionNode[]
  openFolder: (id: string | null) => void
  variant?: 'sidebar' | 'sheet'
  onPick?: () => void
}) {
  const [outlineOpen, setOutlineOpen] = useState<ReadonlySet<string>>(() => new Set<string>())

  useEffect(() => {
    if (!activeFolderId) return
    setOutlineOpen((current) => {
      const next = new Set(current)
      for (const node of trail) next.add(node.id)
      next.add(activeFolderId)
      return next.size === current.size ? current : next
    })
  }, [activeFolderId, trail])

  const toggleOutlineFolder = useCallback((id: string) => {
    setOutlineOpen((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const tree = useMemo(() => outlineTree(folders), [folders])
  const trailIds = useMemo(() => new Set(trail.map((node) => node.id)), [trail])

  if (folders.length === 0) return null

  /* The outline is a jump-anywhere shortcut over the drill-down: a row opens
     that layer. Picking the current row does nothing (the trail is how you
     go up), except closing the sheet it sits in. */
  const pick = (id: string | null) => {
    if (id !== activeFolderId) openFolder(id)
    onPick?.()
  }

  const renderItems = (items: readonly OutlineItem[]): ReactNode => items.map(({ folder, children }) => {
    const { node, depth } = folder
    const active = activeFolderId === node.id
    const onTrail = trailIds.has(node.id)
    const open = outlineOpen.has(node.id)
    return (
      <li key={node.id}>
        <div
          className="collection-outline-row"
          data-current={active || undefined}
          data-on-trail={onTrail || undefined}
        >
          {children.length > 0 ? (
            /* The chevron only discloses subfolders — it never navigates. */
            <button
              type="button"
              className="collection-outline-toggle"
              data-collection-folder-toggle
              aria-expanded={open}
              aria-label={open ? `Collapse ${node.title}` : `Expand ${node.title}`}
              onClick={() => toggleOutlineFolder(node.id)}
            >
              <Icon name="chevron-right" />
            </button>
          ) : (
            <span className="collection-outline-toggle" aria-hidden />
          )}
          <button
            type="button"
            className="collection-outline-link"
            data-collection-folder
            data-depth={depth}
            data-on-trail={onTrail || undefined}
            aria-current={active ? 'true' : undefined}
            title={node.title}
            onClick={() => pick(node.id)}
          >
            {node.title}
          </button>
          <span className="collection-outline-count" data-collection-outline-count>
            {formatCompactCount(totals.get(node.id)?.bookmarks ?? 0)}
          </span>
        </div>
        {children.length > 0 && open ? (
          <ul className="collection-outline-branch">{renderItems(children)}</ul>
        ) : null}
      </li>
    )
  })

  return (
    <nav
      className={variant === 'sheet' ? 'collection-outline collection-outline--sheet' : 'collection-outline'}
      aria-label="Collection folders"
    >
      {variant === 'sidebar' ? <h2 className="section-label collection-outline-head">Contents</h2> : null}
      <ul className="collection-outline-tree">
        <li>
          <div className="collection-outline-row collection-outline-row--root" data-current={activeFolderId ? undefined : true}>
            <span className="collection-outline-toggle" aria-hidden>
              <Icon name="collection" />
            </span>
            <button
              type="button"
              className="collection-outline-link"
              data-collection-outline-root
              aria-current={activeFolderId ? undefined : 'true'}
              title={rootTitle}
              onClick={() => pick(null)}
            >
              {rootTitle}
            </button>
            <span className="collection-outline-count" data-collection-outline-count>{formatCompactCount(rootCount)}</span>
          </div>
        </li>
        {renderItems(tree)}
      </ul>
    </nav>
  )
}

/* A labelled group of the current layer — "Folders" over the folder cards,
   "Bookmarks" over the stream — so the two kinds read as two lists instead
   of one run of mismatched cards. */
export function CollectionSection({ label, count, children }: {
  label: string
  /** Omitted while a paged (time-sorted) layer still has pages to load. */
  count?: number | null
  children: ReactNode
}) {
  return (
    <section className="collection-section">
      <h2 className="section-label collection-section-head">
        {label}
        {count != null ? <>{' '}<span className="collection-section-count">{count}</span></> : null}
      </h2>
      {children}
    </section>
  )
}

/* One layer of subfolders (shared FolderEntries chrome); folder links keep
   the current view and q via searchFor. Every card counts the bookmarks
   filed anywhere below it. When the folders are the whole layer, or a few
   sit beside bookmarks, the page passes `previews` and the board cards open
   up: description, the first bookmarks inside, and a remainder line — so
   folders read as contents, not as slim tabs over an empty board. */
export function CollectionFolderLayer({ folders, view, searchFor, previews, totals, faviconCdnAllowed = false }: {
  folders: PublicCollectionFolderEntry[]
  view: ViewMode
  searchFor: (folderId: string | null) => string
  previews?: ReadonlyMap<string, PublicFolderPreview> | null
  totals: ReadonlyMap<string, PublicFolderTotals>
  faviconCdnAllowed?: boolean
}) {
  if (view === 'gallery') {
    return (
      <FolderEntries
        view="gallery"
        countNoun="bookmark"
        items={folders.map(({ node }) => {
          const preview = previews?.get(node.id)
          return {
            id: node.id,
            title: node.title,
            directCount: totals.get(node.id)?.bookmarks ?? null,
            to: { search: searchFor(node.id) },
            description: node.description,
            folderCount: preview?.folderCount ?? null,
            covers: preview?.covers,
          }
        })}
      />
    )
  }
  const rich = view === 'board' && previews != null
  return (
    <FolderEntries
      view={view}
      className={rich ? 'collection-folder-board--rich' : undefined}
      countNoun="bookmark"
      items={folders.map(({ node }) => {
        const preview = rich ? previews.get(node.id) : undefined
        return {
          id: node.id,
          title: node.title,
          // Sorted layers can list a folder the snapshot does not know yet:
          // no total, no count (never a guess).
          directCount: totals.get(node.id)?.bookmarks ?? null,
          to: { search: searchFor(node.id) },
          detail: preview ? (
            <FolderPeek description={node.description} preview={preview} faviconCdnAllowed={faviconCdnAllowed} />
          ) : undefined,
        }
      })}
    />
  )
}

function FolderPeek({ description, preview, faviconCdnAllowed }: {
  description: string | null
  preview: PublicFolderPreview
  faviconCdnAllowed: boolean
}) {
  const remaining = preview.bookmarkCount - preview.sample.length
  return (
    <span className="collection-folder-detail">
      {description ? <span className="collection-folder-desc">{description}</span> : null}
      {preview.sample.length > 0 ? (
        <span className="collection-folder-peek">
          {preview.sample.map((resource) => (
            <span key={resource.node.id} className="collection-folder-peek-item">
              <span className="collection-folder-peek-icon" aria-hidden>
                <ResourceIcon resource={resource} faviconCdnAllowed={faviconCdnAllowed} />
              </span>
              <span className="collection-folder-peek-title" data-collection-folder-peek>{resource.node.title}</span>
            </span>
          ))}
        </span>
      ) : (
        <span className="collection-folder-peek-empty">
          {preview.folderCount > 0 ? plural(preview.folderCount, 'subfolder') : 'No bookmarks yet'}
        </span>
      )}
      {remaining > 0 || (preview.sample.length > 0 && preview.folderCount > 0) ? (
        <span className="collection-folder-peek-more">
          {[
            remaining > 0 ? `+${plural(remaining, 'more bookmark', 'more bookmarks')}` : null,
            preview.sample.length > 0 && preview.folderCount > 0 ? plural(preview.folderCount, 'subfolder') : null,
          ].filter(Boolean).join(' · ')}
        </span>
      ) : null}
    </span>
  )
}
