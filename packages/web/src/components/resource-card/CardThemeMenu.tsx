import type { RefObject } from 'react'
import type { DeskTheme, DeskThemeId, TileSkinId } from '../../lib/deskThemes'
import { Icon } from '../Icon'

type CardThemeMenuProps = {
  menuRef: RefObject<HTMLDivElement | null>
  x: number
  y: number
  options: DeskTheme[]
  activeTheme: TileSkinId
  onPick: (themeId: DeskThemeId) => void
  /** Exit phase (useExitAnimation in the caller): plays the pop-out. */
  closing?: boolean
}

/**
 * Portaled color picker for a board card (C03). Pure presentation: the
 * caller owns the open state, outside-click dismissal and the portal.
 */
export function CardThemeMenu({
  menuRef,
  x,
  y,
  options,
  activeTheme,
  onPick,
  closing = false,
}: CardThemeMenuProps) {
  return (
    <div
      ref={menuRef}
      className={`tile-theme-menu${closing ? ' is-closing' : ''}`}
      style={{ top: y, left: x }}
      inert={closing || undefined}
      role="menu"
      tabIndex={-1}
      aria-label="Module color"
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      <p className="tile-theme-menu-label">Color</p>
      <div className="tile-theme-options">
        {options.map((t) => (
          <button
            key={t.id}
            type="button"
            role="menuitemradio"
            aria-checked={activeTheme === t.id}
            className={`tile-theme-option ${activeTheme === t.id ? 'is-active' : ''}`}
            onClick={() => onPick(t.id)}
          >
            <span className="tile-theme-swatches" aria-hidden>
              {t.swatches.map((c, i) => (
                <i key={i} className="tile-theme-swatch" style={{ ['--swatch' as string]: c }} />
              ))}
            </span>
            <span>{t.label}</span>
            <span className="tile-theme-check" aria-hidden>
              <Icon name="check" />
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
