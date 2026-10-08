import { useEffect, useState } from 'react'
import { subscribeInBrowserEnabled } from '../lib/edition'

export type ManifestTransport = 'https' | 'insecure-http'

/** Read `features.transport` from a collection-protocol manifest document. */
export function manifestTransport(body: unknown): ManifestTransport | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const features = (body as { features?: unknown }).features
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
 * Banner for the public collection page. A failed or unrecognised manifest
 * leaves the page unchanged.
 */
export function CollectionTransportNotice() {
  const transport = useManifestTransport()
  return <TransportBanner transport={transport} />
}

function useManifestTransport(): ManifestTransport | undefined {
  const [transport, setTransport] = useState<ManifestTransport | undefined>(undefined)
  useEffect(() => {
    const controller = new AbortController()
    let active = true
    void fetch('/.well-known/collection-protocol', { signal: controller.signal })
      .then(async (response) => (response.ok ? response.json() as Promise<unknown> : undefined))
      .then((body) => {
        if (active && body !== undefined) setTransport(manifestTransport(body))
      })
      .catch(() => undefined)
    return () => {
      active = false
      controller.abort()
    }
  }, [])
  return transport
}
