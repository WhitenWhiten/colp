import type { RefObject } from 'react'
import type { DeskThemeId } from '../../lib/deskThemes'
import { Icon } from '../Icon'
import { ResourceMarkActions } from '../ResourceMarkActions'

type CardActionsProps = {
  label: string
  stackLocked: boolean
  isTool: boolean
  resourceId: string
  resourceTitle: string
  onToggleLock?: () => void
  onThemeChange?: (themeId: DeskThemeId) => void
  themeMenuOpen: boolean
  themeBtnRef: RefObject<HTMLButtonElement | null>
  onOpenThemeMenu: (anchor: { left: number; bottom: number }) => void
  onRemove?: () => void
}

/**
 * Edit-mode action chrome (C03): lock / color / remove buttons plus the
 * read + save mark actions. Rendered inside `.card-head` next to the drag
 * handle; stays readable on every source skin via ink-2 tokens.
 */
export function CardActions({
  label,
  stackLocked,
  isTool,
  resourceId,
  resourceTitle,
  onToggleLock,
  onThemeChange,
  themeMenuOpen,
  themeBtnRef,
  onOpenThemeMenu,
  onRemove,
}: CardActionsProps) {
  return (
    <>
      <div className="card-actions-secondary" data-testid="card-actions">
      {onToggleLock && (
        <button
          type="button"
          className={`card-action stack-lock-btn ${stackLocked ? 'is-active' : ''}`}
          aria-label={stackLocked ? `Unlock ${label}` : `Lock ${label} on top`}
          aria-pressed={stackLocked}
          title={stackLocked ? 'Unlock (allow move · drop layer pin)' : 'Lock on top'}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            onToggleLock()
          }}
        >
          <Icon name={stackLocked ? 'lock' : 'lock-open'} />
        </button>
      )}
      {onThemeChange && (
        <button
          ref={themeBtnRef}
          type="button"
          className={`card-action card-theme-btn ${themeMenuOpen ? 'is-open' : ''}`}
          aria-label={`Color for ${label}`}
          aria-haspopup="menu"
          aria-expanded={themeMenuOpen}
          title="Color · or right-click card"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            const r = e.currentTarget.getBoundingClientRect()
            onOpenThemeMenu({ left: r.left, bottom: r.bottom + 4 })
          }}
        >
          <Icon name="palette" />
        </button>
      )}
      {!isTool && (
        <ResourceMarkActions
          resourceId={resourceId}
          resourceTitle={resourceTitle}
          density="card"
          stopPointer
        />
      )}
      </div>
      {onRemove && (
        <button
          type="button"
          className="card-action card-remove-btn"
          aria-label={`Remove ${label} from board`}
          title="Remove from board"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
        >
          <Icon name="cross" />
        </button>
      )}
    </>
  )
}
