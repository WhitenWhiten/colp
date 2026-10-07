import type { KeyboardEvent, PointerEvent as REPointerEvent, RefObject } from 'react'
import type { SourceType } from '../../types/catalog'
import type { DeskThemeId } from '../../lib/deskThemes'
import { CardActions } from './CardActions'
import { SourceMark } from './SourceMark'

type CardHeadProps = {
  type: SourceType
  label: string
  /** Collection titles stay sentence case so they don't ellipsis to INT… */
  plainLabel?: boolean
  stackLocked: boolean
  isTool: boolean
  resourceId: string
  resourceTitle: string
  onMoveStart?: (e: REPointerEvent<HTMLElement>) => void
  onMoveKey?: (e: KeyboardEvent<HTMLButtonElement>) => void
  onToggleLock?: () => void
  onThemeChange?: (themeId: DeskThemeId) => void
  themeMenuOpen: boolean
  themeBtnRef: RefObject<HTMLButtonElement | null>
  onOpenThemeMenu: (anchor: { left: number; bottom: number }) => void
  onRemove?: () => void
}

/**
 * Card header chrome (C03): drag handle with source mark + name, then the
 * action buttons. Only rendered in edit mode (see SourceCard).
 */
export function CardHead({
  type,
  label,
  plainLabel = false,
  stackLocked,
  isTool,
  resourceId,
  resourceTitle,
  onMoveStart,
  onMoveKey,
  onToggleLock,
  onThemeChange,
  themeMenuOpen,
  themeBtnRef,
  onOpenThemeMenu,
  onRemove,
}: CardHeadProps) {
  return (
    <div className="card-head" data-testid="card-head">
      <button
        type="button"
        className={`drag-handle ${stackLocked ? 'is-locked' : ''}`}
        aria-label={
          stackLocked
            ? `${label} card locked on top. Unlock to move.`
            : `Move ${label} card. Arrow keys to reposition.`
        }
        onPointerDown={(e) => {
          e.stopPropagation()
          onMoveStart?.(e)
        }}
        onKeyDown={(e) => {
          onMoveKey?.(e)
        }}
      >
        <span className="grip" aria-hidden />
        <SourceMark type={type} />
        <span className={`source-name${plainLabel ? ' source-name--plain' : ''}`} data-testid="source-name">{label}</span>
        {stackLocked && (
          <span className="stack-lock-badge" aria-hidden>
            Locked
          </span>
        )}
      </button>
      <CardActions
        label={label}
        stackLocked={stackLocked}
        isTool={isTool}
        resourceId={resourceId}
        resourceTitle={resourceTitle}
        onToggleLock={onToggleLock}
        onThemeChange={onThemeChange}
        themeMenuOpen={themeMenuOpen}
        themeBtnRef={themeBtnRef}
        onOpenThemeMenu={onOpenThemeMenu}
        onRemove={onRemove}
      />
    </div>
  )
}
