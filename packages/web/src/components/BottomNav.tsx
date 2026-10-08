import { NavLink, useLocation } from 'react-router-dom'
import { Icon, type IconName } from './Icon'
import { useAuth } from '../auth/AuthContext'
import { isCommunityExposureEnabled, isNotificationExposureEnabled } from '../api'
import { useUnreadCount } from '../lib/unreadBadgeStore'
import { isAppNavActive, loginPath } from '../lib/chrome'
import { isSelfHostedEdition, isSelfHostedPathEnabled } from '../lib/edition'
import { prefetchRoute } from './topnav/prefetch'

type TabItem = { to: string; label: string; icon: IconName }

const GUEST_TABS: readonly TabItem[] = [
  { to: '/explore', label: 'Explore', icon: 'compass' },
  { to: '/login', label: 'Log in', icon: 'person' },
]

function sessionTabs(handle: string | undefined): TabItem[] {
  const tabs: TabItem[] = [
    // Same order as the desktop nav (lib/chrome.ts): Today, Explore, Library.
    { to: '/today', label: 'Today', icon: 'book' },
    { to: '/explore', label: 'Explore', icon: 'compass' },
    { to: '/library', label: 'Library', icon: 'bookmark' },
    { to: '/notifications', label: 'Notifications', icon: 'bell' },
  ]
  if (handle) tabs.push({ to: `/u/${handle}`, label: 'Profile', icon: 'person' })
  return tabs
}

/** Persistent ≤719px primary destinations. Hidden on desktop via CSS. */
export function BottomNav() {
  const location = useLocation()
  const { user, isLoggedIn } = useAuth()
  const notificationExposure = isLoggedIn && isNotificationExposureEnabled()
  const communityExposure = isLoggedIn && isCommunityExposureEnabled()
  // Published once by UnreadBadgeFeed (R15-27).
  const published = useUnreadCount()
  const unreadCount = notificationExposure || communityExposure ? published : 0
  const tabs = (isLoggedIn
    ? sessionTabs(user?.handle)
    : GUEST_TABS.map((tab) =>
        tab.to === '/login'
          ? { ...tab, to: loginPath(location.pathname, location.search), label: isSelfHostedEdition() ? 'Sign in' : tab.label }
          : tab,
      )).filter((tab) => isSelfHostedPathEnabled(tab.to))
  const visibleTabs = isSelfHostedEdition() && isLoggedIn
    ? [...tabs, { to: '/agents', label: 'Agents', icon: 'terminal' as const }]
    : tabs

  return (
    <nav className="bottom-nav" aria-label="Mobile primary">
      {visibleTabs.map((tab) => {
        const current = isAppNavActive(tab.to, location.pathname)
        const notify = tab.to === '/notifications'
        return (
          <NavLink
            key={tab.label}
            to={tab.to}
            end={tab.to !== '/library'}
            className={() => ['bottom-nav-item', current ? 'is-active' : ''].filter(Boolean).join(' ')}
            aria-current={current ? 'page' : undefined}
            aria-label={notify && unreadCount > 0
              ? `Notifications, ${unreadCount} unread`
              : undefined}
            onPointerEnter={() => prefetchRoute(tab.to)}
            onFocus={() => prefetchRoute(tab.to)}
          >
            <span className="bottom-nav-icon">
              <Icon name={tab.icon} />
              {notify && unreadCount > 0
                ? <span className="badge-dot" aria-hidden data-testid="notifications-badge-dot" />
                : null}
            </span>
            <span className="bottom-nav-label" data-testid="bottom-nav-label">{tab.label}</span>
          </NavLink>
        )
      })}
    </nav>
  )
}
