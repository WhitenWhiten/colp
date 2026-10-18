import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { CopyButton } from './CommandBlock'
import { Icon, type IconName } from './Icon'
import { StatusBadge, type StatusTone } from './StatusBadge'
import { manifestTransport, type ManifestTransport } from './TransportWarning'
import { useDocumentTitle } from '../lib/useDocumentTitle'

export type ServerAboutSnapshot = {
  readonly server: string
  readonly colp: string
  readonly protocols: string
  /** `/health` body `status`; absent on older servers. */
  readonly status?: string
  /** Manifest `features.transport` (C4); absent when the Manifest was not read. */
  readonly transport?: ManifestTransport
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
  const status = (health as { status?: unknown }).status
  const transport = manifest === undefined ? undefined : manifestTransport(manifest)
  return {
    server: record.server,
    colp: record.colp,
    protocols,
    ...(typeof status === 'string' ? { status } : {}),
    ...(transport !== undefined ? { transport } : {}),
  }
}

async function readJson(path: string): Promise<unknown> {
  try {
    const response = await fetch(path)
    return response.ok ? await response.json() as unknown : undefined
  } catch {
    return undefined
  }
}

async function loadServerAbout(): Promise<ServerAboutSnapshot | null> {
  if (import.meta.env.MODE === 'test') return null
  const [health, manifest] = await Promise.all([readJson('/health'), readJson('/.well-known/collection-protocol')])
  return readServerAbout(health, manifest)
}

/** US-25 "know it is healthy": one line a person can read without curl. */
export function describeServerStatus(view: ServerAboutSnapshot | null): string {
  if (view === null) return 'Could not read /health'
  const healthy = view.status === undefined || view.status === 'ok' || view.status === 'healthy'
  const transport = view.transport === 'insecure-http'
    ? 'plain HTTP'
    : view.transport === 'https' ? 'HTTPS' : null
  const head = healthy ? 'Healthy' : `Reported "${view.status}"`
  return transport === null ? head : `${head} · ${transport}`
}

/** Healthy over HTTPS is green; plain HTTP is a warning, like the banner. */
export function serverStatusTone(view: ServerAboutSnapshot | null): StatusTone {
  if (view === null) return 'muted'
  const healthy = view.status === undefined || view.status === 'ok' || view.status === 'healthy'
  if (!healthy) return 'danger'
  return view.transport === 'insecure-http' ? 'warning' : 'success'
}

const NEXT_STEPS: readonly { to: string; icon: IconName; title: string; body: string }[] = [
  { to: '/extension', icon: 'browser', title: 'Connect a browser', body: 'Keep a browser’s bookmarks and your library in sync, both ways.' },
  { to: '/agents', icon: 'terminal', title: 'Connect an agent', body: 'Let Claude Code or Codex read and tidy, with your approval.' },
  { to: '/import', icon: 'download', title: 'Import bookmarks', body: 'Bring in the bookmarks file any browser exports.' },
  { to: '/sync', icon: 'sync', title: 'Sync center', body: 'See every synced browser, conflicts, and recently deleted items.' },
]

export function SelfHostedAbout({
  snapshot,
  origin,
}: {
  readonly snapshot?: ServerAboutSnapshot | null
  /** Page origin shown as the address browsers and agents connect to. */
  readonly origin?: string
}) {
  useDocumentTitle('About')
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
  const pageOrigin = origin ?? (typeof window === 'undefined' ? '' : window.location.origin)
  const versions = [
    { id: 'server', label: 'colp-server', value: view?.server },
    { id: 'colp', label: '@know-n/colp', value: view?.colp },
    { id: 'protocols', label: 'COLP protocol versions', value: view?.protocols || undefined },
  ]
  return (
    <article className="self-hosted-about" data-testid="self-hosted-about">
      <header className="self-hosted-about-hero">
        <p className="section-label">About</p>
        <h1>About this server</h1>
        <p className="self-hosted-about-lede">
          COLP Server keeps your bookmarks on a machine you run. It speaks the Collection
          Protocol, so the browser extension and your agents read and sync the same library.
        </p>
        <StatusBadge tone={serverStatusTone(view)} className="self-hosted-about-status">
          <span data-testid="about-status">{describeServerStatus(view)}</span>
        </StatusBadge>
      </header>

      <section className="self-hosted-about-card" aria-labelledby="about-server-title">
        <h2 id="about-server-title">This server</h2>
        <dl className="self-hosted-about-versions">
          <div className="self-hosted-about-address">
            <dt>Server address</dt>
            <dd>
              <span data-testid="about-origin">{pageOrigin || 'unavailable'}</span>
              {pageOrigin && <CopyButton label="server address" text={pageOrigin} />}
            </dd>
          </div>
          {versions.map((row) => (
            <div key={row.id}>
              <dt>{row.label}</dt>
              <dd data-testid={`about-${row.id}`}>{row.value ?? 'unavailable'}</dd>
            </div>
          ))}
        </dl>
        <p className="self-hosted-about-hint">The extension and agents connect to this address.</p>
      </section>

      <nav className="self-hosted-about-next" aria-label="Set up">
        <h2>Next steps</h2>
        <ul className="self-hosted-about-steps">
          {NEXT_STEPS.map((step) => (
            <li key={step.to}>
              <Link to={step.to} className="self-hosted-about-step">
                <span className="self-hosted-about-step-icon" aria-hidden><Icon name={step.icon} /></span>
                <strong>{step.title}</strong>
                <span>{step.body}</span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <footer className="self-hosted-about-foot">
        <ul className="self-hosted-about-links">
          <li><a href="/CHANGELOG.md">Changelog</a></li>
          <li><a href="/INSTALL.md">Install and upgrade guide</a></li>
          <li><a href="https://github.com/WhitenWhiten/colp" target="_blank" rel="noopener noreferrer">Source and issues</a></li>
        </ul>
        <p className="self-hosted-about-powered">powered by Know-N</p>
      </footer>
    </article>
  )
}
