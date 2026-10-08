import { useEffect, useState } from 'react'
import { isSelfHostedEdition, subscribeInBrowserEnabled } from '../lib/edition'

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

export function TransportBanner({ transport }: { readonly transport: ManifestTransport | undefined }) {
  if (transport !== 'insecure-http') return null
  return (
    <p className="transport-banner" role="status" data-testid="transport-banner">
      This server is using insecure HTTP. Credentials and bookmarks travel unencrypted.
    </p>
  )
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

/**
 * Persistent banner for every page of the self-hosted web UI, including sign-in
 * where the password is typed (02-plan §7, D9). A failed or unrecognised
 * manifest leaves the page unchanged. Unit tests pass `loadManifest` so the
 * page does not call fetch under the suite's undeclared-request guard.
 */
export function SiteTransportBanner({
  loadManifest = loadCollectionProtocolManifest,
}: {
  readonly loadManifest?: () => Promise<unknown>
} = {}) {
  if (!isSelfHostedEdition()) return null
  return <LoadedTransportBanner loadManifest={loadManifest} />
}

function LoadedTransportBanner({ loadManifest }: { readonly loadManifest: () => Promise<unknown> }) {
  const transport = useManifestTransport(loadManifest)
  return <TransportBanner transport={transport} />
}

let manifestRequest: Promise<unknown> | undefined

/** One Manifest request per page load; the banner stays mounted across routes. */
function loadCollectionProtocolManifest(): Promise<unknown> {
  // Vitest replaces fetch with a guard that fails the test. The banner is
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
