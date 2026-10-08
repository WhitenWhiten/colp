import { NavLink } from 'react-router-dom'
import { Icon } from '../Icon'
import { SITE_SEARCH_PLACEHOLDER } from '../../lib/searchCopy'
import { prefetchRoute } from './prefetch'
import { isSelfHostedEdition, isSelfHostedPathEnabled } from '../../lib/edition'
import type { ToolItem } from './ToolsMenu'

type Props = {
  toolItems: readonly ToolItem[]
  isLoggedIn: boolean
  user: { handle: string } | null
  showWriteApprovals: boolean
  showLogin: boolean
  loginTo: string
  showRegister: boolean
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
  user,
  showWriteApprovals,
  showLogin,
  loginTo,
  showRegister,
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
      <button
        type="button"
        className="mobile-search"
        onClick={onOpenSearch}
      >
        <Icon name="search" />
        <span>{SITE_SEARCH_PLACEHOLDER}</span>
      </button>

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
              {user && isSelfHostedPathEnabled(`/u/${user.handle}`) && <NavLink to={`/u/${user.handle}`}>Profile</NavLink>}
              {showWriteApprovals && <NavLink to="/approvals">Write approvals</NavLink>}
              {isSelfHostedPathEnabled('/creator') && <NavLink to="/creator">Publishing insights</NavLink>}
              {isSelfHostedPathEnabled('/credits') && <NavLink to="/credits">Credits and ledger</NavLink>}
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
              Log out
            </button>
          </>
        ) : (
          <div className="mobile-drawer-grid">
            {showLogin && <NavLink to={loginTo}>{isSelfHostedEdition() ? 'Sign in' : 'Log in'}</NavLink>}
            {showRegister && <NavLink to="/register">Get started</NavLink>}
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
