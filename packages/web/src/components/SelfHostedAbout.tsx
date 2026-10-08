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
  return {
    server: record.server,
    colp: record.colp,
    protocols,
  }
}

async function loadServerAbout(): Promise<ServerAboutSnapshot | null> {
  if (import.meta.env.MODE === 'test') return null
  try {
    const healthResponse = await fetch('/health')
    const health = healthResponse.ok ? await healthResponse.json() as unknown : undefined
    return readServerAbout(health)
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
