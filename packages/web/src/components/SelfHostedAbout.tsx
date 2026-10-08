import { useEffect, useState } from 'react'

export type ServerAboutSnapshot = {
  readonly server: string
  readonly colp: string
  readonly protocols: string
}

export function readServerAbout(health: unknown, manifest?: unknown): ServerAboutSnapshot | null {
  if (typeof health !== 'object' || health === null) return null
  const version = (health as { version?: unknown }).version
  if (typeof version !== 'object' || version === null) return null
  const record = version as { server?: unknown; colp?: unknown; protocols?: unknown }
  if (typeof record.server !== 'string' || typeof record.colp !== 'string') return null
  const protocols = Array.isArray(record.protocols)
    ? record.protocols.filter((item): item is string => typeof item === 'string').join(' ')
    : ''
  const editionVersion = readEditionVersion(manifest)
  return {
    server: record.server,
    colp: editionVersion ?? record.colp,
    protocols,
  }
}

function readEditionVersion(manifest: unknown): string | undefined {
  if (typeof manifest !== 'object' || manifest === null) return undefined
  const mounts = (manifest as { mounts?: unknown }).mounts
  if (!Array.isArray(mounts)) return undefined
  for (const mount of mounts) {
    if (typeof mount !== 'object' || mount === null) continue
    const features = (mount as { features?: unknown }).features
    if (typeof features !== 'object' || features === null) continue
    const edition = (features as { edition?: unknown }).edition
    if (typeof edition !== 'object' || edition === null) continue
    const version = (edition as { version?: unknown }).version
    if (typeof version === 'string' && version.length > 0) return version
  }
  return undefined
}

async function loadServerAbout(): Promise<ServerAboutSnapshot | null> {
  if (import.meta.env.MODE === 'test') return null
  try {
    const healthResponse = await fetch('/health')
    const health = healthResponse.ok ? await healthResponse.json() as unknown : undefined
    const manifestResponse = await fetch('/.well-known/collection-protocol')
    const manifest = manifestResponse.ok ? await manifestResponse.json() as unknown : undefined
    return readServerAbout(health, manifest)
  } catch {
    return null
  }
}

export function SelfHostedAbout({
  snapshot,
}: {
  readonly snapshot?: ServerAboutSnapshot | null
}) {
  const [loaded, setLoaded] = useState<ServerAboutSnapshot | null>(snapshot ?? null)
  useEffect(() => {
    if (snapshot !== undefined) return undefined
    let active = true
    void loadServerAbout().then((next) => {
      if (active && next !== null) setLoaded(next)
    })
    return () => {
      active = false
    }
  }, [snapshot])
  const view = snapshot !== undefined ? snapshot : loaded
  return (
    <article className="self-hosted-about" data-testid="self-hosted-about">
      <h1>About</h1>
      <p>colp-server {view?.server ?? 'unavailable'}</p>
      <p>@know-n/colp {view?.colp ?? 'unavailable'}</p>
      <p>protocols {view?.protocols || 'unavailable'}</p>
      <p><a href="/CHANGELOG.md">CHANGELOG</a></p>
      <p><a href="/INSTALL.md">INSTALL.md</a></p>
      <p>powered by Know-N</p>
    </article>
  )
}
