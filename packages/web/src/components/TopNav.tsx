import { Suspense, useEffect, useRef, useState } from 'react'
import { NavLink, Link, useLocation, useNavigate } from 'react-router-dom'
import { Brand } from './Brand'
import { Icon } from './Icon'
import { useAuth } from '../auth/AuthContext'
import { useToast } from './AppToast'
import { OPEN_SEARCH_PALETTE_EVENT } from '../lib/searchPaletteEvents'
import { SITE_SEARCH_PLACEHOLDER } from '../lib/searchCopy'
import { isCommunityExposureEnabled, isLive, isNotificationExposureEnabled, isWriteApprovalsExposureEnabled } from '../api'
// Straight from the flag module: route tests that mock the '../api' barrel
// keep their tool list.
import { isAiOrganizeExposureEnabled, isClassifyInboxExposureEnabled, isLinkHealthExposureEnabled } from '../api/featureFlags'
import { useServerFeatureUnavailable } from '../lib/serverFeatureAvailability'
import { useUnreadCount } from '../lib/unreadBadgeStore'
import { useBodyScrollLock } from '../lib/useBodyScrollLock'
import { useExitAnimation } from '../lib/useExitAnimation'
import { useFocusTrap } from '../lib/useFocusTrap'
import { APP_NAV, MARKETING_NAV, isAppNavActive, isAuthPath, loginPath } from '../lib/chrome'
import { isSelfHostedEdition, isSelfHostedPathEnabled } from '../lib/edition'
import { searchShortcutLabel } from '../lib/shortcutLabel'
import { useSettingsDialog } from '../lib/useSettingsDialog'
import { AccountMenu } from './topnav/AccountMenu'
import { MobileDrawer } from './topnav/MobileDrawer'
import { ToolsMenu, type ToolItem } from './topnav/ToolsMenu'
import { prefetchRoute } from './topnav/prefetch'
import { lazyWithRetry } from '../lib/lazyWithRetry'

const SearchPalette = lazyWithRetry('SearchPalette', async () => (await import('./SearchPalette')).SearchPalette)

const SESSION_TOOLS = [
  { to: '/extension', label: 'Extension' },
  { to: '/sync', label: 'Sync center' },
  { to: '/classify', label: 'Classify inbox' },
  { to: '/library/health', label: 'Link health' },
  { to: '/import', label: 'Import' },
  { to: '/ai/organize', label: 'AI organize' },
] as const

/* Links are not authorization: the console pages server-403 into a
   forbidden RouteState for non-reviewers, so the entries are safe to
   list for any signed-in user (same posture the cases page lede states). */
const GOVERNANCE_TOOLS = [
  { to: '/moderation/reports', label: 'My content reports', group: 'Moderation' },
  { to: '/moderation/appeals', label: 'My appeals', group: 'Moderation' },
  { to: '/admin/moderation/cases', label: 'Moderation cases', group: 'Moderation' },
  { to: '/admin/moderation/appeals', label: 'Moderation appeals', group: 'Moderation' },
] as const

const GUEST_TOOLS = SESSION_TOOLS.filter((item) => item.to === '/extension')

/** Client exposure flags for tools whose pages otherwise render "not
    available yet" (Batch classification is gated the same way in Classify). */
const TOOL_EXPOSURE: Partial<Record<string, () => boolean>> = {
  '/classify': isClassifyInboxExposureEnabled,
  '/library/health': isLinkHealthExposureEnabled,
  '/ai/organize': isAiOrganizeExposureEnabled,
}

function navClass(to: string, pathname: string) {
  return isAppNavActive(to, pathname) ? 'is-active' : undefined
}

export function TopNav() {
  const [searchOpen, setSearchOpen] = useState(false)
  /* R15-27: the palette chunk loads on first open (⌘K or a click) and then
     stays mounted so its close animation and state survive. */
  const [searchLoaded, setSearchLoaded] = useState(false)
  if (searchOpen && !searchLoaded) setSearchLoaded(true)
  const [menuOpen, setMenuOpen] = useState(false)
  const [accountOpen, setAccountOpen] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(false)
  const accountTriggerRef = useRef<HTMLButtonElement>(null)
  const toolsTriggerRef = useRef<HTMLButtonElement>(null)
  const burgerRef = useRef<HTMLButtonElement>(null)
  const { open: openSettings } = useSettingsDialog()
  const location = useLocation()
  const navigate = useNavigate()
  const { user, isLoggedIn, logout } = useAuth()
  const { toast, error: toastError } = useToast()
  const notificationExposure = isLoggedIn && isNotificationExposureEnabled()
  const communityExposure = isLoggedIn && isCommunityExposureEnabled()
  const writeApprovalsExposure = isLoggedIn && isWriteApprovalsExposureEnabled()
  /* One bell means "anything new to read": UnreadBadgeFeed merges the
     activity and community unread streams once for both navs. */
  const published = useUnreadCount()
  const mergedUnread = notificationExposure || communityExposure ? published : 0
  const notificationLabel = mergedUnread > 0
    ? `Notifications, ${mergedUnread} unread`
    : 'Notifications'
  const unreadCount = notificationExposure || communityExposure ? mergedUnread : null
  const [scrolled, setScrolled] = useState(false)
  useBodyScrollLock(menuOpen)
  // Exit phase: the drawer stays mounted one beat with .is-closing so its
  // fade-out can play. The fullscreen menu chrome must also hold
  // (.is-menu-open) until the drawer has finished leaving.
  const { mounted: menuMounted, closing: menuClosing } = useExitAnimation(menuOpen)
  const drawerTrapRef = useFocusTrap<HTMLElement>(menuMounted && !menuClosing)
  // Feature-off dead ends: entries whose client flag is off are hidden;
  // Sync's availability is only known after its first request, so it stays
  // listed and turns "Not available" once the server said so.
  const syncUnavailable = useServerFeatureUnavailable('sync')
  const sessionTools: ToolItem[] = SESSION_TOOLS
    .filter((item) => isSelfHostedPathEnabled(item.to))
    .filter((item) => TOOL_EXPOSURE[item.to]?.() ?? true)
    .map((item) => (item.to === '/sync' && syncUnavailable ? { ...item, unavailable: true } : item))
  const governanceTools = GOVERNANCE_TOOLS.filter((item) => isSelfHostedPathEnabled(item.to))
  const toolItems = isLoggedIn
    ? (isLive('contentGovernance') ? [...sessionTools, ...governanceTools] : sessionTools)
    : GUEST_TOOLS.filter((item) => isSelfHostedPathEnabled(item.to))

  const authRoute = isAuthPath(location.pathname)
  const showChrome = !authRoute
  const navItems = (isLoggedIn ? APP_NAV : MARKETING_NAV).filter((item) => isSelfHostedPathEnabled(item.to))
  const primaryNav = isSelfHostedEdition() && isLoggedIn
    ? [...navItems, { to: '/agents', label: 'Agents' }]
    : navItems
  const showLogin = !isLoggedIn && location.pathname !== '/login'
  const showRegister = !isLoggedIn && location.pathname !== '/register'

  useEffect(() => {
    const sync = () => setScrolled(window.scrollY > 8)
    sync()
    window.addEventListener('scroll', sync, { passive: true })
    return () => window.removeEventListener('scroll', sync)
  }, [])

  useEffect(() => {
    setMenuOpen(false)
    setAccountOpen(false)
    setToolsOpen(false)
  }, [location.pathname])

  useEffect(() => {
    const openSearch = () => setSearchOpen(true)
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOpen(true)
      }
      if (e.key === 'Escape') {
        setSearchOpen(false)
        // APG disclosure: closing a nav overlay returns focus to the trigger
        // that opened it — previously the menus closed but focus was left
        // floating on a removed panel.
        if (accountOpen) accountTriggerRef.current?.focus({ preventScroll: true })
        if (toolsOpen) toolsTriggerRef.current?.focus({ preventScroll: true })
        if (menuOpen) burgerRef.current?.focus({ preventScroll: true })
        setMenuOpen(false)
        setAccountOpen(false)
        setToolsOpen(false)
      }
    }
    window.addEventListener(OPEN_SEARCH_PALETTE_EVENT, openSearch)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener(OPEN_SEARCH_PALETTE_EVENT, openSearch)
      window.removeEventListener('keydown', onKey)
    }
  }, [accountOpen, toolsOpen, menuOpen])

  async function signOut() {
    const outcome = await logout()
    setAccountOpen(false)
    setMenuOpen(false)
    if (outcome === 'failed') {
      // R15-21: never claim a sign-out the server did not confirm.
      toastError("Couldn't sign out. You may still be signed in on this device.", {
        action: { label: 'Retry', onClick: () => void signOut() },
      })
      return
    }
    toast('Signed out')
    navigate('/')
  }

  const topNavClasses = [
    scrolled ? 'topnav is-scrolled' : 'topnav',
    menuMounted ? 'is-menu-open' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <>
      <header ref={drawerTrapRef} className={topNavClasses}>
        <div className="topnav-inner">
          <Brand />
          {showChrome && (
            <nav className="nav-links" aria-label="Primary">
              {primaryNav.map((l) => (
                <NavLink
                  key={l.to}
                  to={l.to}
                  end={l.to !== '/library'}
                  className={() => {
                    const active = navClass(l.to, location.pathname)
                    /* Today is BottomNav's first destination and the desktop
                       primary's first item — keep it in the 720–1099 core row
                       so tablet chrome does not drop the product's lead tab. */
                    const slot = l.to === '/today' || l.to === '/explore' || l.to === '/library' || l.to === '/agents'
                      ? 'nav-link-core'
                      : 'nav-link-rest'
                    return [active, slot].filter(Boolean).join(' ')
                  }}
                  aria-current={isAppNavActive(l.to, location.pathname) ? 'page' : undefined}
                  onPointerEnter={() => prefetchRoute(l.to)}
                  onFocus={() => prefetchRoute(l.to)}
                >
                  {l.label}
                </NavLink>
              ))}
            </nav>
          )}
          <div className="nav-actions">
            {showChrome && (
              <button
                type="button"
                className="nav-search"
                aria-haspopup="dialog"
                aria-expanded={searchOpen}
                onClick={() => setSearchOpen(true)}
              >
                <span>{SITE_SEARCH_PLACEHOLDER}</span>
                <kbd>{searchShortcutLabel()}</kbd>
              </button>
            )}

            {showChrome && (
              <button
                type="button"
                className="nav-search-compact"
                aria-label={isSelfHostedEdition() ? 'Search' : 'Search Know-N'}
                aria-haspopup="dialog"
                aria-expanded={searchOpen}
                onClick={() => setSearchOpen(true)}
              >
                <Icon name="search" />
              </button>
            )}

            {showChrome && (
              <ToolsMenu
                items={toolItems}
                open={toolsOpen}
                triggerRef={toolsTriggerRef}
                onToggle={() => {
                  setAccountOpen(false)
                  setMenuOpen(false)
                  setToolsOpen((v) => !v)
                }}
                onClose={() => setToolsOpen(false)}
              />
            )}

            {isLoggedIn && isSelfHostedPathEnabled('/notifications') && (
              <Link
                to="/notifications"
                className="nav-icon-btn"
                aria-label={notificationLabel}
                title={notificationLabel}
              >
                <Icon name="bell" />
                {mergedUnread > 0 && <span className="badge-dot" aria-hidden />}
              </Link>
            )}

            {isLoggedIn && user ? (
              <AccountMenu
                user={user}
                unreadCount={unreadCount}
                showWriteApprovals={writeApprovalsExposure}
                open={accountOpen}
                triggerRef={accountTriggerRef}
                onToggle={() => {
                  setToolsOpen(false)
                  setAccountOpen((v) => !v)
                }}
                onClose={() => setAccountOpen(false)}
                onOpenSettings={() => { accountTriggerRef.current?.focus({ preventScroll: true }); openSettings('profile') }}
                onSignOut={() => {
                  void signOut()
                }}
              />
            ) : (
              <>
                {showLogin && (
                  <Link to={loginPath(location.pathname, location.search)} className="btn btn-ghost btn-sm">
                    Log in
                  </Link>
                )}
                {showRegister && (
                  <Link to="/register" className="btn btn-primary btn-sm">
                    Get started
                  </Link>
                )}
              </>
            )}

            {showChrome && (
              <button
                type="button"
                ref={burgerRef}
                className="nav-burger"
                aria-label={menuOpen ? 'Close menu' : 'Open menu'}
                aria-expanded={menuOpen}
                aria-controls="mobile-navigation"
                onClick={() => {
                  setToolsOpen(false)
                  setAccountOpen(false)
                  setMenuOpen((v) => !v)
                }}
              >
                <Icon name={menuOpen ? 'cross' : 'lines'} />
              </button>
            )}
          </div>
        </div>

        {menuMounted && showChrome && (
          <MobileDrawer
            toolItems={toolItems}
            isLoggedIn={isLoggedIn}
            user={user}
            showWriteApprovals={writeApprovalsExposure}
            showLogin={showLogin}
            loginTo={loginPath(location.pathname, location.search)}
            showRegister={showRegister}
            closing={menuClosing}
            onOpenSearch={() => {
              burgerRef.current?.focus({ preventScroll: true })
              setMenuOpen(false)
              setSearchOpen(true)
            }}
            onOpenSettings={() => {
              burgerRef.current?.focus({ preventScroll: true })
              setMenuOpen(false)
              openSettings('profile')
            }}
            onSignOut={() => {
              void signOut()
            }}
          />
        )}
      </header>

      {searchLoaded && (
        <Suspense fallback={null}>
          <SearchPalette open={searchOpen} onClose={() => setSearchOpen(false)} />
        </Suspense>
      )}
    </>
  )
}
