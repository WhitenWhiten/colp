import { NavLink } from 'react-router-dom'
import { Icon } from '../Icon'
import { SITE_SEARCH_PLACEHOLDER } from '../../lib/searchCopy'
import { prefetchRoute } from './prefetch'
import type { ToolItem } from './ToolsMenu'

type Props = {
  activityAvailable?: boolean
  toolItems: readonly ToolItem[]
  /** Exit phase: plays the drawer lift before unmount. */
  closing: boolean
  onOpenSearch: () => void
  onOpenSettings: () => void
  onSignOut: () => void
}

/** Top-anchored mobile drawer for the signed-in owner: search, tools, and
   account. Primary destinations live on BottomNav; a guest gets neither
   (Sign in sits in the bar). Route changes close it via the parent (TopNav
   resets on pathname). */
export function MobileDrawer({
  activityAvailable = false,
  toolItems,
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
            {items.map((item) => (
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
        <div className="mobile-drawer-grid">
          {activityAvailable && <NavLink to="/activity" onPointerEnter={() => prefetchRoute('/activity')} onFocus={() => prefetchRoute('/activity')}>Activity</NavLink>}
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
