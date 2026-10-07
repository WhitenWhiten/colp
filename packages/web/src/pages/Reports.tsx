import { Link } from 'react-router-dom'
import { EmptyState, LoadingState } from '../components/EmptyState'
import { LoadMoreButton } from '../components/LoadMoreButton'
import { PageHead } from '../components/PageHead'
import { PageShell } from '../components/PageShell'
import { ReportSeriesCard } from '../components/ReportSeriesCard'
import { isReportsExposureEnabled } from '../api'
import { plural, pluralNoun } from '../lib/plural'
import { usePublicReports } from '../lib/usePublicReports'
// Shared digest stylesheet (see styles/css-layers.contract.test.ts); ships
// with this route chunk.
import '../styles/reports.css'

/** /reports — public digest directory. The backend owns the no-JS shell and
    SEO metadata on the same path; this SPA page boots on top of it. Layout
    mirrors Explore: editorial head, count line, 1/2/3-column card grid,
    Load more / end notice. */
export function Reports() {
  const exposed = isReportsExposureEnabled()
  const {
    items, status, nextCursor, loadingMore, moreError, loadFirstPage, loadMore,
  } = usePublicReports(exposed)

  return (
    <PageShell variant="grid" data-testid="reports-page">
      <PageHead
        className="page-head--editorial"
        title="Digests"
        documentTitle="Digests"
        meta={{
          description: 'Public digest series and their latest issues on Know-N.',
          canonicalPath: '/reports',
        }}
        lede="Recurring digests from curators — follow a series to read each new issue from your Library."
      />

      {!exposed || status === 'unavailable' ? (
        <EmptyState
          className="empty-state--board"
          icon="book"
          title="Digests are not available yet"
          description="Digests will appear here when they are ready."
          action={<Link className="btn btn-secondary btn-sm" to="/explore">Explore collections</Link>}
        />
      ) : status === 'error' && items.length === 0 ? (
        <EmptyState
          className="empty-state--board"
          role="alert"
          icon="alert"
          title="Couldn't load digests"
          action={
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => void loadFirstPage()}
            >
              Try again
            </button>
          }
        />
      ) : status === 'loading' && items.length === 0 ? (
        <LoadingState label="Loading digests…" data-testid="reports-loading-state" />
      ) : items.length === 0 ? (
        <EmptyState
          className="empty-state--board"
          icon="book"
          title="No public digests yet"
          description="When curators publish digest series, they will appear here."
          action={<Link className="btn btn-secondary btn-sm" to="/explore">Explore collections</Link>}
        />
      ) : (
        <>
          {!nextCursor && (
            <p className="explore-count report-directory-count" data-testid="report-directory-count">
              <strong>{items.length}</strong>
              {' '}{pluralNoun(items.length, 'digest')}
            </p>
          )}
          <div className="collection-grid" data-testid="report-grid">
            {items.map((series) => (
              <ReportSeriesCard key={series.id} series={series} />
            ))}
          </div>
          {nextCursor ? (
            <div className="explore-more">
              <LoadMoreButton
                loading={loadingMore}
                onClick={() => void loadMore()}
                status="Loading more digests"
              />
              {moreError && (
                <p className="report-more-error meta" role="alert">
                  Couldn't load more digests.
                  {' '}
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => void loadMore()}
                  >
                    Try again
                  </button>
                </p>
              )}
            </div>
          ) : (
            <p className="explore-end-notice meta">
              All {plural(items.length, 'digest')} loaded
            </p>
          )}
        </>
      )}
    </PageShell>
  )
}
