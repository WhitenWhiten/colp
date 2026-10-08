import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Breadcrumb } from '../../components/Breadcrumb'
import { useToast } from '../../components/AppToast'
import { AvatarImage } from '../../components/AvatarImage'
import { ClampedText } from '../../components/ClampedText'
import { ABSENCE_CORNERS, AbsenceStage } from '../../components/AbsenceStage'
import { LoadingState } from '../../components/EmptyState'
import { PageShell } from '../../components/PageShell'
import { RouteState } from '../../components/RouteState'
import { copyTextToClipboard } from '../../lib/clipboard'
import { displayInitials } from '../../lib/displayInitials'
import { formatDate } from '../../lib/formatDate'
import { plural, pluralNoun } from '../../lib/plural'
import { resourceKindLabel } from '../../lib/resourceKind'
import { useDocumentTitle } from '../../lib/useDocumentTitle'
import { usePublicCollectionSnapshot } from '../../lib/usePublicCollectionSnapshot'
import {
  flattenPublicCollection,
  publicCollectionKindLabel,
  type PublicCollectionResource,
} from '../../lib/publicCollectionTree'
import type { PublicCollectionSnapshot } from '../../api'
import { usePageMeta } from '../../lib/usePageMeta'
import { publicCollectionDescription } from '../../lib/publicCollectionMeta'
import { ShareFooterCta, ShareProductStrip } from './chrome'
import { shareUrl } from './helpers'
import { EmbedComposer } from './EmbedComposer'
import { isLongDisplayTitle } from '../../lib/displayTitle'

export function CollectionShare({ slug }: { slug: string }) {
  const { load, retry } = usePublicCollectionSnapshot(slug)
  const published = load.status === 'ready' ? flattenPublicCollection(load.snapshot) : null
  const documentTitle =
    load.status === 'ready'
      ? load.snapshot.collection.title
      : load.status === 'unavailable'
        ? 'Collection unavailable'
        : load.status === 'error'
          ? 'Collection error'
          : 'Share'
  useDocumentTitle(documentTitle)
  const readyCollection = load.status === 'ready' ? load.snapshot.collection : null
  usePageMeta(
    // R15-22: a transient error (429, 503) leaves the head alone; only an
    // unavailable or missing page is noindexed.
    load.status === 'loading' || load.status === 'error'
      ? {}
      : readyCollection && published
        ? {
            description: publicCollectionDescription(readyCollection),
            canonicalPath: `/c/${encodeURIComponent(readyCollection.slug)}`,
          }
        : { canonicalPath: null, robots: 'noindex' },
    `${documentTitle} — Know-N`,
  )

  if (load.status === 'loading') {
    return (
      <PageShell variant="bare">
        <LoadingState
          label={load.restartCount > 0 ? 'Refreshing the collection snapshot…' : 'Loading collection…'}
        />
      </PageShell>
    )
  }

  if (load.status === 'unavailable') {
    return (
      <AbsenceStage
        title="Collection unavailable"
        description="This collection was not found, has been withdrawn, or is not available to this account."
        corners={ABSENCE_CORNERS.collection}
        exits={[{ to: '/', label: 'Back home' }]}
      />
    )
  }

  if (load.status === 'error') {
    return (
      <PageShell variant="bare">
        <RouteState kind="error" titleAs="h1" title="Couldn't load this collection" description={load.message} onRetry={retry} />
      </PageShell>
    )
  }

  if (!published) {
    return (
      <AbsenceStage
        title="Collection unavailable"
        description="This collection is still being published. Try again in a moment."
        corners={ABSENCE_CORNERS.collection}
        exits={[{ label: 'Try again', onClick: retry }, { to: '/', label: 'Back home' }]}
      />
    )
  }

  return (
    <CollectionShareReady
      collection={load.snapshot.collection}
      resources={published.resources}
    />
  )
}

function CollectionShareReady({
  collection,
  resources,
}: {
  collection: PublicCollectionSnapshot['collection']
  resources: PublicCollectionResource[]
}) {
  const preview = resources.slice(0, 6)
  const { error } = useToast()
  const [copied, setCopied] = useState(false)
  const copyTimerRef = useRef<number | undefined>(undefined)
  useEffect(() => () => {
    if (copyTimerRef.current !== undefined) window.clearTimeout(copyTimerRef.current)
  }, [])
  const url = shareUrl(collection.slug)
  const curatorName = collection.owner?.displayName ?? null
  const curatorHandle = collection.owner?.handle ?? ''
  const summary = collection.summary || ''

  const initials = curatorName === null ? '' : displayInitials(curatorName)

  const typeMix = useMemo(() => {
    const map = new Map<string, number>()
    for (const resource of resources) {
      const kind = resourceKindLabel(resource.host)
      if (kind === 'Link') continue
      map.set(kind, (map.get(kind) ?? 0) + 1)
    }
    return [...map.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 5)
      .map(([type, count]) => ({ type, count, label: type }))
  }, [resources])

  const copyLink = async () => {
    try {
      await copyTextToClipboard(url)
      setCopied(true)
      // Held in a ref and cleared on unmount: the timer outlives the component
      // otherwise and sets state on a tree React has already torn down.
      if (copyTimerRef.current !== undefined) window.clearTimeout(copyTimerRef.current)
      copyTimerRef.current = window.setTimeout(() => setCopied(false), 2000)
    } catch {
      error("Couldn't copy the link. Select the address and copy it.")
    }
  }

  const curatorAvatar = curatorName === null ? null : (
    <span className="avatar avatar-md" aria-hidden data-testid="share-curator-avatar">
      <AvatarImage url={collection.owner?.avatarUrl} initials={initials} />
    </span>
  )

  const curator = curatorName === null ? null : curatorHandle ? (
    <Link to={`/u/${curatorHandle}`} className="share-curator-link" data-testid="share-curator-link">
      {curatorAvatar}
      <span>
        <strong>{curatorName}</strong>
        <span className="meta handle-text">@{curatorHandle}</span>
      </span>
    </Link>
  ) : (
    <span className="share-curator-link" data-testid="share-curator-link">
      {curatorAvatar}
      <span>
        <strong>{curatorName}</strong>
      </span>
    </span>
  )

  /* The OG preview shows the real og:image usePageMeta manages — the
     per-collection card the server stamped, or the site-wide cover. No meta
     at all hides the whole block (there is nothing true to preview). */
  const [ogImageUrl, setOgImageUrl] = useState<string | null>(null)
  useEffect(() => {
    const node = document.head.querySelector('meta[property="og:image"]')
    setOgImageUrl(node?.getAttribute('content') || null)
  }, [])

  return (
    <div className="share-page" data-testid="share-page">
      <Breadcrumb
        items={[
          { label: 'Explore', to: '/explore' },
          { label: collection.title, to: `/c/${collection.slug}` },
          { label: 'Share' },
        ]}
      />
      <section className="share-hero share-hero--collection" data-testid="share-hero">
        <div className="share-hero-inner">
          <div className="share-hero-copy rise">
            <p className="eyebrow">Shared collection · Know-N</p>
            <div className="share-tag-row">
              <span className="chip">{publicCollectionKindLabel(collection.kind)}</span>
            </div>
            <h1 className={`display display-lg${isLongDisplayTitle(collection.title) ? ' display--long' : ''}`}>{collection.title}</h1>
            {/* R9-31: an empty summary omits the lede instead of printing a
                bare '-'. */}
            {summary && (
              <ClampedText
                text={summary}
                className="lede share-hero-lede"
                wrapperClassName="share-hero-summary"
                toggleClassName="share-summary-toggle"
              />
            )}

            <div className="share-curator-card" data-testid="share-curator-card">
              {curator}
              <ul className="stat-row share-stats">
                <li>
                  <strong>{resources.length}</strong> {pluralNoun(resources.length, 'bookmark')}
                </li>
                <li>
                  Updated <strong>{formatDate(collection.updatedAt)}</strong>
                </li>
              </ul>
            </div>

            <div className="share-cta">
              <Link to={`/c/${collection.slug}`} className="btn btn-primary btn-lg">
                Open full collection
              </Link>
              <button type="button" className="btn btn-secondary btn-lg" onClick={copyLink}>
                {copied ? 'Copied' : 'Copy share link'}
              </button>
            </div>
            <p className="share-url meta" title={url}>
              {url}
            </p>
          </div>

          <div className="share-preview" aria-label="Collection preview">
            <div className="share-preview-head">
              <span className="eyebrow m-0">
                Preview
              </span>
              <span className="meta">
                {preview.length} of {plural(resources.length, 'bookmark')}
              </span>
            </div>
            <div className="share-preview-list">
              {preview.map((resource, i) => {
                const description = resource.node.description || ''
                const kind = resourceKindLabel(resource.host)
                return (
                  <article key={resource.node.id} className="share-preview-row" style={{ animationDelay: `${i * 40}ms` }}>
                    {kind !== 'Link' && <span className="share-preview-kind" data-testid="share-preview-kind">{kind}</span>}
                    <div className="share-preview-body">
                      <strong>{resource.node.title}</strong>
                      <span className="meta">
                        {resource.host}
                        {description ? ` · ${description.slice(0, 72)}${description.length > 72 ? '…' : ''}` : ''}
                      </span>
                    </div>
                  </article>
                )
              })}
              {preview.length === 0 && (
                <div className="share-preview-empty" role="status">
                  <p>No public links yet. Open the collection on Know-N to follow it as it grows.</p>
                </div>
              )}
            </div>
            {typeMix.length > 0 && <div className="share-type-mix" data-testid="share-type-mix">
              {typeMix.map((item) => (
                <span key={item.type} className="chip">
                  {item.label} · {item.count}
                </span>
              ))}
            </div>}
          </div>
        </div>
      </section>

      <section className="share-section share-section--muted">
        <div className="share-section-inner">
          <div className="section-head section-head--flush">
            <div>
              <p className="eyebrow">Distribute</p>
              <h2 className="display display-sm">Share it anywhere</h2>
            </div>
          </div>
          <div className="share-distribute-grid">
            {ogImageUrl ? (
            <div>
              <p className="eyebrow">Social card · OG preview</p>
              <div className="share-og-card mt-hair-55">
                <img className="share-og-art" src={ogImageUrl} alt="" />
                <div className="share-og-body">
                  <strong>{collection.title}</strong>
                  <p className="meta share-og-desc">
                    {summary.slice(0, 120)}
                    {summary.length > 120 ? '…' : ''}
                  </p>
                  <p className="meta share-og-site">
                    know-n.com{curatorHandle ? ` · @${curatorHandle}` : ''}
                  </p>
                </div>
              </div>
            </div>
            ) : null}

            <EmbedComposer path={`/share/${encodeURIComponent(collection.slug)}`} title={collection.title} rowCount={resources.length} />
          </div>
        </div>
      </section>

      <ShareProductStrip />
      <ShareFooterCta collectionSlug={collection.slug} />
    </div>
  )
}
