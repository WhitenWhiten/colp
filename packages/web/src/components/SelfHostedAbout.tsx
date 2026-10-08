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
  const versions = [
    { id: 'server', label: 'colp-server', value: view?.server },
    { id: 'colp', label: '@know-n/colp', value: view?.colp },
    { id: 'protocols', label: 'COLP protocol versions', value: view?.protocols || undefined },
  ]
  return (
    <article className="self-hosted-about" data-testid="self-hosted-about">
      <h1>About this server</h1>
      <p className="self-hosted-about-lede">
        COLP Server keeps your bookmarks on a machine you run. It speaks the Collection
        Protocol, so the browser extension and your agents read and sync the same collections.
      </p>
      <dl className="self-hosted-about-versions">
        {versions.map((row) => (
          <div key={row.id}>
            <dt>{row.label}</dt>
            <dd data-testid={`about-${row.id}`}>{row.value ?? 'unavailable'}</dd>
          </div>
        ))}
      </dl>
      <ul className="self-hosted-about-links">
        <li><a href="/CHANGELOG.md">Changelog</a></li>
        <li><a href="/INSTALL.md">Install and upgrade guide</a></li>
      </ul>
      <p className="self-hosted-about-powered">powered by Know-N</p>
    </article>
  )
}
