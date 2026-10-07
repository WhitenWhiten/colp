import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { isLinkHealthExposureEnabled, type EditorSnapshot } from '../../api'
import { useToast } from '../../components/AppToast'
import { Icon } from '../../components/Icon'
import { popoverStyle } from '../../lib/anchorPopover'
import { canonicalSiteOrigin } from '../../lib/chrome'
import { copyTextToClipboard } from '../../lib/clipboard'
import { onMenuLinkKeyDown } from '../../lib/menuKeys'
import { useAnchoredMenu } from '../../lib/useAnchoredMenu'
import type { ComposeKind } from './mutations'

/* Per-row desk actions (⋯). Same interaction contract as LibraryMoreMenu —
   useAnchoredMenu owns it: aria-haspopup/expanded on the trigger, outside
   pointerdown closes, Esc closes and refocuses the trigger, arrows roam,
   Tab closes without eating the traversal. Wide screens reveal the trigger
   on row hover/focus; coarse pointers keep it always visible (library.css).
   The panel is portaled + viewport-clamped so the shared bookmark-list
   surface cannot clip it (last row used to shear the menu). */
const ROW_MENU_WIDTH = 216
const ROW_MENU_MAX_HEIGHT = 280

type RowMenuApi = { run: (action: () => void) => void }

/** The trigger + portaled menu shared by bookmark and folder rows (and the
    digest issue rows, which reuse the same ⋯ grammar). */
export function RowActionMenu({
  title,
  children,
}: {
  title: string
  children: (api: RowMenuApi) => ReactNode
}) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const triggerId = useId()
  const menu = useAnchoredMenu({ exemptRefs: [triggerRef] })
  const { open, anchorPos } = menu

  const toggle = () => {
    if (open) {
      menu.close()
      return
    }
    menu.openAnchored(
      () => triggerRef.current?.getBoundingClientRect() ?? null,
      { width: ROW_MENU_WIDTH, maxHeight: ROW_MENU_MAX_HEIGHT, align: 'end' },
    )
  }

  const run = (action: () => void) => {
    menu.close()
    // Hand focus back to the trigger before acting: the focused menuitem is
    // about to unmount, and a Modal opened by the action records the current
    // activeElement as its focus-return target (body, if we skip this).
    triggerRef.current?.focus()
    action()
  }

  const menuPanel = open && anchorPos && typeof document !== 'undefined'
    ? createPortal(
        <div
          className="nav-dropdown library-bookmark-menu-dropdown"
          role="menu"
          aria-labelledby={triggerId}
          tabIndex={-1}
          ref={menu.menuRef}
          style={popoverStyle(anchorPos)}
        >
          {children({ run })}
        </div>,
        document.body,
      )
    : null

  return (
    <div className="library-bookmark-menu account-menu">
      <button
        type="button"
        ref={triggerRef}
        id={triggerId}
        className="btn btn-ghost btn-sm library-bookmark-menu-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Actions for ${title}`}
        onClick={toggle}
      >
        <Icon name="more-horizontal" />
      </button>
      {menuPanel}
    </div>
  )
}

export function LibraryBookmarkMenu({
  title,
  detailsTo,
  canMove,
  canDelete,
  onEdit,
  onMove,
  onCopy,
  onDelete,
  onSelect,
}: {
  title: string
  detailsTo: string
  canMove: boolean
  canDelete: boolean
  /** Opens the FE-04 node edit drawer. */
  onEdit?: () => void
  onMove: () => void
  onCopy?: () => void
  onDelete: () => void
  /** Absent while sidebar reorder is active (modes are mutually exclusive). */
  onSelect?: () => void
}) {
  return (
    <RowActionMenu title={title}>
      {({ run }) => (
        <>
          <Link
            to={detailsTo}
            role="menuitem"
            tabIndex={-1}
            onKeyDown={onMenuLinkKeyDown}
            onClick={() => run(() => undefined)}
          >
            View details
          </Link>
          {onEdit && (
            <button type="button" role="menuitem" tabIndex={-1} onClick={() => run(onEdit)}>
              Edit details
            </button>
          )}
          {canMove && (
            <button type="button" role="menuitem" tabIndex={-1} onClick={() => run(onMove)}>
              Move to…
            </button>
          )}
          {onCopy && (
            <button type="button" role="menuitem" tabIndex={-1} onClick={() => run(onCopy)}>
              Copy to…
            </button>
          )}
          {onSelect && (
            <button type="button" role="menuitem" tabIndex={-1} onClick={() => run(onSelect)}>
              Select
            </button>
          )}
          {canDelete && (
            <button type="button" role="menuitem" tabIndex={-1} onClick={() => run(onDelete)}>
              Delete
            </button>
          )}
        </>
      )}
    </RowActionMenu>
  )
}

/* Folders at any depth manage through the same ⋯ as bookmarks (FE-05): edit
   the folder's own fields, move it, or delete it with its subtree. */
export function LibraryFolderMenu({
  title,
  canMove,
  canDelete,
  onEdit,
  onMove,
  onDelete,
}: {
  title: string
  canMove: boolean
  canDelete: boolean
  onEdit: () => void
  onMove: () => void
  onDelete: () => void
}) {
  return (
    <RowActionMenu title={title}>
      {({ run }) => (
        <>
          <button type="button" role="menuitem" tabIndex={-1} onClick={() => run(onEdit)}>
            Edit details
          </button>
          {canMove && (
            <button type="button" role="menuitem" tabIndex={-1} onClick={() => run(onMove)}>
              Move to…
            </button>
          )}
          {canDelete && (
            <button type="button" role="menuitem" tabIndex={-1} onClick={() => run(onDelete)}>
              Delete
            </button>
          )}
        </>
      )}
    </RowActionMenu>
  )
}

/* One menu, mounted from LibraryHeader. The meta row must not render a second copy. */
const MORE_MENU_WIDTH = 216
const MORE_MENU_MAX_HEIGHT = 320

export function LibraryMoreMenu({
  className,
  caps,
  selectedId,
  followedSlug = null,
  publicSlug = null,
  collaboratorsLive,
  onCompose,
  onEditCollection,
}: {
  className?: string
  caps: EditorSnapshot['capabilities'] | undefined
  selectedId: string
  /** Publication slug when the desk shows a followed collection (read-only). */
  followedSlug?: string | null
  /** Owned public or unlisted slug. Omitted by call sites that are not that desk. */
  publicSlug?: string | null
  collaboratorsLive: boolean
  onCompose: (kind: ComposeKind) => void
  onEditCollection?: () => void
}) {
  const { success, error } = useToast()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const triggerId = useId()
  const menu = useAnchoredMenu({ exemptRefs: [triggerRef] })
  const { open, anchorPos, close } = menu

  useEffect(() => {
    close()
  }, [selectedId, close])

  const toggle = () => {
    if (open) {
      menu.close()
      return
    }
    /* Portaled + anchor-tracked like RowActionMenu: the in-flow absolute
       dropdown risked clipping under the desk's overflow containers. */
    menu.openAnchored(
      () => triggerRef.current?.getBoundingClientRect() ?? null,
      { width: MORE_MENU_WIDTH, maxHeight: MORE_MENU_MAX_HEIGHT, align: 'end' },
    )
  }

  const compose = (kind: ComposeKind) => {
    menu.close()
    // Same reason as run(): the dialog records the trigger as its focus return.
    triggerRef.current?.focus()
    onCompose(kind)
  }

  const copyPublicLink = async (slug: string) => {
    try {
      await copyTextToClipboard(`${canonicalSiteOrigin()}/c/${encodeURIComponent(slug)}`)
      success('Public link copied')
    } catch {
      error('Couldn’t copy the link')
    }
  }

  const dropdown = open && anchorPos && typeof document !== 'undefined'
    ? createPortal(
        <div
          className="nav-dropdown"
          role="menu"
          aria-labelledby={triggerId}
          tabIndex={-1}
          ref={menu.menuRef}
          style={popoverStyle(anchorPos)}
        >
          {followedSlug !== null ? (
            <Link
              role="menuitem"
              tabIndex={-1}
              to={`/c/${encodeURIComponent(followedSlug)}`}
              onClick={menu.close}
              onKeyDown={onMenuLinkKeyDown}
            >
              Open public page
            </Link>
          ) : (
            <>
              {caps?.createNode && (
                <button type="button" role="menuitem" tabIndex={-1} onClick={() => compose('folder')}>
                  Add folder
                </button>
              )}
              {caps?.updateCollection && onEditCollection && (
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  onClick={() => {
                    menu.close()
                    triggerRef.current?.focus()
                    onEditCollection()
                  }}
                >
                  Edit collection
                </button>
              )}
              <Link
                role="menuitem"
                tabIndex={-1}
                to={`/library/${encodeURIComponent(selectedId)}/history`}
                onClick={menu.close}
                onKeyDown={onMenuLinkKeyDown}
              >
                Version history
              </Link>
              {collaboratorsLive && (
                <Link
                  role="menuitem"
                  tabIndex={-1}
                  to={`/library/${encodeURIComponent(selectedId)}/collaborators`}
                  onClick={menu.close}
                  onKeyDown={onMenuLinkKeyDown}
                >
                  Collaborators
                </Link>
              )}
              {publicSlug && (
                <>
                  <Link
                    role="menuitem"
                    tabIndex={-1}
                    to={`/c/${encodeURIComponent(publicSlug)}`}
                    onClick={menu.close}
                    onKeyDown={onMenuLinkKeyDown}
                  >
                    Open public page
                  </Link>
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    onClick={() => {
                      menu.close()
                      triggerRef.current?.focus()
                      if (publicSlug) void copyPublicLink(publicSlug)
                    }}
                  >
                    Copy public link
                  </button>
                </>
              )}
              {isLinkHealthExposureEnabled() && (
                <Link
                  role="menuitem"
                  tabIndex={-1}
                  to="/library/health"
                  onClick={menu.close}
                  onKeyDown={onMenuLinkKeyDown}
                >
                  Check links
                </Link>
              )}
            </>
          )}
        </div>,
        document.body,
      )
    : null

  return (
    <div className={className ? `library-more account-menu ${className}` : 'library-more account-menu'}>
      {/* R7-03: adding a bookmark is the desk's primary action — it lives as a
          first-class button, not behind the overflow menu. */}
      {followedSlug === null && caps?.createNode && (
        <button type="button" className="btn btn-primary btn-sm" onClick={() => compose('bookmark')}>
          Add bookmark
        </button>
      )}
      <button
        type="button"
        ref={triggerRef}
        id={triggerId}
        className="btn btn-secondary btn-sm"
        aria-haspopup="menu"
        aria-expanded={open}
        // R15-41: the name starts with the visible "More" (2.5.3).
        aria-label="More collection actions"
        onClick={toggle}
      >
        More
        <Icon name="chevron-down" />
      </button>
      {dropdown}
    </div>
  )
}
