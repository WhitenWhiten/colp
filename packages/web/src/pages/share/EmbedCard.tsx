import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { AvatarImage } from '../../components/AvatarImage'
import { BookmarkIcon } from '../../components/BookmarkIcon'
import { DomainMark } from '../../components/DomainMark'
import { LoadingState } from '../../components/EmptyState'
import { Icon } from '../../components/Icon'
import { bookmarkIconSrc } from '../../lib/bookmarkIcon'
import { canonicalSiteOrigin } from '../../lib/chrome'
import { displayInitials } from '../../lib/displayInitials'
import type { PublicCollectionResource } from '../../lib/publicCollectionTree'
import { embedAppearanceStyle, embedAttributionOnDark, parseEmbedAppearance, suggestEmbedHeight } from './embedAppearance'

/** The frame's resolved theme (`auto` included), for children that pick assets by it. */
const EmbedDarkContext = createContext(false)

export function EmbedFrame({ children }: { children: ReactNode }) {
  const [searchParams] = useSearchParams()
  const appearance = parseEmbedAppearance(searchParams)
  const appearanceStyle = embedAppearanceStyle(appearance)
  const themeParam = searchParams.get('theme')
  const theme = themeParam === 'dark' || themeParam === 'auto' ? themeParam : 'light'
  /* `auto` resolves against the viewer's OS palette (the iframe cannot see
     the host page's colors) and tracks live changes while embedded. */
  const [osDark, setOsDark] = useState(
    () => theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches,
  )
  useEffect(() => {
    if (theme !== 'auto') return
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    setOsDark(query.matches)
    const onChange = (event: MediaQueryListEvent) => setOsDark(event.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [theme])
  const dark = theme === 'dark' || (theme === 'auto' && osDark)
  const pageClass = `share-embed-page${dark ? ' share-embed-page--dark' : ''}`
  return (
    <EmbedDarkContext.Provider value={dark}>
      <div className={pageClass} style={appearanceStyle} data-decoration={appearance.decoration} data-testid="share-embed-page">{children}</div>
    </EmbedDarkContext.Provider>
  )
}

/* Non-removable attribution: the drawn wordmark, in the variant that reads on
   the card's ground (R12-17). */
function EmbedAttribution({ href }: { href: string }) {
  const [searchParams] = useSearchParams()
  const onDark = embedAttributionOnDark(parseEmbedAppearance(searchParams), useContext(EmbedDarkContext))
  return (
    <a className="share-embed-foot-brand" href={href} target="_blank" rel="noreferrer">
      <img
        src={onDark ? '/brand-wordmark-dark.svg' : '/brand-wordmark.svg'}
        alt="Know-N"
        width={48}
        height={14}
        draggable={false}
      />
    </a>
  )
}

export function EmbedState({ loading, message, retry }: { loading?: boolean; message?: string; retry?: () => void }) {
  return <EmbedFrame><div className="share-embed-card share-embed-card--state" data-testid="share-embed-state" role={retry ? 'alert' : undefined}>
    {loading ? <LoadingState label="Loading card…" /> : <p className="meta">{message}</p>}
    {retry ? <button type="button" className="btn btn-secondary btn-sm" onClick={retry}>Try again</button> : null}
  </div></EmbedFrame>
}

export type EmbedRow = { id: string; title: string; href: string | null; meta: string; icon: ReactNode }
export type EmbedCurator = { displayName: string; handle?: string | null; avatarUrl?: string | null }

export function resourceEmbedRows(resources: PublicCollectionResource[], cdnAllowed: boolean): EmbedRow[] {
  return resources.map(resource => ({
    id: resource.node.id, title: resource.node.title, href: resource.href, meta: resource.host,
    icon: <BookmarkIcon icon={bookmarkIconSrc({ iconUrl: resource.node.iconUrl, pageUrl: resource.node.url, faviconCdnAllowed: cdnAllowed && (resource.node.faviconCdnAllowed ?? true) })} letter={<DomainMark host={resource.host} small />} width={16} height={16} />,
  }))
}

export function EmbedCard({ title, label, summary, curator, rows, openHref, moreHref = openHref, emptyMessage, detail }: {
  title: string; label: string; summary?: string | null; curator?: EmbedCurator | null;
  rows: EmbedRow[]; openHref: string; moreHref?: string; emptyMessage: string; detail?: ReactNode;
}) {
  const [searchParams] = useSearchParams()
  const compact = searchParams.has('compact')
  /* The list scrolls, so every row mounts; the limit only shapes the
     suggested frame height and the "+N more" count. */
  const previewLimit = compact ? 3 : 4
  const moreCount = Math.max(0, rows.length - previewLimit)
  /* Tell an embedding host how tall the card wants to be so it can auto-size
     the frame; a direct visit has window.parent === window and stays silent.
     detailHeight 28 matches the composer's Digest edition line. */
  const reportedHeight = suggestEmbedHeight({
    compact,
    rowCount: rows.length,
    detailHeight: detail ? 28 : 0,
    appearance: parseEmbedAppearance(searchParams),
  })
  useEffect(() => {
    if (window.parent === window) return
    window.parent.postMessage({ type: 'known:embed-resize', height: reportedHeight }, '*')
  }, [reportedHeight])
  const origin = canonicalSiteOrigin()
  const curatorName = curator?.displayName ?? ''
  const curatorHandle = curator?.handle ?? ''
  const rowBody = (row: EmbedRow) => <>
    <span className="share-embed-row-icon" aria-hidden data-testid="share-embed-row-icon">{row.icon}</span>
    <span className="share-embed-row-title">{row.title}</span>
    <span className="meta share-embed-row-host">{row.meta}</span>
  </>
  return (
    <EmbedFrame>
      <article className="share-embed-card">
        <div className="share-embed-main">
          <div className="share-embed-title-row">
            <h1 className="share-embed-title">{title}</h1>
            <span className="chip chip--outline">{label}</span>
          </div>
          {detail ? <p className="meta share-embed-detail">{detail}</p> : null}
          {!compact && summary ? <p className="share-embed-summary">{summary}</p> : null}
          {!compact && curatorName ? (
            <span className="share-embed-curator">
              <span className="avatar avatar-sm" aria-hidden>
                <AvatarImage url={curator?.avatarUrl} initials={displayInitials(curatorName)} />
              </span>
              <span className="share-embed-curator-name">
                {curatorName}
                {curatorHandle ? <span className="meta"> · @{curatorHandle}</span> : null}
              </span>
            </span>
          ) : null}
        </div>

        {/* The wrapper owns the overflow: the list scrolls inside it while
            the "+N more" link stays pinned beneath — the fade must never
            dim the one row that explains the truncation. */}
        <div className="share-embed-rows">
          {rows.length > 0 ? (
            <ul
              className={`share-embed-list${moreCount > 0 ? ' share-embed-list--truncated' : ''}`}
              data-testid="share-embed-list"
            >
              {rows.map((resource) => (
                <li key={resource.id}>
                  {resource.href ? (
                    <a
                      className="share-embed-row"
                      data-testid="share-embed-row"
                      href={resource.href}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {rowBody(resource)}
                    </a>
                  ) : (
                    <span className="share-embed-row">
                      {rowBody(resource)}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="meta share-embed-empty">
              {emptyMessage}
            </p>
          )}
          {moreCount > 0 && (
            <a
              className="share-embed-row share-embed-row--more"
              data-testid="share-embed-more"
              href={moreHref}
              target="_blank"
              rel="noreferrer"
            >
              <span className="share-embed-row-title">+{moreCount} more {moreCount === 1 ? 'link' : 'links'}</span>
            </a>
          )}
        </div>

        <footer className="share-embed-foot">
          <EmbedAttribution href={origin} />
          <a className="share-embed-foot-open" href={openHref} target="_blank" rel="noreferrer">
            Open <Icon name="arrow-up-right" />
          </a>
        </footer>
      </article>
    </EmbedFrame>
  )
}
