const AUTH_PATHS = [
  '/login',
  '/consent',
  '/register',
  '/auth/recovery',
] as const

/** Primary navigation for a signed-in owner; a guest can only sign in. */
export const APP_NAV = [
  { to: '/library', label: 'Library' },
  { to: '/agents', label: 'Agents' },
] as const

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
