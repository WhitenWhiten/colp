import { Suspense, useEffect, useRef, useState } from 'react'
import { NavLink, Link, useLocation, useNavigate } from 'react-router-dom'
import { Brand } from './Brand'
import { Icon } from './Icon'
import { useAuth } from '../auth/AuthContext'
import { useToast } from './AppToast'
import { OPEN_SEARCH_PALETTE_EVENT } from '../lib/searchPaletteEvents'
import { SITE_SEARCH_PLACEHOLDER } from '../lib/searchCopy'
import { useServerFeatureUnavailable } from '../lib/serverFeatureAvailability'
import { useBodyScrollLock } from '../lib/useBodyScrollLock'
import { useExitAnimation } from '../lib/useExitAnimation'
import { useFocusTrap } from '../lib/useFocusTrap'
import { appNav, isAppNavActive, isAuthPath, loginPath } from '../lib/chrome'
import { useAutomationStatus } from '../lib/automationStatus'
import { useActivityStatus } from '../lib/activityStatus'
import { searchShortcutLabel } from '../lib/shortcutLabel'
import { useSettingsDialog } from '../lib/useSettingsDialog'
import { AccountMenu } from './topnav/AccountMenu'
import { MobileDrawer } from './topnav/MobileDrawer'
import { ToolsMenu, type ToolItem } from './topnav/ToolsMenu'
import { prefetchRoute } from './topnav/prefetch'
import { lazyWithRetry } from '../lib/lazyWithRetry'

const SearchPalette = lazyWithRetry('SearchPalette', async () => (await import('./SearchPalette')).SearchPalette)

const SESSION_TOOLS = [
  { to: '/extension', label: 'Connect a browser' },
  { to: '/library/health', label: 'Link health' },
  { to: '/import', label: 'Import' },
] as const

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
  const { user, isLoggedIn, logout, sessionState } = useAuth()
  const { toast, error: toastError } = useToast()
  const [scrolled, setScrolled] = useState(false)
  useBodyScrollLock(menuOpen)
  // Exit phase: the drawer stays mounted one beat with .is-closing so its
  // fade-out can play. The fullscreen menu chrome must also hold
  // (.is-menu-open) until the drawer has finished leaving.
  const { mounted: menuMounted, closing: menuClosing } = useExitAnimation(menuOpen)
  const drawerTrapRef = useFocusTrap<HTMLElement>(menuMounted && !menuClosing)
  // Sync's availability is only known after its first request, so its entry
  // stays in the bar until the server said it has none.
  const syncUnavailable = useServerFeatureUnavailable('sync')
  // A guest can only sign in; the tools need the owner's session.
  const toolItems: readonly ToolItem[] = isLoggedIn ? SESSION_TOOLS : []

  const authRoute = isAuthPath(location.pathname)
  const showChrome = !authRoute
  // Site search covers the owner's library and answers a guest with a
  // sign-in wall, so a visitor on a shared link is not offered it.
  const showSearch = showChrome && isLoggedIn
  /* Automations appear once the server says it has them; "Paused" rides on
     the entry so a paused library is visible from every page (AU-14). */
  const automation = useAutomationStatus(isLoggedIn ? user?.accountId ?? null : null)
  const activity = useActivityStatus(isLoggedIn ? user?.accountId ?? null : null)
  const activityAvailable = isLoggedIn && activity.state === 'available'
  const primaryNav = isLoggedIn ? appNav({ automations: automation.state === 'available', sync: !syncUnavailable }) : []
  const automationsPaused = automation.state === 'available' && automation.paused
  // Sign-in and sign-up pages link to each other in their cards already.
  // While the session check fails the visitor may well be signed in, so the
  // bar offers nothing until it answers (R15-23).
  const showLogin = !isLoggedIn && !authRoute && sessionState !== 'offline'
  // The drawer holds the owner's tools and account; a visitor has none, and
  // Sign in already sits in the bar.
  const showMenu = showChrome && isLoggedIn

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

  // One gate for every entry: the buttons, ⌘/Ctrl+K and the custom event
  // all go through the same owner check, and a sign-out closes the palette.
  useEffect(() => {
    if (!showSearch) setSearchOpen(false)
  }, [showSearch])

  useEffect(() => {
    const openSearch = () => {
      if (showSearch) setSearchOpen(true)
    }
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        if (!showSearch) return
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
  }, [accountOpen, toolsOpen, menuOpen, showSearch])

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
          {/* Guests have no primary destinations: no empty landmark either. */}
          {showChrome && primaryNav.length > 0 && (
            <nav className="nav-links" aria-label="Primary">
              {primaryNav.map((l) => (
                <NavLink
                  key={l.to}
                  to={l.to}
                  end={l.to !== '/library'}
                  className={() => {
                    const active = navClass(l.to, location.pathname)
                    return [active, 'nav-link-core'].filter(Boolean).join(' ')
                  }}
                  aria-current={isAppNavActive(l.to, location.pathname) ? 'page' : undefined}
                  onPointerEnter={() => prefetchRoute(l.to)}
                  onFocus={() => prefetchRoute(l.to)}
                >
                  {l.label}
                  {l.to === '/automations' && automationsPaused && (
                    <span className="nav-link-flag" data-testid="automations-paused-flag">Paused</span>
                  )}
                </NavLink>
              ))}
            </nav>
          )}
          <div className="nav-actions">
            {showChrome && activityAvailable && (
              <button
                type="button"
                className="nav-activity"
                onClick={() => navigate('/activity')}
                aria-label={`Activity, ${activity.unreadCount} unread`}
                aria-current={location.pathname === '/activity' ? 'page' : undefined}
                onPointerEnter={() => prefetchRoute('/activity')}
                onFocus={() => prefetchRoute('/activity')}
              >
                <Icon name="bell" />
                {activity.unreadCount > 0 && <span className="count-pill" data-tone="accent" aria-hidden>{activity.unreadCount > 99 ? '99+' : activity.unreadCount}</span>}
              </button>
            )}
            {showSearch && (
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

            {showSearch && (
              <button
                type="button"
                className="nav-search-compact"
                aria-label="Search"
                aria-haspopup="dialog"
                aria-expanded={searchOpen}
                onClick={() => setSearchOpen(true)}
              >
                <Icon name="search" />
              </button>
            )}

            {showChrome && toolItems.length > 0 && (
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

            {isLoggedIn && user ? (
              <AccountMenu
                activityAvailable={activityAvailable}
                user={user}
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
              showLogin && (
                /* Quiet: a shared link's visitors read; only the owner signs in. */
                <Link to={loginPath(location.pathname, location.search)} className="btn btn-secondary btn-sm">
                  Sign in
                </Link>
              )
            )}

            {showMenu && (
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

        {menuMounted && showMenu && (
          <MobileDrawer
            activityAvailable={activityAvailable}
            toolItems={toolItems}
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

      {searchLoaded && showSearch && (
        <Suspense fallback={null}>
          <SearchPalette open={searchOpen} onClose={() => setSearchOpen(false)} />
        </Suspense>
      )}
    </>
  )
}
