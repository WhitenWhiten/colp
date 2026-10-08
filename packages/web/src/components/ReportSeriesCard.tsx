import { Link } from 'react-router-dom'
import type { PublicReportSeries } from '../api'
import { formatDate } from '../lib/formatDate'
import { profileInitials } from '../lib/initials'
import { pluralNoun } from '../lib/plural'
import { reportSeriesPath } from '../lib/reports'
import { AvatarImage } from './AvatarImage'
import { Icon } from './Icon'

/**
 * Digest series card: the same anatomy as CollectionCard — rss mark plus a
 * Digest chip in the kicker, serif-free title, a stats line carrying the
 * latest edition number/date and follower count, and a curator row on the
 * card floor. Shared by the /reports directory and the Explore board.
 * Issues arrive sorted newest-first by the projection, so `issues[0]` is
 * the latest.
 */
export function ReportSeriesCard({ series }: { series: PublicReportSeries }) {
  const latest = series.issues[0]
  const curator = series.curator ?? null
  return (
    <Link
      className="result-card result-card--collection"
      to={reportSeriesPath(series.slug)}
      data-testid="report-series-card"
    >
      <div className="collection-card-body">
        <div className="collection-card-kicker">
          <span className="collection-card-mark" aria-hidden>
            <Icon name="rss" />
          </span>
          <span className="chip chip--label">Digest</span>
        </div>
        <h3 className="collection-card-title">{series.title}</h3>
        {series.summary ? <p className="collection-card-desc">{series.summary}</p> : null}
        {/* Same .collection-card-stat anatomy as CollectionCard: the dot
            leads its stat and centres on the row instead of sitting on the
            text baseline. */}
        <p className="collection-card-stats">
          {series.followerCount ? (
            <span className="collection-card-stat">
              <span>
                <strong>{series.followerCount}</strong> {pluralNoun(series.followerCount, 'follower')}
              </span>
            </span>
          ) : null}
          <span className="collection-card-stat">
            {series.followerCount ? <span className="dot-sep" aria-hidden /> : null}
            {latest ? (
              <span className="collection-card-updated">
                {latest.editionOrdinal != null ? <>No. {latest.editionOrdinal}{' · '}</> : null}
                <time dateTime={latest.publishedAt}>{formatDate(latest.publishedAt)}</time>
              </span>
            ) : (
              <span className="collection-card-updated">No issues yet</span>
            )}
          </span>
        </p>
        <div className="collection-card-foot">
          {curator ? (
            <div className="curator-row">
              <span className="avatar" aria-hidden>
                <AvatarImage
                  url={curator.avatarUrl}
                  initials={profileInitials(curator.displayName, curator.handle)}
                />
              </span>
              <span className="collection-card-curator">{curator.displayName}</span>
            </div>
          ) : null}
          <span className="collection-card-arrow" aria-hidden><Icon name="arrow-right" /></span>
        </div>
      </div>
    </Link>
  )
}
