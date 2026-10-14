import { NavLink, useLocation } from 'react-router-dom'
import { Icon, type IconName } from './Icon'
import { useAuth } from '../auth/AuthContext'
import { isAppNavActive } from '../lib/chrome'
import { useAutomationStatus } from '../lib/automationStatus'
import { prefetchRoute } from './topnav/prefetch'

type TabItem = { to: string; label: string; icon: IconName }

// Same order as the desktop nav (lib/chrome.ts).
const SESSION_TABS: readonly TabItem[] = [
  { to: '/library', label: 'Library', icon: 'bookmark' },
  { to: '/agents', label: 'Agents', icon: 'terminal' },
  { to: '/approvals', label: 'Approvals', icon: 'check' },
]

const AUTOMATIONS_TAB: TabItem = { to: '/automations', label: 'Automations', icon: 'bolt' }

/** Persistent ≤719px primary destinations of the signed-in owner. Hidden on
    desktop via CSS. A visitor on a shared link has no destinations here; a
    bar holding only Sign in (already in the top bar) would cover the page. */
export function BottomNav() {
  const location = useLocation()
  const { isLoggedIn, user } = useAuth()
  const automation = useAutomationStatus(isLoggedIn ? user?.accountId ?? null : null)
  if (!isLoggedIn) return null
  const tabs = automation.state === 'available'
    ? SESSION_TABS.flatMap((tab) => (tab.to === '/library' ? [tab, AUTOMATIONS_TAB] : [tab]))
    : SESSION_TABS
  const paused = automation.state === 'available' && automation.paused

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
              {tab.to === '/automations' && paused && <span className="bottom-nav-flag" aria-hidden />}
            </span>
            <span className="bottom-nav-label" data-testid="bottom-nav-label">{tab.label}</span>
            {tab.to === '/automations' && paused && <span className="visually-hidden">, paused</span>}
          </NavLink>
        )
      })}
    </nav>
  )
}
