import { Suspense, useEffect, useRef, useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { TopNav } from './TopNav'
import { BottomNav } from './BottomNav'
import { Footer } from './Footer'
import { ScrollProgress } from './ScrollProgress'
import { ScrollToTopButton } from './ScrollToTopButton'
import { TooltipHost } from './TooltipHost'
import { NavigationScrollManager } from './NavigationScrollManager'
import { ToastProvider, ToastRouteReset } from './AppToast'
import { ConfirmProvider } from './ConfirmModal'
import { AuthProvider } from '../auth/AuthContext'
import { RouteLoading } from './RouteLoading'
import { ChromeErrorBoundary } from './ChromeErrorBoundary'
import { RouteErrorBoundary } from './RouteErrorBoundary'
import { ServiceStatusBanner } from './ServiceStatusBanner'
import { SiteTransportBanner } from './TransportBanner'
import { UnreadBadgeFeedHost } from './UnreadBadgeFeedHost'
import { isAuthPath } from '../lib/chrome'
import { productName } from '../lib/edition'
import { isLibraryDeskPath, isLibraryDeskToDesk, libraryDeskKey } from '../lib/libraryDesk'
import { navigateWithViewTransition } from '../lib/viewTransitions'
import { requestInternalNavigation } from '../lib/navigationGuard'
import { SettingsDialogHost } from './settings/SettingsDialogHost'
import { latestDocumentTitle, subscribeDocumentTitle } from '../lib/useDocumentTitle'

function useOnlineStatus() {
  const [online, setOnline] = useState(
    () => (typeof navigator === 'undefined' ? true : navigator.onLine),
  )

  useEffect(() => {
    const goOnline = () => setOnline(true)
    const goOffline = () => setOnline(false)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [])

  return online
}

function depthOf(path: string) {
  return path.split('/').filter(Boolean).length
}

/** Collection share and Digest `?embed=1` pages render in iframes: strip all
   chrome so only the embed card remains. */
function isShareEmbedPath(pathname: string, search: string): boolean {
  if (new URLSearchParams(search).get('embed') !== '1') return false
  return /^\/share\/[^/]+\/?$/u.test(pathname)
    || /^\/reports\/[^/]+(?:\/issues\/[^/]+)?\/?$/u.test(pathname)
}

export function Layout() {
  const location = useLocation()
  const navigate = useNavigate()
  const online = useOnlineStatus()
  const prevPathRef = useRef(location.pathname)
  const mainRef = useRef<HTMLElement>(null)
  /* The pageKey whose route change was already announced. A boolean flag cannot
     express "skip the first route" under StrictMode: the effect runs, is cleaned
     up, and runs again, so the first run consumes the flag and the second
     focuses `main` — which on the landing page is the exact non-zero progress
     bar the preventScroll comment below exists to avoid. Comparing the key is
     idempotent across the double invocation. */
  const announcedPageKeyRef = useRef<string | null>(null)
  /* Set on the first route change; the first route is never announced. */
  const navigatedRef = useRef(false)
  const [direction, setDirection] = useState<'forward' | 'back'>('forward')
  const [routeAnnouncement, setRouteAnnouncement] = useState('')
  const pageKey = libraryDeskKey(location.pathname)
  /* R15-37: the title sequence when this page first rendered. Titles the
     new page publishes (in child effects, after this render) are newer;
     the old page's cleanup restore is never published. */
  const [titleMark, setTitleMark] = useState(() => ({ pageKey, seq: latestDocumentTitle().seq }))
  if (titleMark.pageKey !== pageKey) setTitleMark({ pageKey, seq: latestDocumentTitle().seq })

  /* Route internal link clicks through the View Transitions API (capture
     phase, so preventDefault runs before the browser follows the href).
     Do not stop propagation — React onClick on <Link> must still run.
     React Router then skips its own navigate because defaultPrevented.
     Modifier-clicks, new-tab targets, downloads and external/hash hrefs pass through. */
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0
        || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const anchor = (event.target as Element | null)?.closest?.('a[href]')
      if (!(anchor instanceof HTMLAnchorElement)) return
      if (anchor.target || anchor.hasAttribute('download')) return
      const href = anchor.getAttribute('href') ?? ''
      if (!href.startsWith('/')) return
      if (href === location.pathname + location.search) return
      event.preventDefault()
      if (!requestInternalNavigation()) return
      if (isLibraryDeskToDesk(location.pathname, href)) navigate(href)
      else navigateWithViewTransition(navigate, href)
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [navigate, location.pathname, location.search])

  useEffect(() => {
    const previous = prevPathRef.current
    const prev = depthOf(previous)
    const curr = depthOf(location.pathname)
    prevPathRef.current = location.pathname
    if (isLibraryDeskPath(previous) && isLibraryDeskPath(location.pathname)) return
    setDirection(curr >= prev ? 'forward' : 'back')
  }, [location.pathname])

  useEffect(() => {
    if (announcedPageKeyRef.current === pageKey) return
    const isFirstRoute = announcedPageKeyRef.current === null
    announcedPageKeyRef.current = pageKey
    if (isFirstRoute) return
    navigatedRef.current = true
    /* preventScroll: html uses smooth scrolling, so focusing main after
       a route change would ease the page down a few pixels. On the landing
       sticky hero that reads as a non-zero progress bar and a paper sliver. */
    mainRef.current?.focus({ preventScroll: true })
  }, [pageKey])

  /* R15-37: announce the first title the new page sets. A lazy route sets
     it only once its chunk has loaded, and the old page's cleanup restores
     a stale title first, so wait for a title published on this page rather
     than reading document.title. Idempotent under StrictMode re-runs. */
  useEffect(() => {
    if (!navigatedRef.current) return
    const since = titleMark.seq
    const announce = (title: string) => setRouteAnnouncement(
      title.replace(/\s+[—–-]\s+(?:Know-N|COLP Server)\s*$/u, '').trim() || productName())
    const current = latestDocumentTitle()
    if (current.seq > since) {
      announce(current.title)
      return
    }
    let done = false
    const unsubscribe = subscribeDocumentTitle((published) => {
      if (done || published.seq <= since) return
      done = true
      announce(published.title)
    })
    // A page that never sets a title still gets announced.
    const fallback = window.setTimeout(() => {
      if (!done) announce(document.title)
      done = true
    }, 1_500)
    return () => {
      unsubscribe()
      window.clearTimeout(fallback)
    }
  }, [pageKey, titleMark.seq])

  const pageClass = `page page-enter page-enter-${direction}`
  const embed = isShareEmbedPath(location.pathname, location.search)
  const showTabs = !embed && !isAuthPath(location.pathname)
  const shellClass = [
    'app-shell',
    embed ? 'app-shell--embed' : '',
    showTabs ? 'app-shell--tabs' : '',
  ].filter(Boolean).join(' ')

  return (
    <AuthProvider>
      {/* Toast lives inside the shell so ≤719 stacking can inherit
          --bottom-nav-h from .app-shell--tabs. */}
      <div className={shellClass}>
        <ToastProvider>
          {/* R9-19: one promise-based destructive-confirm host for every
              workflow under the shell (replaces window.confirm). */}
          <ConfirmProvider>
            {!embed && (
              <a className="skip-link" href="#main">
                Skip to content
              </a>
            )}
            {!embed && (
              <div className="visually-hidden" aria-live="polite" aria-atomic="true">
                {routeAnnouncement}
              </div>
            )}
            <NavigationScrollManager />
            <ToastRouteReset />
            {!embed && !online && (
              <div className="offline-banner" role="status">
                You&apos;re offline. Saving is paused — reconnect to continue.
              </div>
            )}
            {!embed && online && <ServiceStatusBanner />}
            {!embed && <SiteTransportBanner />}
            {!embed && (
              <ChromeErrorBoundary name="TopNav">
                <TopNav />
              </ChromeErrorBoundary>
            )}
            {!embed && <ScrollProgress />}
            <main id="main" ref={mainRef} className={pageClass} key={pageKey} tabIndex={-1}>
              <RouteErrorBoundary resetKey={pageKey}>
                <Suspense fallback={<RouteLoading />}>
                  <Outlet />
                </Suspense>
              </RouteErrorBoundary>
            </main>
            {!embed && (
              <ChromeErrorBoundary name="SettingsDialogHost">
                <SettingsDialogHost />
              </ChromeErrorBoundary>
            )}
            <TooltipHost />
            {!embed && (
              <ChromeErrorBoundary name="Footer">
                <Footer />
              </ChromeErrorBoundary>
            )}
            {!embed && <ScrollToTopButton />}
            {!embed && (
              <ChromeErrorBoundary name="UnreadBadgeFeed">
                <UnreadBadgeFeedHost />
              </ChromeErrorBoundary>
            )}
            {showTabs && (
              <ChromeErrorBoundary name="BottomNav">
                <BottomNav />
              </ChromeErrorBoundary>
            )}
          </ConfirmProvider>
        </ToastProvider>
      </div>
    </AuthProvider>
  )
}
