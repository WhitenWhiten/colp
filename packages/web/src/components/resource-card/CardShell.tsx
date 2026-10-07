import type {
  CSSProperties,
  KeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as REPointerEvent,
  ReactNode,
} from 'react'
import { Icon } from '../Icon'

type CardShellProps = {
  /** Full tile class list (type / theme / state) composed by the caller. */
  className: string
  /** Dynamic board geometry as CSS custom properties. */
  style: CSSProperties
  dataId: string
  dataTheme: string
  /** Header chrome (CardHead) — only present in edit mode. */
  head?: ReactNode
  /** Content wrapper modifiers (fill widgets vs bookmark padding). */
  contentFill?: boolean
  contentNoHead?: boolean
  /** Edit chrome: size badge + resize handle. */
  editable?: boolean
  stackLocked?: boolean
  selected?: boolean
  badge: string
  label: string
  onSelect?: () => void
  onContextMenu?: (e: ReactMouseEvent) => void
  onResizeStart?: (e: REPointerEvent<HTMLElement>) => void
  onResizeKey?: (e: KeyboardEvent<HTMLButtonElement>) => void
  children: ReactNode
}

/**
 * Generic card shell (C03). Owns the `.tile` article surface, the
 * `.card-shell` column, the `.tile-content` wrapper and the edit-mode
 * resize chrome. The shell never branches on the source type beyond the
 * tile class list; surface / radius / padding / hover stay in
 * cards.css / cards-ui.css.
 */
export function CardShell({
  className,
  style,
  dataId,
  dataTheme,
  head,
  contentFill = false,
  contentNoHead = false,
  editable = false,
  stackLocked = false,
  selected = false,
  badge,
  label,
  onSelect,
  onContextMenu,
  onResizeStart,
  onResizeKey,
  children,
}: CardShellProps) {
  const contentClass = [
    'tile-content',
    contentFill ? 'tile-content--fill' : '',
    contentNoHead ? 'tile-content--no-head' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <article
      className={className}
      style={style}
      role="listitem"
      data-id={dataId}
      data-theme={dataTheme}
      onPointerDown={onSelect ? () => onSelect() : undefined}
      onContextMenu={onContextMenu}
    >
      <div className="card-shell" data-testid="card-shell">
        {head}
        <div className={contentClass} data-testid="tile-content">{children}</div>
      </div>
      {editable && !stackLocked && (
        <>
          <span className="size-badge" aria-hidden data-testid="size-badge">
            {badge}
          </span>
          <button
            type="button"
            className="resize-handle"
            aria-label={`Resize ${label} card. Arrow keys to change size.`}
            onPointerDown={(e) => {
              e.stopPropagation()
              onResizeStart?.(e)
            }}
            onKeyDown={(e) => onResizeKey?.(e)}
          >
            <Icon name="resize" />
          </button>
        </>
      )}
      {editable && stackLocked && selected && (
        <span className="size-badge size-badge--locked" aria-hidden>
          Locked on top
        </span>
      )}
    </article>
  )
}

