import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { Link } from 'react-router-dom'
import { MeasuredList } from './MeasuredList'
import { VirtualList } from './VirtualList'
import { ResourceSnippet } from './ResourceSnippet'
import type { AnnotationSnippet } from '../lib/useBookmarkAnnotations'
import type { PreviewCover } from '../lib/linkPreview'
import { useGalleryMasonry } from '../lib/useGalleryMasonry'
import { UGC_REL } from '../lib/ugcRel'
import { useIsClamped } from '../lib/useIsClamped'
import { Icon } from './Icon'

export type ResourceListMode = 'list' | 'compact' | 'board' | 'gallery'

/** Compact rows are one register (R6-07 / library-rows contract: 46px). */
export const COMPACT_ROW_HEIGHT_PX = 46
/** Starting estimate for a comfort row, replaced by its measured height. */
export const COMFORT_ROW_ESTIMATE_PX = 72
/** Below this count, mount every row so short lists stay in normal document flow. */
export const RESOURCE_LIST_VIRTUALIZE_AFTER = 50

/** Touch long-press threshold before a row enters selection mode. */
export const ROW_LONG_PRESS_MS = 450
/** Finger drift beyond this cancels the long-press (it is a scroll). */
const LONG_PRESS_SLOP_PX = 8

export type ResourceListItem = {
  id: string
  title: string
  host: string
  /** Folder (library) or path (public collection). */
  mid?: string
  date?: string
  dateTime?: string
  description?: string | null
  /** Annotation-backed snippets, comfort rows only (Library desk). */
  tldr?: AnnotationSnippet | string
  note?: AnnotationSnippet | string
  mark: ReactNode
  depth?: number
  kind?: string
  href?: string | null
  to?: string
  /** Title link is the in-app resource detail (/r/:id) — the public slug
      rides along so guests resolve from the public snapshot. */
  detailLink?: boolean
  /** Full bookmark details, used by annotation snippets and row actions. */
  detailTo?: string
  onOpen?: () => void
  unavailable?: boolean
  /** Moderation-hidden tombstone (public collection): inert row, no links. */
  hidden?: boolean
  /** Public collection resource anchors. */
  resourceLink?: boolean
  /** LP-06 Gallery cover: a validated same-origin preview image, or none. */
  cover?: PreviewCover | null
  /** The owner pinned it in the browser extension: a quiet mark before the host. */
  pinned?: boolean
  /** Bookmark tags, shown under the title on comfort rows. */
  tags?: readonly string[]
  /** Makes each tag a button (outside the row link) that filters by it. */
  onTag?: (tag: string) => void
  isTagActive?: (tag: string) => boolean
  /** Optional trailing slot inside the row link (e.g. the Library go arrow). */
  trailing?: ReactNode
  /** Optional actions slot rendered outside the row link (never navigates). */
  actions?: ReactNode
  /** Selection mode: leading checkbox outside the link; row click toggles. */
  selectable?: boolean
  selected?: boolean
  onToggleSelect?: () => void
  /** Touch-only long-press on the row (e.g. enter selection mode). */
  onLongPress?: () => void
  /** Desktop drag-to-move handle (Library desk); inert when absent. */
  onDragPointerDown?: (event: ReactPointerEvent) => void
}

function normalizeSnippet(value: AnnotationSnippet | string | undefined): AnnotationSnippet | undefined {
  return typeof value === 'string' ? { text: value, format: 'plain' } : value
}

type Props = {
  items: ResourceListItem[]
  mode: ResourceListMode
  streamRef?: (node: HTMLDivElement | null) => void
  /** When set, wrap with the public collection stream chrome. */
  collectionView?: ResourceListMode
  testId?: string
}

/**
 * Product bookmark row (Library compact language) plus the public board
 * card: `mode="board"` renders the shared .result-card anatomy in a
 * .result-board grid (R10-01).
 * Slots: rows read mark → title → mid → host; board cards lead with a
 * mark + host rail, then title, description and an optional path strip.
 * Explore CollectionCard is `.result-card--collection` (raised discovery) —
 * do not reuse this row there.
 */
export function ResourceList({ items, mode, streamRef, collectionView, testId }: Props) {
  if (mode === 'gallery') {
    const gallery = <GalleryBoard items={items} collection={Boolean(collectionView)} testId={testId} />
    if (!collectionView) return gallery
    return (
      <div
        ref={streamRef}
        className="resource-stream"
        data-collection-view={collectionView}
        data-collection-resources
      >
        <div className="resource-stream-inner">{gallery}</div>
      </div>
    )
  }
  if (mode === 'board') {
    const board = (
      <div
        className="result-board"
        data-testid={testId}
        role="list"
      >
        {items.map((item) => (
          <ResultCard key={item.id} item={item} collection={Boolean(collectionView)} />
        ))}
      </div>
    )
    if (!collectionView) return board
    return (
      <div
        ref={streamRef}
        className="resource-stream"
        data-collection-view={collectionView}
        data-collection-resources
      >
        <div className="resource-stream-inner">{board}</div>
      </div>
    )
  }

  const compact = mode === 'compact'
  const virtualize = compact && items.length >= RESOURCE_LIST_VIRTUALIZE_AFTER
  /* List mode windows too. It used to mount every row, measured at ~16 elements
     per row (2_000 rows -> 32_079 elements), while the fetch path permits 100_000.
     Comfort rows are auto-height, so they need the measured window, not the
     fixed-height one. */
  const measureList = !compact && mode === 'list' && items.length >= RESOURCE_LIST_VIRTUALIZE_AFTER
  const listClass = compact
    ? 'library-bookmark-list library-bookmark-list--compact'
    : 'library-bookmark-list library-bookmark-list--comfort'
  const list = measureList ? (
    <MeasuredList
      items={items}
      estimatedItemHeight={COMFORT_ROW_ESTIMATE_PX}
      overscan={8}
      className={listClass}
      testId={testId}
      itemRole="presentation"
      renderItem={(item) => (
        <ResourceRow item={item} mode={mode} collection={Boolean(collectionView)} />
      )}
    />
  ) : virtualize ? (
    <VirtualList
      items={items}
      itemHeight={COMPACT_ROW_HEIGHT_PX}
      overscan={8}
      className={listClass}
      density="compact"
      testId={testId}
      itemRole="presentation"
      renderItem={(item) => (
        <ResourceRow item={item} mode={mode} collection={Boolean(collectionView)} />
      )}
    />
  ) : (
    <div
      className={listClass}
      data-density={compact ? 'compact' : 'comfortable'}
      data-testid={testId}
      role="list"
    >
      {items.map((item) => (
        <ResourceRow key={item.id} item={item} mode={mode} collection={Boolean(collectionView)} />
      ))}
    </div>
  )

  if (!collectionView) return list

  return (
    <div
      ref={streamRef}
      className="resource-stream"
      data-collection-view={collectionView}
      data-collection-resources
    >
      <div className="resource-stream-inner">{list}</div>
    </div>
  )
}

type RowPressHandlers = {
  onPointerDown?: (event: ReactPointerEvent) => void
  onPointerMove?: (event: ReactPointerEvent) => void
  onPointerUp?: () => void
  onPointerCancel?: () => void
  onClickCapture?: (event: ReactMouseEvent) => void
}

/**
 * Touch-only long-press detector for a bookmark row. Deliberately independent
 * from ReorderableNavList's press state: rows and nav entries must never share
 * a selection/reorder lifecycle.
 */
function useRowLongPress(onLongPress: (() => void) | undefined): RowPressHandlers {
  const timerRef = useRef<number | null>(null)
  const originRef = useRef<{ x: number; y: number } | null>(null)
  const firedRef = useRef(false)

  const clear = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    originRef.current = null
  }

  useEffect(() => clear, [])

  if (!onLongPress) return {}

  return {
    onPointerDown: (event: ReactPointerEvent) => {
      if (event.pointerType !== 'touch') return
      firedRef.current = false
      originRef.current = { x: event.clientX, y: event.clientY }
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        firedRef.current = true
        onLongPress()
      }, ROW_LONG_PRESS_MS)
    },
    onPointerMove: (event: ReactPointerEvent) => {
      const origin = originRef.current
      if (!origin) return
      if (
        Math.abs(event.clientX - origin.x) > LONG_PRESS_SLOP_PX
        || Math.abs(event.clientY - origin.y) > LONG_PRESS_SLOP_PX
      ) clear()
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    onClickCapture: (event: ReactMouseEvent) => {
      if (!firedRef.current) return
      firedRef.current = false
      event.preventDefault()
      event.stopPropagation()
    },
  }
}

function ResourceRow({
  item,
  mode,
  collection,
}: {
  item: ResourceListItem
  mode: ResourceListMode
  collection: boolean
}) {
  const compact = mode === 'compact'
  /* .result-row is the shared row atom (grid / hairline / hover wash,
     cards-ui.css); .library-bookmark--* only set the density register. */
  const baseClassName = compact
    ? 'result-row library-bookmark library-bookmark--compact'
    : 'result-row library-bookmark library-bookmark--comfort'
  const className = [
    baseClassName,
    item.selected ? 'is-selected' : '',
    item.hidden ? 'library-bookmark--hidden' : '',
  ].filter(Boolean).join(' ')
  const longPressHandlers = useRowLongPress(item.onLongPress)
  const [titleRef, titleClamped] = useIsClamped<HTMLHeadingElement>(item.title)
  // Touch long-press and mouse drag never overlap (each checks pointerType),
  // so the merged handler simply forwards to both.
  const onPointerDown = longPressHandlers.onPointerDown || item.onDragPointerDown
    ? (event: ReactPointerEvent) => {
        longPressHandlers.onPointerDown?.(event)
        item.onDragPointerDown?.(event)
      }
    : undefined
  const mark = compact ? <span className="compact-icon">{item.mark}</span> : item.mark
  const tldr = normalizeSnippet(item.tldr)
  const note = normalizeSnippet(item.note)
  const tags = !compact && item.tags && item.tags.length > 0 ? item.tags : null
  const onTag = item.onTag
  const tagStrip = tags ? (
    <p className="library-bookmark-tags" data-testid="bookmark-tags">
      {tags.map((tag) => onTag ? (
        <button
          key={tag}
          type="button"
          className="library-bookmark-tag"
          aria-pressed={item.isTagActive?.(tag) ?? false}
          aria-label={`Filter by tag ${tag}`}
          onClick={(event) => { event.stopPropagation(); onTag(tag) }}
        >
          {tag}
        </button>
      ) : (
        <span key={tag} className="library-bookmark-tag">{tag}</span>
      ))}
    </p>
  ) : null
  const snippets = !compact && (tldr || note) ? (
    <>
      {tldr ? <ResourceSnippet kind="tldr" tag="TL;DR" snippet={tldr} testId="bookmark-tldr" /> : null}
      {note ? <ResourceSnippet kind="note" tag="Note" snippet={note} testId="bookmark-note" /> : null}
    </>
  ) : null

  const body = compact ? (
    <>
      {mark}
      <div className="library-bookmark-body">
        <h3 ref={titleRef} data-collection-resource-title={collection ? true : undefined} title={titleClamped ? item.title : undefined} dir="auto">
          {item.title}
        </h3>
      </div>
      <span className="library-bookmark-mid">
        {item.mid ? <span className="library-bookmark-folder">{item.mid}</span> : null}
        {item.dateTime && item.date ? <time dateTime={item.dateTime}>{item.date}</time> : item.date ? <span>{item.date}</span> : null}
      </span>
      <span className="library-bookmark-host">{item.pinned ? <PinMark /> : null}{item.host}</span>
      {item.trailing}
    </>
  ) : (
    <>
      {mark}
      <div className="library-bookmark-body">
        <h3 ref={titleRef} data-collection-resource-title={collection ? true : undefined} title={titleClamped ? item.title : undefined} dir="auto">
          {item.title}
        </h3>
        <p className="meta-row">
          <span>{item.pinned ? <PinMark /> : null}{item.host}</span>
          {item.mid ? <span className="library-bookmark-folder">{item.mid}</span> : null}
          {item.dateTime && item.date ? <time dateTime={item.dateTime}>{item.date}</time> : item.date ? <span>{item.date}</span> : null}
        </p>
        {item.description ? (
          <p className="library-bookmark-desc" dir="auto">{item.description}</p>
        ) : null}
      </div>
      {item.trailing}
    </>
  )

  const selecting = item.selectable === true
  const hasSideSlots = selecting || item.actions != null
  const toggleSelect = selecting && item.onToggleSelect ? () => item.onToggleSelect?.() : undefined
  // Keyboard parity for row-click selection: Enter/Space on the row itself
  // toggles. Keys bubbling from the inner checkbox/links/buttons are ignored —
  // those controls have their own native activation.
  const toggleSelectKeyDown = toggleSelect
    ? (event: ReactKeyboardEvent<HTMLDivElement>) => {
        if (event.target !== event.currentTarget) return
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        toggleSelect()
      }
    : undefined

  return (
    <div
      role="listitem"
      className={hasSideSlots ? 'library-bookmark-row' : undefined}
      data-resource-hidden={item.hidden || undefined}
      data-collection-resource={collection ? true : undefined}
      data-depth={item.depth}
      data-resource-kind={item.kind}
      data-node-id={item.id}
      data-selected={item.selected || undefined}
      onClick={toggleSelect}
      tabIndex={toggleSelect ? 0 : undefined}
      onKeyDown={toggleSelectKeyDown}
      {...longPressHandlers}
      onPointerDown={onPointerDown}
    >
      {selecting && (
        <span className="library-bookmark-select">
          <input
            type="checkbox"
            checked={item.selected === true}
            aria-label={`Select ${item.title}`}
            onClick={(event) => event.stopPropagation()}
            onChange={() => item.onToggleSelect?.()}
          />
        </span>
      )}
      {(item.detailTo && snippets) || (tagStrip && onTag) ? (
        // Tag buttons and the excerpt's details link cannot nest inside the
        // row link, so they sit beside it in the same row grid.
        <div className={`${className} library-bookmark--split-links`}>
          <RowLink item={item} className="library-bookmark-main-link">
            {body}
          </RowLink>
          {tagStrip}
          {snippets && item.detailTo ? (
            <Link
              className="library-bookmark-snippets library-bookmark-details-link"
              to={item.detailTo}
              aria-label={`View details for ${item.title}`}
            >
              {snippets}
            </Link>
          ) : snippets ? <div className="library-bookmark-snippets">{snippets}</div> : null}
        </div>
      ) : (
        <RowLink item={item} className={className}>
          {body}
          {tagStrip}
          {snippets ? <div className="library-bookmark-snippets">{snippets}</div> : null}
        </RowLink>
      )}
      {item.actions != null && (
        // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- event boundary only: keeps action-button clicks from reaching the row's select/drag handlers; the children are native buttons/links
        <div
          className="library-bookmark-actions"
          onClick={(event) => event.stopPropagation()}
        >
          {item.actions}
        </div>
      )}
      {item.unavailable && <span className="meta">Link unavailable</span>}
    </div>
  )
}

/**
 * Board tile — the shared .result-card anatomy (R10-01): mark + kind rail,
 * title link, description, bottom-pinned meta strip. Public collection
 * cards keep GenericBody/DomainMark marks only — source skins stay on the
 * canvas.
 */
/**
 * LP-06 Gallery: result cards with an optional cover, laid out as masonry.
 * DOM order is the input order (the curator's order); see useGalleryMasonry.
 */
function GalleryBoard({ items, collection, testId }: {
  items: ResourceListItem[]
  collection: boolean
  testId?: string
}) {
  const board = useGalleryMasonry()
  return (
    <div ref={board} className="gallery-board" data-testid={testId} role="list">
      {items.map((item) => (
        <ResultCard key={item.id} item={item} collection={collection} gallery />
      ))}
    </div>
  )
}

/** Cover slot: reserved by width/height before load; a failed image leaves a text-only card. */
function GalleryCover({ cover }: { cover: PreviewCover }) {
  const [failed, setFailed] = useState(false)
  if (failed) return null
  return (
    <div className="gallery-card-cover" data-gallery-cover>
      <img
        src={cover.url}
        width={cover.width}
        height={cover.height}
        alt=""
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        draggable={false}
        onError={() => setFailed(true)}
      />
    </div>
  )
}

function ResultCard({
  item,
  collection,
  gallery = false,
}: {
  item: ResourceListItem
  collection: boolean
  gallery?: boolean
}) {
  const [titleRef, titleClamped] = useIsClamped<HTMLHeadingElement>(item.title)
  const cover = gallery && !item.hidden && item.cover ? item.cover : null
  const classes = ['result-card', item.hidden ? 'result-card--hidden' : '', gallery ? 'gallery-card' : '', item.selected ? 'is-selected' : '']
    .filter(Boolean).join(' ')
  return (
    <article
      className={classes}
      role="listitem"
      data-resource-hidden={item.hidden || undefined}
      data-collection-resource={collection ? true : undefined}
      data-gallery-card={gallery || undefined}
      data-selected={item.selected || undefined}
      data-depth={item.depth}
      data-resource-kind={item.kind}
      data-node-id={item.id}
    >
      {cover ? <GalleryCover cover={cover} /> : null}
      <div className="result-card-top">
        {item.selectable && (
          <input
            type="checkbox"
            checked={item.selected === true}
            aria-label={`Select ${item.title}`}
            onChange={() => item.onToggleSelect?.()}
          />
        )}
        {item.mark}
        {/* The host names the source beside its favicon — the link-card
            identity line — so the card floor carries no second host strip. */}
        <span className="result-card-host" dir="auto">{item.pinned ? <PinMark /> : null}{item.host.replace(/^www\./u, '')}</span>
        {item.kind ? <span className="chip chip--kind">{item.kind}</span> : null}
        {item.actions != null && (
          <span className="result-card-top-actions">{item.actions}</span>
        )}
      </div>
      <h3
        className="result-card-title"
        ref={titleRef}
        data-collection-resource-title={collection ? true : undefined}
        title={titleClamped ? item.title : undefined}
        dir="auto"
      >
        <RowLink item={item} className="result-card-link">
          {item.title}
        </RowLink>
      </h3>
      {item.description ? (
        <p className="result-card-desc" dir="auto">{item.description}</p>
      ) : null}
      {item.mid ? (
        <p className="meta-row result-card-meta">
          <span>{item.mid}</span>
        </p>
      ) : null}
      {item.unavailable && <span className="meta result-card-note">Link unavailable</span>}
    </article>
  )
}

/** Pins are set in the browser extension; the web shows them and keeps them above other bookmarks. */
function PinMark() {
  return (
    <span className="resource-pin" title="Pinned in the browser extension" data-testid="bookmark-pinned">
      <Icon name="pin" />
      <span className="visually-hidden">Pinned. </span>
    </span>
  )
}

function RowLink({
  item,
  className,
  children,
}: {
  item: ResourceListItem
  className: string
  children: ReactNode
}) {
  if (item.to) {
    return (
      <Link
        className={className}
        to={item.to}
        data-node-id={item.id}
        data-collection-resource-detail={item.detailLink ? true : undefined}
      >
        {children}
      </Link>
    )
  }
  if (item.href) {
    return (
      <a
        className={className}
        href={item.href}
        target="_blank"
        rel={UGC_REL}
        data-node-id={item.id}
        data-collection-resource-link={item.resourceLink ? true : undefined}
        onClick={item.onOpen}
      >
        {children}
      </a>
    )
  }
  return <span className={className}>{children}</span>
}
