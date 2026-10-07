import { Fragment, useState, type ReactNode } from 'react'
import { Link, type To } from 'react-router-dom'
import { Icon } from './Icon'
import type { PreviewCover } from '../lib/linkPreview'
import { plural, pluralNoun } from '../lib/plural'
import { useGalleryMasonry } from '../lib/useGalleryMasonry'

export type FolderEntryItem = {
  id: string
  title: string
  /** Direct children (subfolders + bookmarks). Null when the count is unknown. */
  directCount: number | null
  to: To
  /** Board-only card body under the head (the public page's folder peek).
      Must not contain links — the whole card is one. */
  detail?: ReactNode
  /** Gallery-only: the folder's own description. */
  description?: string | null
  /** Gallery-only: direct subfolders. Null or omitted when unknown. */
  folderCount?: number | null
  /** Gallery-only: up to four bookmark covers from inside the folder. */
  covers?: readonly PreviewCover[]
}

type FolderView = 'board' | 'gallery' | 'list' | 'compact'

/**
 * One layer of subfolders, shared by the public collection page and the
 * library desk so both express hierarchy with the same language. Board mode
 * renders cards; list/compact render row links; gallery renders the
 * collection card (Explore's anatomy) on the bookmark gallery's masonry.
 * Folders navigate within the page instead of opening an external
 * resource — deliberately not ResourceList items.
 */
export function FolderEntries({ items, view, className, countNoun = 'item', renderActions }: {
  items: FolderEntryItem[]
  view: FolderView
  className?: string
  /** Count noun — the desk says "bookmarks" like its sidebar. */
  countNoun?: 'item' | 'bookmark'
  /**
   * Desk-only trailing row actions. Public collection pages pass nothing, so
   * their folder rows stay pure links.
   */
  renderActions?: (item: FolderEntryItem) => ReactNode
}) {
  const masonry = useGalleryMasonry()
  if (items.length === 0) return null
  if (view === 'gallery') {
    return (
      <div
        ref={masonry}
        className={className ? `gallery-board folder-gallery-board ${className}` : 'gallery-board folder-gallery-board'}
        data-collection-folder-layer
      >
        {items.map((item) => (
          <FolderGalleryCard key={item.id} item={item} countNoun={countNoun} actions={renderActions?.(item)} />
        ))}
      </div>
    )
  }
  const board = view === 'board'
  const shellClass = board
    ? 'collection-folder-board'
    : `collection-folder-rows${view === 'compact' ? ' collection-folder-rows--compact' : ''}`
  return (
    <div
      className={className ? `${shellClass} ${className}` : shellClass}
      data-collection-folder-layer
    >
      {items.map((item) => {
        const row = (
          <Link
            className={board ? 'collection-folder-card' : 'collection-folder-row'}
            to={item.to}
            data-collection-subfolder
            data-folder-id={item.id}
          >
            <span className="collection-folder-icon" aria-hidden><Icon name="folder" /></span>
            <span className="collection-folder-name">{item.title}</span>
            {item.directCount != null && (
              <span className="collection-folder-count">{plural(item.directCount, countNoun)}</span>
            )}
            {!board && (
              <span className="collection-folder-chevron" aria-hidden><Icon name="chevron-right" /></span>
            )}
            {board && item.detail}
          </Link>
        )
        const actions = renderActions?.(item)
        if (!actions) return <Fragment key={item.id}>{row}</Fragment>
        return (
          <div key={item.id} className="library-folder-row" data-folder-actions>
            {row}
            {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- event boundary only: keeps action-button clicks off the row link; the children are native buttons */}
            <div
              className="library-bookmark-actions"
              onClick={(event) => event.stopPropagation()}
            >
              {actions}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/**
 * Gallery folder card: the bookmark gallery card's surface with the
 * collection card's body (mark, title, description, stats, "Open folder"
 * foot), led by a mosaic of the covers filed inside. The title link
 * stretches over the card so the trailing actions stay real buttons
 * outside it.
 */
function FolderGalleryCard({ item, countNoun, actions }: {
  item: FolderEntryItem
  countNoun: 'item' | 'bookmark'
  actions?: ReactNode
}) {
  const stats: ReactNode[] = []
  if (item.directCount != null) {
    stats.push(<><strong>{item.directCount}</strong> {pluralNoun(item.directCount, countNoun)}</>)
  }
  if (item.folderCount) {
    stats.push(<><strong>{item.folderCount}</strong> {pluralNoun(item.folderCount, 'subfolder')}</>)
  }
  return (
    <article className="result-card gallery-card folder-gallery-card" data-gallery-card data-folder-id={item.id}>
      {item.covers && item.covers.length > 0 ? <FolderCoverMosaic covers={item.covers} /> : null}
      <div className="collection-card-body">
        <div className="collection-card-kicker">
          <span className="collection-card-mark" aria-hidden><Icon name="folder" /></span>
          {actions ? (
            // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- event boundary only: keeps action-button clicks off the card link; the children are native buttons
            <div className="folder-gallery-actions" onClick={(event) => event.stopPropagation()}>
              {actions}
            </div>
          ) : null}
        </div>
        <h3 className="collection-card-title" title={item.title} dir="auto">
          <Link
            className="folder-gallery-link"
            to={item.to}
            data-collection-subfolder
            data-folder-id={item.id}
          >
            {item.title}
          </Link>
        </h3>
        {item.description ? (
          <p className="collection-card-desc" data-testid="folder-card-desc" dir="auto">{item.description}</p>
        ) : null}
        {stats.length > 0 && (
          <p className="collection-card-stats" data-testid="folder-card-stats">
            {stats.map((node, i) => (
              <span key={i} className="collection-card-stat">
                {i > 0 ? <span className="dot-sep" aria-hidden /> : null}
                {node}
              </span>
            ))}
          </p>
        )}
        <div className="collection-card-foot">
          <span className="collection-card-open">Open folder</span>
          <span className="collection-card-arrow" aria-hidden><Icon name="arrow-right" /></span>
        </div>
      </div>
    </article>
  )
}

/** Up to four covers on one fixed-ratio tile; a failed image drops out of the mosaic. */
function FolderCoverMosaic({ covers }: { covers: readonly PreviewCover[] }) {
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set())
  const shown = covers.filter((cover) => !failed.has(cover.url)).slice(0, 4)
  if (shown.length === 0) return null
  return (
    <div className="folder-gallery-cover" data-count={shown.length} data-gallery-cover aria-hidden>
      {shown.map((cover) => (
        <img
          key={cover.url}
          src={cover.url}
          width={cover.width}
          height={cover.height}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          draggable={false}
          onError={() => setFailed((prev) => new Set(prev).add(cover.url))}
        />
      ))}
    </div>
  )
}
