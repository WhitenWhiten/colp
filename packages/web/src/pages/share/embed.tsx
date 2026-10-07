import { useDocumentTitle } from '../../lib/useDocumentTitle'
import { usePublicCollectionSnapshot } from '../../lib/usePublicCollectionSnapshot'
import { usePageMeta } from '../../lib/usePageMeta'
import { publicCollectionDescription } from '../../lib/publicCollectionMeta'
import { flattenPublicCollection, publicCollectionKindLabel } from '../../lib/publicCollectionTree'
import { canonicalSiteOrigin } from '../../lib/chrome'
import { shareUrl } from './helpers'
import { EmbedCard, EmbedState, resourceEmbedRows } from './EmbedCard'

export function CollectionShareEmbed({ slug }: { slug: string }) {
  const { load, retry } = usePublicCollectionSnapshot(slug)
  const snapshot = load.status === 'ready' ? load.snapshot : null
  const published = snapshot ? flattenPublicCollection(snapshot) : null
  const documentTitle = snapshot ? snapshot.collection.title : 'Know-N collection'
  useDocumentTitle(documentTitle)
  usePageMeta(
    load.status === 'loading'
      ? {}
      : snapshot && published
        ? {
            description: publicCollectionDescription(snapshot.collection),
            canonicalPath: `/c/${encodeURIComponent(snapshot.collection.slug)}`,
          }
        : { canonicalPath: null, robots: 'noindex' },
    `${documentTitle} — Know-N`,
  )

  if (load.status === 'loading') return <EmbedState loading />
  if (!snapshot || !published) return <EmbedState message={load.status === 'error' ? load.message : 'This collection is not available.'} retry={load.status === 'error' ? retry : undefined} />
  const { collection } = snapshot
  return <EmbedCard title={collection.title} label={publicCollectionKindLabel(collection.kind)} summary={collection.summary}
    curator={collection.owner} rows={resourceEmbedRows(published.resources, collection.faviconCdnAllowed === true)}
    openHref={shareUrl(collection.slug)} moreHref={`${canonicalSiteOrigin()}/c/${encodeURIComponent(collection.slug)}`}
    emptyMessage="No public links yet — open the collection on Know-N to follow it as it grows." />
}
