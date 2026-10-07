import { Fragment, useEffect, useRef, type RefObject } from 'react'
import { Link } from 'react-router-dom'
import { useExitAnimation } from '../../lib/useExitAnimation'
import { prefetchRoute } from './prefetch'

/** `group` starts a labelled block (e.g. Moderation) after the library
    tools, so a long list scans as two short ones. */
export type ToolItem = {
  to: string
  label: string
  group?: string
  /** The server said the feature is off: listed, but not a link. */
  unavailable?: boolean
}

type Props = {
  items: readonly ToolItem[]
  open: boolean
  /** Parent coordinates mutual exclusion with the other nav menus. */
  onToggle: () => void
  onClose: () => void
  /** Lets the parent return focus here when Esc closes the dropdown (APG
      disclosure contract — the parent owns the global Esc listener). */
  triggerRef?: RefObject<HTMLButtonElement | null>
}

/** Tools dropdown in the top bar. Disclosure pattern (aria-expanded, no
   role="menu") — the same contract TopNav's chrome test pins. */
export function ToolsMenu({ items, open, onToggle, onClose, triggerRef }: Props) {
  const toolsRef = useRef<HTMLDivElement>(null)
  const { mounted, closing } = useExitAnimation(open)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!toolsRef.current?.contains(e.target as Node)) onClose()
    }
    window.addEventListener('pointerdown', onDown)
    return () => window.removeEventListener('pointerdown', onDown)
  }, [open, onClose])

  return (
    <div className="tools-menu" ref={toolsRef}>
      <button
        type="button"
        ref={triggerRef}
        className="btn btn-ghost btn-sm tools-trigger"
        data-testid="tools-trigger"
        aria-expanded={open}
        aria-controls="tools-dropdown"
        onClick={onToggle}
      >
        Tools
      </button>
      {mounted && (
        <nav
          id="tools-dropdown"
          data-testid="tools-dropdown"
          className={`nav-dropdown${closing ? ' is-closing' : ''}`}
          aria-label="Tools"
          inert={closing || undefined}
        >
          {items.map((item, index) => (
            <Fragment key={item.to}>
              {item.group && item.group !== items[index - 1]?.group ? (
                <>
                  <div className="ctx-menu-sep" aria-hidden />
                  <p className="section-label nav-dropdown-label">{item.group}</p>
                </>
              ) : null}
              {item.unavailable ? (
                <span className="nav-item-unavailable" aria-disabled="true">
                  {item.label} <small>Not available</small>
                </span>
              ) : (
                // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- react-router Link renders a native anchor (Enter activates natively); hover prefetch has focus parity via onFocus
                <Link
                  to={item.to}
                  onClick={onClose}
                  onPointerEnter={() => prefetchRoute(item.to)}
                  onFocus={() => prefetchRoute(item.to)}
                >
                  {item.label}
                </Link>
              )}
            </Fragment>
          ))}
        </nav>
      )}
    </div>
  )
}
