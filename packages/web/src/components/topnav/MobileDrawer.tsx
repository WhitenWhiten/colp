import { NavLink } from 'react-router-dom'
import { Icon } from '../Icon'
import { SITE_SEARCH_PLACEHOLDER } from '../../lib/searchCopy'
import { prefetchRoute } from './prefetch'
import type { ToolItem } from './ToolsMenu'

type Props = {
  toolItems: readonly ToolItem[]
  isLoggedIn: boolean
  showLogin: boolean
  loginTo: string
  /** Exit phase: plays the drawer lift before unmount. */
  closing: boolean
  onOpenSearch: () => void
  onOpenSettings: () => void
  onSignOut: () => void
}

/** Top-anchored mobile drawer: search, tools, and account only.
   Primary destinations live on BottomNav. Route changes close it via the
   parent (TopNav resets on pathname). */
export function MobileDrawer({
  toolItems,
  isLoggedIn,
  showLogin,
  loginTo,
  closing,
  onOpenSearch,
  onOpenSettings,
  onSignOut,
}: Props) {
  return (
    <nav
      id="mobile-navigation"
      className={`mobile-drawer${closing ? ' is-closing' : ''}`}
      aria-label="Mobile"
      inert={closing || undefined}
    >
      {isLoggedIn && (
        <button
          type="button"
          className="mobile-search"
          onClick={onOpenSearch}
        >
          <Icon name="search" />
          <span>{SITE_SEARCH_PLACEHOLDER}</span>
        </button>
      )}

      {/* Ungrouped items are the library tools; a grouped run (Moderation)
          gets its own labelled section, as in the desktop Tools menu. */}
      {toolGroups(toolItems).map(({ label, items }) => (
        <div className="mobile-drawer-section" key={label}>
          <span className="mobile-drawer-label">{label}</span>
          <div className="mobile-drawer-grid">
            {items.map((item) => item.unavailable ? (
              <span key={item.to} className="nav-item-unavailable" aria-disabled="true">
                {item.label} <small>Not available</small>
              </span>
            ) : (
              <NavLink
                key={item.to}
                to={item.to}
                onPointerEnter={() => prefetchRoute(item.to)}
                onFocus={() => prefetchRoute(item.to)}
              >
                {item.label}
              </NavLink>
            ))}
          </div>
        </div>
      ))}

      <div className="mobile-drawer-section mobile-account-section">
        <span className="mobile-drawer-label">Account</span>
        {isLoggedIn ? (
          <>
            <div className="mobile-drawer-grid">
              <NavLink to="/approvals">Approvals</NavLink>
              <button
                type="button"
                onClick={() => {
                  onOpenSettings()
                }}
              >
                Settings
              </button>
            </div>
            <button
              type="button"
              className="mobile-logout"
              onClick={() => {
                onSignOut()
              }}
            >
              Sign out
            </button>
          </>
        ) : (
          <div className="mobile-drawer-grid">
            {showLogin && <NavLink to={loginTo}>Sign in</NavLink>}
          </div>
        )}
      </div>
    </nav>
  )
}

function toolGroups(items: readonly ToolItem[]) {
  const groups: { label: string; items: ToolItem[] }[] = []
  for (const item of items) {
    const label = item.group ?? 'Tools'
    const last = groups[groups.length - 1]
    if (last && last.label === label) last.items.push(item)
    else groups.push({ label, items: [item] })
  }
  return groups
}
