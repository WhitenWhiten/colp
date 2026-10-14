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
  // P2: "I approve once … with Undo on the approvals page" — the page an
  // agent sends the owner to must be one click away, not inside a menu.
  { to: '/approvals', label: 'Approvals' },
] as const

/** Shown after Library once the server says it offers automations. */
export const AUTOMATIONS_NAV = { to: '/automations', label: 'Automations' } as const

export type AppNavItem = { readonly to: string; readonly label: string }

/** The signed-in primary nav, with Automations next to Agents when the server has it. */
export function appNav(automations: boolean): readonly AppNavItem[] {
  if (!automations) return APP_NAV
  const [library, ...rest] = APP_NAV
  return [library, AUTOMATIONS_NAV, ...rest]
}

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
