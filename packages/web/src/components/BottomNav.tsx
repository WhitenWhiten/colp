import { NavLink, useLocation } from 'react-router-dom'
import { Icon, type IconName } from './Icon'
import { useAuth } from '../auth/AuthContext'
import { appNav, isAppNavActive, type AppNavPath } from '../lib/chrome'
import { useAutomationStatus } from '../lib/automationStatus'
import { useServerFeatureUnavailable } from '../lib/serverFeatureAvailability'
import { prefetchRoute } from './topnav/prefetch'

// The tabs are the desktop nav (lib/chrome.ts), each with its icon.
const TAB_ICONS: Readonly<Record<AppNavPath, IconName>> = {
  '/library': 'bookmark',
  '/sync': 'sync',
  '/automations': 'bolt',
  '/agents': 'terminal',
  '/approvals': 'check',
}

/** Persistent ≤719px primary destinations of the signed-in owner. Hidden on
    desktop via CSS. A visitor on a shared link has no destinations here; a
    bar holding only Sign in (already in the top bar) would cover the page. */
export function BottomNav() {
  const location = useLocation()
  const { isLoggedIn, user } = useAuth()
  const automation = useAutomationStatus(isLoggedIn ? user?.accountId ?? null : null)
  const syncUnavailable = useServerFeatureUnavailable('sync')
  if (!isLoggedIn) return null
  const tabs = appNav({ automations: automation.state === 'available', sync: !syncUnavailable })
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
              <Icon name={TAB_ICONS[tab.to]} />
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
