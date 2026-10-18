const AUTH_PATHS = [
  '/login',
  '/consent',
  '/register',
  '/auth/recovery',
] as const

/** Primary navigation for a signed-in owner; a guest can only sign in. */
export const APP_NAV = [
  { to: '/library', label: 'Library' },
  // The Sync center: every syncing browser, its conflicts and what was deleted.
  { to: '/sync', label: 'Sync' },
  { to: '/agents', label: 'Agents' },
  // P2: "I approve once … with Undo on the approvals page" — the page an
  // agent sends the owner to must be one click away, not inside a menu.
  { to: '/approvals', label: 'Approvals' },
] as const

/** Shown before Agents once the server says it offers automations. */
export const AUTOMATIONS_NAV = { to: '/automations', label: 'Automations' } as const

export type AppNavPath = (typeof APP_NAV)[number]['to'] | typeof AUTOMATIONS_NAV.to

export type AppNavItem = { readonly to: AppNavPath; readonly label: string }

/** What the server offers: Automations shows once it said yes, Sync leaves
    once it said no (its availability is only known after the first read). */
export type AppNavFeatures = { readonly automations: boolean; readonly sync: boolean }

/** The signed-in primary nav. Sync holds second place whether or not the
    server has automations, so its tab does not move between servers. */
export function appNav({ automations, sync }: AppNavFeatures): readonly AppNavItem[] {
  return APP_NAV.flatMap((item): AppNavItem[] => {
    if (item.to === '/sync') return sync ? [item] : []
    if (item.to === '/agents' && automations) return [AUTOMATIONS_NAV, item]
    return [item]
  })
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
