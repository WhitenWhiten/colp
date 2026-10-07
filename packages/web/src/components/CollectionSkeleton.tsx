/**
 * Public collection skeleton: masthead-height placeholder plus card frames,
 * so the resolved snapshot does not jump the layout. Shared by the route
 * Suspense fallback for `/c/:slug` and the Collection page's own snapshot
 * load, which therefore read as one continuous placeholder. Geometry lives
 * in collection.css (entry-loaded); the bones are the shared `.skeleton-block`.
 */
export function CollectionSkeleton({
  label,
  heading = 'Loading collection',
  ...rest
}: { label: string; heading?: string; 'data-testid'?: string }) {
  return (
    <article className="collection-page" {...rest}>
      <div role="status" aria-live="polite">
        {/* Kicker copy first: the shared domFinishedLoading test helper
            treats a role=status starting with "Loading" as still busy. */}
        <p className="visually-hidden">{label}</p>
        <h1 className="visually-hidden">{heading}</h1>
        <header className="page-head collection-masthead collection-skeleton-masthead" aria-hidden>
          <div className="page-head-copy">
            <p className="section-label">Public collection</p>
            <div className="skeleton-block collection-skeleton-title" />
            <div className="skeleton-block collection-skeleton-lede" />
            <div className="skeleton-block collection-skeleton-stats" />
          </div>
        </header>
        <CollectionSkeletonBoard />
      </div>
    </article>
  )
}

export function CollectionSkeletonBoard() {
  return (
    <div className="collection-skeleton-board" data-testid="collection-skeleton-board" aria-hidden>
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="skeleton-block collection-skeleton-card" />
      ))}
    </div>
  )
}
