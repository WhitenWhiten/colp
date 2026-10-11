import { NavLink, useLocation } from 'react-router-dom'
import { Icon, type IconName } from './Icon'
import { useAuth } from '../auth/AuthContext'
import { isAppNavActive, loginPath } from '../lib/chrome'
import { prefetchRoute } from './topnav/prefetch'

type TabItem = { to: string; label: string; icon: IconName }

// Same order as the desktop nav (lib/chrome.ts).
const SESSION_TABS: readonly TabItem[] = [
  { to: '/library', label: 'Library', icon: 'bookmark' },
  { to: '/agents', label: 'Agents', icon: 'terminal' },
  { to: '/approvals', label: 'Approvals', icon: 'check' },
]

/** Persistent ≤719px primary destinations. Hidden on desktop via CSS. */
export function BottomNav() {
  const location = useLocation()
  const { isLoggedIn } = useAuth()
  const tabs: readonly TabItem[] = isLoggedIn
    ? SESSION_TABS
    : [{ to: loginPath(location.pathname, location.search), label: 'Sign in', icon: 'person' }]

  return (
    <nav className="bottom-nav" aria-label="Mobile primary">
      {tabs.map((tab) => {
        const current = isAppNavActive(tab.to, location.pathname)
        return (
          <NavLink
            key={tab.label}
            to={tab.to}
            end={tab.to !== '/library'}
            className={() => ['bottom-nav-item', current ? 'is-active' : ''].filter(Boolean).join(' ')}
            aria-current={current ? 'page' : undefined}
            onPointerEnter={() => prefetchRoute(tab.to)}
            onFocus={() => prefetchRoute(tab.to)}
          >
            <span className="bottom-nav-icon">
              <Icon name={tab.icon} />
            </span>
            <span className="bottom-nav-label" data-testid="bottom-nav-label">{tab.label}</span>
          </NavLink>
        )
      })}
    </nav>
  )
}
