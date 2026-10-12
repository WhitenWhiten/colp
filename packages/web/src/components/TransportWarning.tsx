import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { subscribeInBrowserEnabled } from '../lib/edition'
import { useToast } from './AppToast'

export type ManifestTransport = 'https' | 'insecure-http'

/**
 * Read transport from the COLP Server URI extension, or an older server's features.
 */
export function manifestTransport(body: unknown): ManifestTransport | undefined {
  const direct = readTransport(body)
  if (direct !== undefined) return direct
  if (typeof body !== 'object' || body === null) return undefined
  const mounts = (body as { mounts?: unknown }).mounts
  if (!Array.isArray(mounts)) return undefined
  for (const mount of mounts) {
    const transport = readTransport(mount)
    if (transport !== undefined) return transport
  }
  return undefined
}

function readTransport(value: unknown): ManifestTransport | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const features = record['https://know-n.com/colp/extensions/server'] ?? record.features
  if (typeof features !== 'object' || features === null) return undefined
  const transport = (features as { transport?: unknown }).transport
  if (transport === 'https' || transport === 'insecure-http') return transport
  return undefined
}

/** Hidden until D8 sets `subscribeInBrowserEnabled`. */
export function SubscribeInBrowserButton() {
  if (!subscribeInBrowserEnabled) return null
  return (
    <button type="button" className="btn btn-ghost btn-sm">
      Subscribe in browser
    </button>
  )
}

const PLAIN_HTTP_WARNING = 'This server uses plain HTTP, so passwords and bookmarks travel unencrypted.'
const WARNED_KEY = 'colp.plain-http-warned'
/** Pages where a password is typed: the warning shows on every visit to them. */
const PASSWORD_PATHS = new Set(['/login', '/register'])

function warnedThisSession(): boolean {
  try {
    return sessionStorage.getItem(WARNED_KEY) === '1'
  } catch {
    return false
  }
}

function rememberWarned(): void {
  try {
    sessionStorage.setItem(WARNED_KEY, '1')
  } catch {
    // Without storage the warning shows again on the next page load.
  }
}

/**
 * Plain-HTTP warning (02-plan §7, D9) as a warning toast instead of a band
 * above every page: once per tab session, and again on each visit to a page
 * where the password is typed. About keeps the transport visible for good.
 * A failed or unrecognised manifest shows nothing. Unit tests pass
 * `loadManifest` so the page does not call fetch under the suite's
 * undeclared-request guard.
 */
export function SiteTransportWarning({
  loadManifest = loadCollectionProtocolManifest,
}: {
  readonly loadManifest?: () => Promise<unknown>
} = {}) {
  const transport = useManifestTransport(loadManifest)
  const { pathname } = useLocation()
  const { warning } = useToast()
  const passwordPage = PASSWORD_PATHS.has(pathname)
  useEffect(() => {
    if (transport !== 'insecure-http') return
    if (!passwordPage && warnedThisSession()) return
    rememberWarned()
    warning(PLAIN_HTTP_WARNING)
  }, [transport, passwordPage, pathname, warning])
  return null
}

let manifestRequest: Promise<unknown> | undefined

/** One Manifest request per page load; the warning stays mounted across routes. */
function loadCollectionProtocolManifest(): Promise<unknown> {
  // Vitest replaces fetch with a guard that fails the test. The warning is
  // covered by its own test, which injects the manifest.
  if (import.meta.env.MODE === 'test') return Promise.resolve(undefined)
  manifestRequest ??= fetch('/.well-known/collection-protocol')
    .then(async (response) => (response.ok ? response.json() as Promise<unknown> : undefined))
    .catch(() => undefined)
  return manifestRequest
}

function useManifestTransport(loadManifest: () => Promise<unknown>): ManifestTransport | undefined {
  const [transport, setTransport] = useState<ManifestTransport | undefined>(undefined)
  useEffect(() => {
    let active = true
    void loadManifest().then((body) => {
      if (active && body !== undefined) setTransport(manifestTransport(body))
    }).catch(() => undefined)
    return () => {
      active = false
    }
  }, [loadManifest])
  return transport
}
