import { Link } from 'react-router-dom'
import { CollectionCard } from '../../components/CollectionCard'
import { EmptyState } from '../../components/EmptyState'
import { Icon } from '../../components/Icon'
import { LoadMoreButton } from '../../components/LoadMoreButton'
import type { PublicProfileCollectionSummary, PublicProfilePage } from '../../api'
import { formatProfileDate, kindLabel } from './helpers'
import type { PaginationState } from './types'

function PublicCollectionCard({
  collection,
  curator,
  linkRef,
}: {
  collection: PublicProfileCollectionSummary
  curator: string
  linkRef: (node: HTMLAnchorElement | null) => void
}) {
  return (
    <article
      role="listitem"
      className="profile-public-card-shell"
      data-profile-collection-id={collection.id}
    >
      <CollectionCard
        ref={linkRef}
        showCurator={false}
        c={{
          id: collection.id,
          slug: collection.slug,
          title: collection.title,
          description: collection.summary || '',
          curator,
          curatorHandle: '',
          tags: [kindLabel(collection.kind)],
          links: 0,
          followers: 0,
          updated: formatProfileDate(collection.updatedAt),
          public: true,
        }}
      />
    </article>
  )
}

export function ProfileCollectionGrid({
  collections,
  heading,
  pagination,
  page,
  onRegisterLink,
  onLoadMore,
}: {
  collections: PublicProfilePage['collections']
  heading: string
  pagination: PaginationState
  page: PublicProfilePage['page']
  onRegisterLink: (id: string, node: HTMLAnchorElement | null) => void
  onLoadMore: () => void
}) {
  return (
    <section className="profile-panel" aria-labelledby="profile-collections-heading">
      <h2 id="profile-collections-heading" className="profile-panel-title">Public collections</h2>
      {collections.length === 0 ? (
        <EmptyState
          className="profile-public-empty"
          data-profile-state="empty"
          icon="collection"
          title="No public collections yet"
          description="Published collections will appear here."
        />
      ) : (
        <div className="collection-grid profile-collection-grid" role="list" aria-label="Public collections">
          {collections.map((collection) => (
            <PublicCollectionCard
              key={collection.id}
              collection={collection}
              curator={heading}
              linkRef={(node) => onRegisterLink(collection.id, node)}
            />
          ))}
        </div>
      )}
      {pagination === 'error' && (
        <EmptyState
          className="profile-public-page-error empty-state--compact"
          role="alert"
          icon="alert"
          title="Couldn't load more collections"
          description="Your current list is unchanged."
          action={<button type="button" className="btn btn-secondary btn-sm" onClick={onLoadMore}>Try again</button>}
        />
      )}
      {page.hasMore && pagination !== 'error' && (
        <LoadMoreButton
          className="btn btn-secondary btn-sm profile-public-load-more"
          loading={pagination === 'loading'}
          onClick={onLoadMore}
          status="Loading more collections…"
        />
      )}
    </section>
  )
}

export function JournalCollectionList({
  collections,
  collectionCount,
}: {
  collections: PublicProfilePage['collections']
  collectionCount: string | null
}) {
  return (
    <div className="journal-main">
      <div className="section-head--journal"><p>Selected writing</p>{collectionCount != null && <span>{collectionCount} entries</span>}</div>
      {collections.length === 0 ? (
        <EmptyState
          className="journal-empty"
          icon="collection"
          title="No notes published yet"
          description="Public collections and notes from this curator will appear here."
        />
      ) : (
        <div className="journal-entry-list">
          {collections.map((collection, index) => (
            <Link key={collection.id} to={`/c/${collection.slug}`} className="journal-entry">
              <span className="journal-entry-index">{String(index + 1).padStart(2, '0')}</span>
              <article>
                <div className="journal-entry-meta"><span>{kindLabel(collection.kind)}</span><span>{formatProfileDate(collection.updatedAt)}</span></div>
                <h2 title={collection.title}>{collection.title}</h2>
                {collection.summary && <p title={collection.summary}>{collection.summary}</p>}
              </article>
              <span className="journal-entry-arrow" aria-hidden><Icon name="arrow-right" /></span>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
