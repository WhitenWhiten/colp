const AUTH_PATHS = [
  '/login',
  '/consent',
  '/register',
  '/reset-password',
  '/verify-email',
  '/auth/recovery',
] as const

export const APP_NAV = [
  { to: '/today', label: 'Today' },
  { to: '/explore', label: 'Explore' },
  { to: '/library', label: 'Library' },
] as const

export const MARKETING_NAV = [{ to: '/explore', label: 'Explore' }] as const

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])
const CANONICAL_ORIGIN = 'https://know-n.com'

export function isAuthPath(pathname: string): boolean {
  return AUTH_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`))
}

/** Sign-in link that returns to the current page. The home page and the
    auth pages themselves keep the bare /login (Login's own fallback). */
export function loginPath(pathname: string, search = ''): string {
  if (pathname === '/' || isAuthPath(pathname)) return '/login'
  return `/login?returnTo=${encodeURIComponent(pathname + search)}`
}

export function isAppNavActive(to: string, pathname: string): boolean {
  if (isAuthPath(pathname)) return false
  if (to === '/library') return pathname === '/library' || pathname.startsWith('/library/')
  return pathname === to || pathname.startsWith(`${to}/`)
}

/** Public share URLs never advertise a loopback origin. */
export function canonicalSiteOrigin(locationOrigin?: string): string {
  const origin = locationOrigin
    ?? (typeof window !== 'undefined' ? window.location.origin : '')
  if (!origin) return CANONICAL_ORIGIN
  try {
    const host = new URL(origin).hostname
    if (!host || LOCAL_HOSTS.has(host) || host.endsWith('.local')) return CANONICAL_ORIGIN
  } catch {
    return CANONICAL_ORIGIN
  }
  return origin
}
