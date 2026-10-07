import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { isProductApiError, productClient, type OwnedCollectionListItem } from '../api'
import {
  DashboardCollistContext,
  isOwnedSignInMessage,
} from '../lib/collistBinding'
import { flattenBookmarks, hostOf, isAbort, type BookmarkNode } from '../lib/libraryTree'
import { onMenuLinkKeyDown } from '../lib/menuKeys'
import { plural } from '../lib/plural'
import { useAnchoredMenu } from '../lib/useAnchoredMenu'
import { EXIT_DURATION_FAST_MS, useExitAnimation } from '../lib/useExitAnimation'
import type { Resource } from '../types/catalog'
import { CollistItem } from './CollistItem'
import { EmptyState, LoadingState } from './EmptyState'

type ListMode = 'list' | 'compact'

type Props = {
  resource: Resource
}

const ROW_LAYOUT = { x: 0, y: 0, w: 1, h: 1, z: 0 } as const

function modeStorageKey(id: string) {
  return `known.collist.mode.${id}`
}

function loadMode(id: string, fallback: ListMode): ListMode {
  try {
    const raw = localStorage.getItem(modeStorageKey(id))
    if (raw === 'list' || raw === 'compact') return raw
  } catch {
    /* ignore */
  }
  return fallback
}

function publicationHref(slug: unknown): string | null {
  return typeof slug === 'string' && slug.length > 0 ? `/c/${slug}` : null
}

function bookmarkToResource(node: BookmarkNode): Resource {
  return {
    id: node.id,
    type: 'article',
    title: node.title,
    url: node.url,
    summary: node.description ?? '',
    host: hostOf(node.url),
    layout: { ...ROW_LAYOUT },
  }
}

function stopPointer(e: { stopPropagation: () => void }) {
  e.stopPropagation()
}

/**
 * Embed a collection's list/compact view inside a freeform canvas card.
 * Right-click (or View button) to switch density or pin another owned collection.
 * Wheel over the list scrolls only the list.
 */
export function CollectionListEmbed({ resource }: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const viewBtnRef = useRef<HTMLButtonElement>(null)
  const ctxMenu = useAnchoredMenu({ exemptRefs: [viewBtnRef] })
  // Stable callback (useCallback [] in the hook) — safe as an effect dep.
  const { openAt: openCtxMenuAt } = ctxMenu
  const { owned, bindings, bind } = useContext(DashboardCollistContext)
  const boundId = bindings[resource.id]
  const entry = owned.items.find((item) => item.collection.id === boundId) ?? null
  const collection = entry?.collection ?? null
  const publicHref = publicationHref(collection?.publicationSlug)
  const initialMode: ListMode =
    resource.meta?.listMode === 'list' ? 'list' : 'compact'

  const [mode, setMode] = useState<ListMode>(() =>
    loadMode(resource.id, initialMode),
  )
  // Exit phase: the menu pops out at the fast tier; the last anchor point is
  // kept so the closing frame does not jump.
  const { mounted: menuMounted, closing: menuClosing } = useExitAnimation(
    ctxMenu.pos !== null,
    EXIT_DURATION_FAST_MS,
  )
  const lastMenuRef = useRef<{ x: number; y: number } | null>(null)
  if (ctxMenu.pos) lastMenuRef.current = ctxMenu.pos
  const menuPos = ctxMenu.pos ?? lastMenuRef.current
  const [snapState, setSnapState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [snapMessage, setSnapMessage] = useState('Loading collections')
  const [rows, setRows] = useState<Resource[]>([])
  const [rowCount, setRowCount] = useState(0)
  const [snapNonce, setSnapNonce] = useState(0)

  const collectionId = collection?.id

  useEffect(() => {
    if (!collectionId) {
      setRows([])
      setRowCount(0)
      setSnapState('idle')
      return
    }
    const controller = new AbortController()
    setSnapState('loading')
    setSnapMessage('Loading collections')
    setRows([])
    void productClient
      .loadEditorSnapshot(collectionId, { signal: controller.signal, maxRetries: 0 })
      .then((snap) => {
        if (controller.signal.aborted) return
        const bookmarks = flattenBookmarks(snap.root, snap.nodes)
        setRows(bookmarks.map((row) => bookmarkToResource(row.node)))
        setRowCount(bookmarks.length)
        setSnapState('ready')
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbort(error)) return
        setRows([])
        setRowCount(0)
        setSnapState('error')
        setSnapMessage(
          isProductApiError(error) && error.isAuthRequired
            ? 'Sign in to view your collections'
            : isProductApiError(error)
              ? error.recoveryHint
              : 'Collection could not be loaded',
        )
      })
    return () => controller.abort()
  }, [collectionId, snapNonce])

  const applyMode = (next: ListMode) => {
    setMode(next)
    try {
      localStorage.setItem(modeStorageKey(resource.id), next)
    } catch {
      /* ignore */
    }
    ctxMenu.close()
  }

  const openMenuAt = (clientX: number, clientY: number) => {
    openCtxMenuAt(clientX, clientY, { width: 220, height: 280 })
  }

  useEffect(() => {
    const root = rootRef.current
    const scroller = scrollerRef.current
    if (!root || !scroller) return

    const scrollBy = (deltaY: number) => {
      const maxScroll = scroller.scrollHeight - scroller.clientHeight
      if (maxScroll <= 0) return
      scroller.scrollTop = Math.min(
        maxScroll,
        Math.max(0, scroller.scrollTop + deltaY),
      )
    }

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      e.stopPropagation()
      scrollBy(e.deltaY)
    }

    scroller.addEventListener('wheel', onWheel, { passive: false })
    root.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      scroller.removeEventListener('wheel', onWheel)
      root.removeEventListener('wheel', onWheel)
    }
  }, [rows.length, mode])

  useEffect(() => {
    const root = rootRef.current
    if (!root) return

    const onCtx = (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      openCtxMenuAt(e.clientX, e.clientY, { width: 220, height: 280 })
    }

    root.addEventListener('contextmenu', onCtx)
    return () => root.removeEventListener('contextmenu', onCtx)
  }, [openCtxMenuAt])

  const signedOut = isOwnedSignInMessage(owned.message)
  const linkCount = entry?.bookmarkCount ?? rowCount
  const title = collection?.title ?? ''
  const libraryHref = collection ? `/library/${collection.id}` : null

  const scrollerBody = useMemo(() => {
    if (owned.state === 'loading') {
      return <LoadingState label={owned.message} />
    }
    if (signedOut) {
      return (
        <EmptyState
          className="empty-state--compact"
          icon="collection"
          title="Sign in to view your collections"
        />
      )
    }
    if (owned.state === 'error') {
      return (
        <EmptyState
          className="empty-state--compact"
          role="alert"
          icon="collection"
          title="Collections could not be loaded"
          description={owned.message}
          action={(
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onPointerDown={stopPointer}
              onClick={() => void owned.reload()}
            >
              Reload
            </button>
          )}
        />
      )
    }
    if (owned.items.length === 0) {
      return (
        <EmptyState
          className="empty-state--compact"
          icon="collection"
          title="No collections yet"
        />
      )
    }
    if (!collection) {
      return (
        <EmptyState
          className="empty-state--compact"
          icon="collection"
          title="No more collections"
          action={(
            <Link
              to="/library/new"
              className="btn btn-ghost btn-sm"
              onPointerDown={stopPointer}
            >
              New collection
            </Link>
          )}
        />
      )
    }
    if (snapState === 'loading' || snapState === 'idle') {
      return <LoadingState label={snapMessage} />
    }
    if (snapState === 'error') {
      return (
        <EmptyState
          className="empty-state--compact"
          role="alert"
          icon="collection"
          title={snapMessage}
          action={(
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onPointerDown={stopPointer}
              onClick={() => setSnapNonce((value) => value + 1)}
            >
              Retry
            </button>
          )}
        />
      )
    }
    return rows.map((item) => <CollistItem key={item.id} item={item} mode={mode} />)
  }, [
    owned,
    signedOut,
    collection,
    snapState,
    snapMessage,
    rows,
    mode,
  ])

  const pinCollection = (item: OwnedCollectionListItem) => {
    bind(resource.id, item.collection.id)
    ctxMenu.close()
  }

  const menuUi =
    menuMounted &&
    menuPos &&
    createPortal(
      <div
        ref={ctxMenu.menuRef}
        className={`ctx-menu${menuClosing ? ' is-closing' : ''}`}
        style={{ top: menuPos.y, left: menuPos.x }}
        inert={menuClosing || undefined}
        role="menu"
        tabIndex={-1}
        aria-label="Collection list settings"
        onPointerDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
        }}
      >
        <p className="ctx-menu-label">View density</p>
        <button
          type="button"
          role="menuitemradio"
          aria-checked={mode === 'compact'}
          className={mode === 'compact' ? 'is-active' : undefined}
          onClick={() => applyMode('compact')}
        >
          <span>Compact</span>
          <span className="meta">Dense rows</span>
        </button>
        <button
          type="button"
          role="menuitemradio"
          aria-checked={mode === 'list'}
          className={mode === 'list' ? 'is-active' : undefined}
          onClick={() => applyMode('list')}
        >
          <span>List</span>
          <span className="meta">Title + summary</span>
        </button>
        {owned.items.length > 0 && (
          <>
            <div className="ctx-menu-sep" />
            <p className="ctx-menu-label">Change bound collection</p>
            {owned.items.map((item) => (
              <button
                key={item.collection.id}
                type="button"
                role="menuitemradio"
                aria-checked={item.collection.id === collection?.id}
                className={item.collection.id === collection?.id ? 'is-active' : undefined}
                onClick={() => pinCollection(item)}
              >
                <span>{item.collection.title}</span>
                <span className="meta">
                  {item.collection.visibility} · {item.collection.kind}
                </span>
              </button>
            ))}
          </>
        )}
        {(libraryHref || publicHref) && <div className="ctx-menu-sep" />}
        {libraryHref && (
          <Link
            to={libraryHref}
            role="menuitem"
            tabIndex={0}
            className="ctx-menu-link"
            onClick={() => ctxMenu.close()}
            onKeyDown={onMenuLinkKeyDown}
          >
            Open full collection
          </Link>
        )}
        {publicHref && (
          <Link
            to={publicHref}
            role="menuitem"
            tabIndex={0}
            className="ctx-menu-link"
            onClick={() => ctxMenu.close()}
            onKeyDown={onMenuLinkKeyDown}
          >
            Open public page
          </Link>
        )}
      </div>,
      document.body,
    )

  const subtitle = collection
    ? `${plural(linkCount, 'link')} · ${collection.visibility} · ${collection.kind} · ${mode}`
    : mode

  return (
    <div className="collist" ref={rootRef}>
      <div className="collist-meta">
        <div>
          <div className="collist-title-row" data-testid="collist-title-row">
            <strong>{title}</strong>
          </div>
          <p className="meta">{subtitle}</p>
        </div>
        <div className="collist-actions">
          <button
            ref={viewBtnRef}
            type="button"
            className="btn btn-ghost btn-sm"
            aria-haspopup="menu"
            aria-expanded={!!ctxMenu.pos}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              const rect = e.currentTarget.getBoundingClientRect()
              if (ctxMenu.pos) ctxMenu.close()
              else openMenuAt(rect.left, rect.bottom + 4)
            }}
          >
            View
          </button>
          {libraryHref && (
            <Link
              to={libraryHref}
              className="btn btn-ghost btn-sm"
              onPointerDown={(e) => e.stopPropagation()}
            >
              Open
            </Link>
          )}
        </div>
      </div>

      <div
        ref={scrollerRef}
        className={`collist-scroller collist-scroller--${mode}`}
        tabIndex={0}
        role="region"
        aria-label={title ? `${title} list` : 'Collection list'}
      >
        {scrollerBody}
      </div>

      <div className="collist-foot meta">
        Hover for notes · click panel to pin · right-click View
      </div>

      {menuUi}
    </div>
  )
}
