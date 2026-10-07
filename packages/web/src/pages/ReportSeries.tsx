import { SubscribeButton } from '../components/bookmark-subscriptions/SubscribeButton'
import { DigestEmbed } from './share/DigestEmbed'
import { EmbedShareButton } from './share/EmbedShareButton'
import { useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { ABSENCE_CORNERS, AbsenceStage } from '../components/AbsenceStage'
import { Breadcrumb } from '../components/Breadcrumb'
import { CommunityVoteControl } from '../components/CommunityVoteControl'
import { CommunityComments } from '../components/CommunityComments'
import { EmptyState } from '../components/EmptyState'
import { RouteLoading } from '../components/RouteLoading'
import { Icon } from '../components/Icon'
import { PageHead } from '../components/PageHead'
import { PageShell } from '../components/PageShell'
import { AvatarImage } from '../components/AvatarImage'
import { ProfileHoverCard } from '../components/ProfileHoverCard'
import { ReportButton } from '../components/ReportContentDialog'
import { ReportFollowButton, type ReportFollowAuthority } from '../components/ReportFollowButton'
import { SocialActions } from '../components/SocialActions'
import { isReportsExposureEnabled, type PublicReportIssue } from '../api'
import { formatDate } from '../lib/formatDate'
import { profileInitials } from '../lib/initials'
import { plural } from '../lib/plural'
import { firstVisibleIssue, reportIssuePath, reportSeriesPath, sharedSourceCollectionSlug } from '../lib/reports'
import { usePageMeta } from '../lib/usePageMeta'
import { usePublicReportSeries } from '../lib/usePublicReportSeries'
// Shared digest stylesheet (see styles/css-layers.contract.test.ts); ships
// with this route chunk.
import '../styles/not-found.css'
import '../styles/reports.css'
import '../styles/share.css'

function IssueKeyChip({ issue }: { issue: PublicReportIssue }) {
  if (issue.editionOrdinal == null && !issue.issueKey) return null
  return (
    <span className="chip chip--label">
      {issue.editionOrdinal != null ? `No. ${issue.editionOrdinal}` : issue.issueKey}
    </span>
  )
}

/** /reports/:slug — the publication home, single column: masthead (title,
    summary, Follow + vote pill), a meta-row byline (curator · issue count ·
    followers · source collection), then the dated issue archive with the
    newest readable edition marked is-latest. */
export function ReportSeries() {
  const { slug = '' } = useParams()
  const [params] = useSearchParams()
  if (params.get('embed') === '1') return <DigestEmbed slug={slug} />
  return <ReportSeriesPage />
}

function ReportSeriesPage() {
  const { slug = '' } = useParams<{ slug: string }>()
  const exposed = isReportsExposureEnabled()
  const { load, reload } = usePublicReportSeries(slug)
  const [followAuthority, setFollowAuthority] = useState<ReportFollowAuthority | null>(null)

  const series = load.status === 'ready' ? load.series : null
  /* document.title is owned by PageHead below (ready state); usePageMeta here
     covers every state including loading/error so tags never go stale. */
  usePageMeta(
    // R15-22: a transient error (429, 503) leaves the head alone; only an
    // unavailable or missing page is noindexed.
    load.status === 'loading' || load.status === 'error'
      ? {}
      : series
        ? {
            description: series.summary ?? `Latest issues from ${series.title}.`,
            canonicalPath: reportSeriesPath(series.slug),
            ...(series.indexable ? {} : { robots: 'noindex' }),
          }
        : { canonicalPath: null, robots: 'noindex' },
    `${series?.title ?? 'Digest'} — Know-N`,
  )

  if (!exposed || load.status === 'unavailable') {
    return (
      <AbsenceStage
        title="Digest unavailable"
        description="This digest doesn't exist or was withdrawn."
        corners={ABSENCE_CORNERS.digest}
        exits={[{ to: '/reports', label: 'Browse digests' }]}
      />
    )
  }

  if (load.status === 'error') {
    return (
      <PageShell variant="grid">
        <EmptyState
          titleAs="h1"
          role="alert"
          icon="alert"
          title="Couldn't load this digest"
          description={load.message}
          action={<button className="btn btn-secondary btn-sm" type="button" onClick={reload}>Try again</button>}
        />
      </PageShell>
    )
  }

  if (!series) {
    return <RouteLoading label="Loading digest…" data-testid="report-series-loading" />
  }

  /* #21: a hide_public newest edition must not take the Latest mark — it
     belongs to the newest readable issue. */
  const latest = firstVisibleIssue(series.issues)
  const sourceSlug = sharedSourceCollectionSlug(series.issues)
  const issueCount = series.issues.length
  const followers = followAuthority?.followerCount ?? series.followerCount ?? null
  const curator = series.curator ?? null

  return (
    /* R9-15: the /reports family shares one track — the directory runs
       variant="grid" (96rem), so the series and issue pages do too;
       otherwise intra-family navigation shifted the edges by 3rem. */
    <PageShell variant="grid">
      <div className="report-layout" data-testid="report-series-page">
        <PageHead
          as="header"
          className="page-head--editorial page-head--social"
          layout="masthead"
          breadcrumb={<Breadcrumb items={[{ label: 'Digests', to: '/reports' }, { label: series.title }]} />}
          documentTitle={series.title}
          title={series.title}
          actions={
            /* Follow first, then the CS-01 vote pill — the same cluster the
               issue page and the collection masthead render. The vote
               control conceals itself when unresolved. */
            <SocialActions
              follow={<ReportFollowButton reportId={series.id} onState={setFollowAuthority} />}
              vote={<CommunityVoteControl query={{ kind: 'digest_series', id: series.id }} />}
              links={<><SubscribeButton sourceType="digest_series" sourceId={series.id} /><EmbedShareButton detailHeight={28} path={reportSeriesPath(series.slug)} title={series.title} /><ReportButton target={{ kind: 'digest_series', id: series.id }} label="this digest" testId="report-digest-series" /></>}
            />
          }
        >
          {/* The summary and byline share one plain card under the title, so
              the description never floats as bare copy on the page and the
              curator and counts read with it — above the action toolbar,
              not stranded below it. */}
          <div className="report-summary">
            {series.summary ? <p className="lede">{series.summary}</p> : null}
            <p className="meta-row report-series-byline">
              {curator ? (
                <span>
                  by{' '}
                  <ProfileHoverCard
                    handle={curator.handle}
                    displayName={curator.displayName}
                    avatarUrl={curator.avatarUrl}
                    profileId={curator.profileId}
                  >
                    <strong>{curator.displayName}</strong>
                    <span className="avatar collection-curator-avatar" aria-hidden>
                      <AvatarImage
                        url={curator.avatarUrl}
                        initials={profileInitials(curator.displayName, curator.handle)}
                      />
                    </span>
                  </ProfileHoverCard>
                </span>
              ) : null}
              <span>{plural(issueCount, 'issue')}</span>
              {/* The live follower count rides the byline, not the button: the
                  masthead slot holds controls only. */}
              {followers != null ? (
                <span data-testid="report-series-followers">{plural(followers, 'follower')}</span>
              ) : null}
              {series.visibility === 'unlisted' ? <span>Unlisted</span> : null}
              {sourceSlug ? (
                <Link
                  className="report-byline-source"
                  to={`/c/${encodeURIComponent(sourceSlug)}`}
                >
                  Source collection
                  <Icon name="arrow-right" />
                </Link>
              ) : null}
            </p>
          </div>
        </PageHead>

        <section className="report-archive" aria-labelledby="report-archive-title" data-testid="report-archive">
          <div className="section-head">
            <div><h2 id="report-archive-title">Issues</h2></div>
          </div>
          {issueCount === 0 ? (
            <EmptyState
              className="report-archive-empty"
              icon="book"
              title="No published issues yet"
              description="Follow this digest to see the first issue when it lands in your Library."
            />
          ) : (
            <ol className="report-issue-list" data-testid="report-issue-list">
              {series.issues.map((issue) => {
                /* #21: hide_public tombstones hold their archive slot as a
                   position fact (date + edition chip); the row is inert, and
                   the Latest mark belongs to the newest readable edition. */
                if (issue.state === 'hidden') {
                  return (
                    <li key={issue.id} data-issue-hidden>
                      <div className="report-issue-row report-issue-row--tombstone">
                        <time className="report-issue-date" dateTime={issue.publishedAt}>
                          {formatDate(issue.publishedAt)}
                        </time>
                        <div className="report-issue-copy">
                          <span className="report-issue-title">
                            <IssueKeyChip issue={issue} />
                            {issue.title}
                          </span>
                        </div>
                      </div>
                    </li>
                  )
                }
                const isLatest = issue.id === latest?.id
                return (
                  <li key={issue.id}>
                    <Link
                      className={`report-issue-row${isLatest ? ' is-latest' : ''}`}
                      to={reportIssuePath(series.slug, issue.id)}
                    >
                      <time className="report-issue-date" dateTime={issue.publishedAt}>
                        {formatDate(issue.publishedAt)}
                      </time>
                      <div className="report-issue-copy">
                        <span className="report-issue-title">
                          {isLatest ? <span className="chip chip--label">Latest</span> : null}
                          <IssueKeyChip issue={issue} />
                          {issue.title}
                        </span>
                        {issue.summary ? <p className="report-issue-summary">{issue.summary}</p> : null}
                      </div>
                      <span className="report-issue-arrow" aria-hidden><Icon name="arrow-right" /></span>
                    </Link>
                  </li>
                )
              })}
            </ol>
          )}
        </section>

        {/* CS-03: series-level comments key off the same digest_series
            target identity as the vote control in the masthead. */}
        <CommunityComments query={{ kind: 'digest_series', id: series.id }} />
      </div>
    </PageShell>
  )
}
