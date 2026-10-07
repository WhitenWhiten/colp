import { memo, useState } from 'react'
import { isProductApiError, productClient } from '../../api'
import { useToast } from '../../components/AppToast'
import { CollectionDestinationPicker, type DestinationPick } from '../../components/CollectionDestinationPicker'
import { BookmarkIcon } from '../../components/BookmarkIcon'
import { DomainMark } from '../../components/DomainMark'
import { Icon } from '../../components/Icon'
import { ResourceList, type ResourceListItem } from '../../components/ResourceList'
import { useOwnedCollections } from '../../lib/useOwnedCollections'
import { bookmarkIconSrc } from '../../lib/bookmarkIcon'
import { recordResourceOpen } from '../../lib/recordCollectionInsight'
import { resourceDetailPath } from '../../lib/useResourceNode'
import { resourceKindLabel } from '../../lib/resourceKind'
import { previewCover } from '../../lib/linkPreview'
import { type PublicCollectionResource as CollectionResource } from '../../lib/publicCollectionTree'
import { type ViewMode } from './format'
import { UGC_REL } from '../../lib/ugcRel'

/* Secondary affordance: the external original, marked with the safety
   attributes the e2e contract asserts (target=_blank + noopener noreferrer).
   Unsafe URLs (href === null) render nothing — "Link unavailable" stays.
   The primary title link goes to the in-app resource detail (/r/:id) with
   the public slug in ?slug= (see ResourceListItem.detailLink). */
function ResourceExternalLink({ resource, slug, className }: {
  resource: CollectionResource
  slug: string
  className: string
}) {
  if (!resource.href) return null
  return (
    <a
      className={className}
      href={resource.href}
      target="_blank"
      rel={UGC_REL}
      data-collection-resource-link
      aria-label={`Open ${resource.node.title} on ${resource.host}`}
      title={`Open on ${resource.host}`}
      onClick={() => {
        recordResourceOpen(slug, resource.node.id)
      }}
    >
      <Icon name="arrow-up-right" />
    </a>
  )
}

/* R7-07: copying into an owned collection closes the explore loop — a
   signed-in visitor files a public bookmark as a real node (the same
   createCollectionNode write the desk uses), instead of only following.
   The desk's reading-list control keeps its own glyph. */
function ResourceSaveButton({ resource, onSave }: {
  resource: CollectionResource
  onSave: (resource: CollectionResource) => void
}) {
  if (!resource.node.url) return null
  return (
    <button
      type="button"
      className="collection-resource-save"
      data-collection-resource-save
      aria-label={`Copy ${resource.node.title} to one of your collections`}
      title="Copy to my collection"
      onClick={() => onSave(resource)}
    >
      <Icon name="fork" />
    </button>
  )
}

export function SaveResourcePicker({ resource, resources, onClose }: {
  resource?: CollectionResource
  /** Batch mode (digest Save all): every entry with a resolvable url. */
  resources?: CollectionResource[]
  onClose: () => void
}) {
  const owned = useOwnedCollections()
  const { success, error } = useToast()
  const [busy, setBusy] = useState(false)
  const targets = (resources ?? (resource ? [resource] : []))
    .flatMap((item) => (item.node.url ? [{ item, url: item.node.url }] : []))

  const onPick = async (destination: DestinationPick) => {
    if (busy || targets.length === 0) return
    setBusy(true)
    try {
      for (const { item, url } of targets) {
        const intentId = productClient.mutationIntentKey(
          `save-public:${destination.collectionId}:${item.node.id}`,
          productClient.newCommandId(),
        )
        await productClient.createCollectionNode(
          destination.collectionId,
          {
            parentId: destination.parentId,
            afterId: null,
            beforeId: null,
            node: {
              kind: 'bookmark',
              title: item.node.title,
              url,
              description: item.node.description,
              tags: [],
              visibility: 'inherit',
            },
          },
          { intentId },
        )
      }
      success(`Saved to “${destination.parentTitle ?? destination.collectionTitle}”`)
      onClose()
    } catch (err) {
      error(isProductApiError(err) ? err.recoveryHint : 'Could not save. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <CollectionDestinationPicker
      mode="copy"
      count={targets.length}
      busy={busy}
      owned={owned.items}
      onPick={(destination) => {
        void onPick(destination)
      }}
      onClose={onClose}
    />
  )
}

export function ResourceIcon({
  resource,
  faviconCdnAllowed,
}: {
  resource: CollectionResource
  /** Collection-level CDN fact; the node may still opt out (icon source none). */
  faviconCdnAllowed: boolean
}) {
  // FO-07 fix: an explicit `none` never hotlinks the CDN. The node-level fact
  // is authoritative when present; an older server response omits it, which
  // keeps the collection-level behavior.
  const nodeCdnAllowed = resource.node.faviconCdnAllowed ?? faviconCdnAllowed
  return (
    <BookmarkIcon
      icon={bookmarkIconSrc({
        iconUrl: resource.node.iconUrl,
        pageUrl: resource.node.url,
        faviconCdnAllowed: faviconCdnAllowed && nodeCdnAllowed,
      })}
      letter={<DomainMark host={resource.host} small />}
    />
  )
}

export const CollectionResources = memo(function CollectionResources({ resources, view, slug, resourcesRef, faviconCdnAllowed, showPath, onSave }: {
  resources: CollectionResource[]
  view: ViewMode
  slug: string
  resourcesRef: (node: HTMLDivElement | null) => void
  faviconCdnAllowed: boolean
  /** Search results show where a hit lives; plain layers do not repeat it. */
  showPath: boolean
  /** R7-07: signed-in visitors can file a bookmark into an owned collection. */
  onSave?: (resource: CollectionResource) => void
}) {
  const mode = view
  const items: ResourceListItem[] = resources.map((resource) => {
    const kind = resourceKindLabel(resource.host)
    // Moderation tombstone (hide_public): the row keeps its position with the
    // server's inert title — no detail link, no actions, no kind chip (S1c).
    // "Link" is the ordinary web-page label, so that chip says nothing.
    const hidden = resource.node.state === 'hidden'
    return {
      id: resource.node.id,
      title: resource.node.title,
      host: resource.host,
      mid: showPath && resource.path.length > 0 ? resource.path.join(' / ') : undefined,
      description: mode === 'compact' ? null : (resource.node.description || null),
      ...(resource.node.pinned && !hidden ? { pinned: true } : {}),
      // Public curation marks surface on comfort rows (and the report issue
      // stream); compact rows keep their single-register density, board
      // cards defer snippets to a later density iteration.
      tldr: resource.node.tldr ?? undefined,
      note: resource.node.note ?? undefined,
      mark: <ResourceIcon resource={resource} faviconCdnAllowed={faviconCdnAllowed} />,
      depth: resource.depth,
      kind: hidden || kind === 'Link' ? undefined : kind,
      to: hidden ? undefined : resourceDetailPath(resource.node.id, { subjectType: 'node', slug }),
      detailLink: (mode === 'board' || mode === 'gallery') && !hidden,
      cover: mode === 'gallery' && !hidden ? previewCover(resource.node.previewImage) : null,
      actions: !hidden && (resource.href || onSave) ? (
        <>
          {onSave && <ResourceSaveButton resource={resource} onSave={onSave} />}
          {resource.href && (
            <ResourceExternalLink resource={resource} slug={slug} className="collection-resource-external" />
          )}
        </>
      ) : undefined,
      unavailable: !hidden && !resource.href && Boolean(resource.node.url),
      hidden,
    }
  })

  return (
    <ResourceList
      items={items}
      mode={mode}
      streamRef={resourcesRef}
      collectionView={mode}
    />
  )
})
