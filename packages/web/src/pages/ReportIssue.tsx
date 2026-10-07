import { SubscribeButton } from '../components/bookmark-subscriptions/SubscribeButton'
import { DigestEmbed } from './share/DigestEmbed'
import { EmbedShareButton } from './share/EmbedShareButton'
import { useEffect, useState } from 'react'
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom'
import { ABSENCE_CORNERS, AbsenceStage } from '../components/AbsenceStage'
import { Breadcrumb } from '../components/Breadcrumb'
import { DigestEntry } from '../components/DigestEntry'
import { CommunityVoteControl } from '../components/CommunityVoteControl'
import { CommunityComments } from '../components/CommunityComments'
import { EmptyState, LoadingState } from '../components/EmptyState'
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
import { useAuth } from '../auth/AuthContext'
import { formatCalendarDate, formatDate } from '../lib/formatDate'
import { profileInitials } from '../lib/initials'
import { plural } from '../lib/plural'
import type { PublicCollectionResource } from '../lib/publicCollectionTree'
import {
  reportIssueSections,
  type ReportIssueContents,
  type ReportIssueSection,
} from '../lib/reportIssueSections'
import { issueNeighbours, reportIssuePath, reportSeriesPath } from '../lib/reports'
import { usePageMeta } from '../lib/usePageMeta'
import { usePublicCollectionSnapshot } from '../lib/usePublicCollectionSnapshot'
import { usePublicReportIssue } from '../lib/usePublicReportIssue'
import { usePublicReportSeries } from '../lib/usePublicReportSeries'
import { SaveResourcePicker } from './collection/resources'
// Shared digest stylesheet; the edition stream renders DigestEntry, so the
// library workbench rows are no longer imported here (see
// styles/css-layers.contract.test.ts).
import '../styles/not-found.css'
import '../styles/reports.css'
import '../styles/share.css'

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X',
  'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX']

function EntryStream({ resources, slug, cdnAllowed }: {
  resources: PublicCollectionResource[]
  slug: string
  cdnAllowed: boolean
}) {
  return (
    <div className="digest-entry-list">
      {resources.map((resource) => (
        <DigestEntry key={resource.node.id} resource={resource} slug={slug} cdnAllowed={cdnAllowed} />
      ))}
    </div>
  )
}

function IssueSection({ section, ordinal, slug, cdnAllowed }: {
  section: ReportIssueSection
  /** Roman numeral for top-level sections (I. Models); null for nested. */
  ordinal: string | null
  slug: string
  cdnAllowed: boolean
}) {
  const Heading = section.depth === 0 ? 'h2' : 'h3'
  return (
    <section
      className={`report-section${section.depth > 0 ? ' report-section--nested' : ''}`}
      id={`rsec-${section.id}`}
      aria-label={section.title}
    >
      <div className="report-section-head">
        <Heading>
          {ordinal ? <span className="report-section-ordinal">{`${ordinal}. `}</span> : null}
          {section.title}
        </Heading>
        <span className="report-section-count">{plural(section.resources.length, 'entry', 'entries')}</span>
      </div>
      <EntryStream resources={section.resources} slug={slug} cdnAllowed={cdnAllowed} />
    </section>
  )
}

/* The issue body is the live source Collection: the edition is a reference,
   not a copy, so the entry stream renders through the same public snapshot
   pipeline as /c/:slug — but folders land as editorial sections and each
   bookmark lands as a DigestEntry row, not a library row. */
function IssueEntries({ slug, contents, cdnAllowed }: {
  slug: string
  contents: ReportIssueContents
  cdnAllowed: boolean
}) {
  const lead = contents.lead
  const sections = contents.sections
  const total = lead.length + sections.reduce((sum, section) => sum + section.resources.length, 0)

  if (total === 0) {
    return (
      <EmptyState
        icon="collection"
        title="No visible entries"
        description="The source collection does not contain any visible items."
      />
    )
  }

  let topLevelIndex = 0

  return (
    <>
      {lead.length > 0 ? <EntryStream resources={lead} slug={slug} cdnAllowed={cdnAllowed} /> : null}
      {sections.map((section) => (
        <IssueSection
          key={section.id}
          section={section}
          ordinal={section.depth === 0 ? ROMAN[topLevelIndex++] ?? String(topLevelIndex) : null}
          slug={slug}
          cdnAllowed={cdnAllowed}
        />
      ))}
    </>
  )
}

function IssueNeighbour({ issue, slug, direction }: {
  issue: PublicReportIssue
  slug: string
  direction: 'older' | 'newer'
}) {
  const next = direction === 'newer'
  return (
    <Link
      className={next ? 'report-issue-neighbor is-next' : 'report-issue-neighbor'}
      to={reportIssuePath(slug, issue.id)}
      data-testid={`report-issue-${direction}`}
    >
      <span className="report-issue-neighbor-dir">
        {next ? null : <Icon name="arrow-left" />}
        {next ? 'Newer issue' : 'Older issue'}
        {next ? <Icon name="arrow-right" /> : null}
      </span>
      <span className="report-issue-neighbor-title">{issue.title}</span>
      <time className="report-issue-neighbor-date" dateTime={issue.publishedAt}>{formatDate(issue.publishedAt)}</time>
    </Link>
  )
}

/** /reports/:slug/issues/:editionId — one published digest issue, read as an
    edition on a single reading column. A back link returns to the series;
    the masthead carries No./date, title and summary; the curator byline and
    follow button sit under the head. Folder-derived sections follow, then a
    footer action row (Save all, votes, source collection, coverage period),
    older/newer navigation and the comments thread. */
export function ReportIssue() {
  const { slug = '', editionId } = useParams()
  const [params] = useSearchParams()
  if (params.get('embed') === '1') return <DigestEmbed slug={slug} editionId={editionId} />
  return <ReportIssuePage />
}

function ReportIssuePage() {
  const { slug = '', editionId = '' } = useParams<{ slug: string; editionId: string }>()
  const { hash } = useLocation()
  const { isLoggedIn, bootstrapping } = useAuth()
  const exposed = isReportsExposureEnabled()
  const { load, reload } = usePublicReportIssue(slug, editionId)
  const seriesLoad = usePublicReportSeries(slug)
  const [saveAll, setSaveAll] = useState<PublicCollectionResource[] | null>(null)
  const [followAuthority, setFollowAuthority] = useState<ReportFollowAuthority | null>(null)

  const issue = load.status === 'ready' ? load.issue : null
  const series = seriesLoad.load.status === 'ready' ? seriesLoad.load.series : null
  const entries = usePublicCollectionSnapshot(issue?.sourceCollectionSlug ?? null)
  const contents = entries.load.status === 'ready'
    ? reportIssueSections(entries.load.snapshot)
    : null
  const allResources = contents
    ? [...contents.lead, ...contents.sections.flatMap((section) => section.resources)]
    : []
  const total = allResources.length

  /* Deep links into anchored sections (#rsec-*) land on the section once the
     entry stream has painted. */
  useEffect(() => {
    if (!hash || !contents) return
    document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'start' })
  }, [hash, contents])

  /* document.title is owned by PageHead below (ready state); usePageMeta here
     covers every state including loading/error so tags never go stale. */
  usePageMeta(
    // R15-22: a transient error (429, 503) leaves the head alone; only an
    // unavailable or missing page is noindexed.
    load.status === 'loading' || load.status === 'error'
      ? {}
      : issue
        ? {
            description: issue.summary ?? `An issue of ${series?.title ?? 'this digest'} on Know-N.`,
            canonicalPath: reportIssuePath(slug, editionId),
            ...(series && !series.indexable ? { robots: 'noindex' as const } : {}),
          }
        : { canonicalPath: null, robots: 'noindex' as const },
    `${issue?.title ?? 'Issue'} — Know-N`,
  )

  if (!exposed || load.status === 'unavailable') {
    return (
      <AbsenceStage
        title="Issue unavailable"
        description="This issue doesn't exist or was withdrawn."
        corners={ABSENCE_CORNERS.issue}
        exits={[{ to: reportSeriesPath(slug), label: 'Back to the digest' }]}
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
          title="Couldn't load this issue"
          description={load.message}
          action={<button className="btn btn-secondary btn-sm" type="button" onClick={reload}>Try again</button>}
        />
      </PageShell>
    )
  }

  if (!issue) {
    return <RouteLoading label="Loading issue…" data-testid="report-issue-loading" />
  }

  const neighbours = series ? issueNeighbours(series.issues, issue.id) : null
  const canSaveAll = isLoggedIn && !bootstrapping && total > 0
  const period = issue.periodStart && issue.periodEnd
  const followers = followAuthority?.followerCount ?? series?.followerCount ?? null
  const hasByline = Boolean(series && (series.curator || followers != null))

  return (
    /* R9-15: locked to the /reports family track (variant="grid", 96rem) —
       see ReportSeries.tsx. */
    <PageShell variant="grid">
      <div className="report-layout" data-testid="report-issue-page">
        <article className="report-edition">
          <PageHead
            as="header"
            className="page-head--editorial page-head--social"
            layout="masthead"
            breadcrumb={(
              <Breadcrumb
                items={[
                  { label: 'Digests', to: '/reports' },
                  { label: series?.title ?? 'Digest', to: reportSeriesPath(slug) },
                  { label: issue.title },
                ]}
              />
            )}
            documentTitle={issue.title}
            eyebrow={
              <span className="meta-row report-issue-meta">
                {issue.editionOrdinal != null ? <span>No. {issue.editionOrdinal}</span> : null}
                <span><time dateTime={issue.publishedAt}>{formatDate(issue.publishedAt)}</time></span>
                {period ? (
                  <span data-testid="report-issue-period">
                    Covers <time dateTime={issue.periodStart!}>{formatCalendarDate(issue.periodStart!)}</time>
                    {' – '}
                    <time dateTime={issue.periodEnd!}>{formatCalendarDate(issue.periodEnd!)}</time>
                  </span>
                ) : null}
              </span>
            }
            title={issue.title}
            actions={series ? (
              /* Same cluster as the series masthead: Follow, then the CS-01
                 edition vote pill. Edition votes need the series id, which
                 only the series projection carries, so the whole slot waits
                 for that load to settle. */
              <SocialActions
                follow={<ReportFollowButton reportId={series.id} onState={setFollowAuthority} />}
                vote={
                  <CommunityVoteControl
                    query={{ kind: 'digest_edition', id: issue.id, seriesId: series.id }}
                  />
                }
                links={(
                  <><SubscribeButton sourceType="digest_series" sourceId={series.id} /><EmbedShareButton
                    detailHeight={28}
                    path={reportIssuePath(slug, editionId)}
                    title={issue.title}
                    rowCount={total}
                    label="Embed this issue"
                  /><ReportButton
                    target={{ kind: 'digest_edition', id: issue.id, seriesId: series.id }}
                    label="this issue"
                    testId="report-digest-issue"
                  /></>
                )}
              />
            ) : (
              /* Holds the cluster's row while the series loads, so the
                 masthead does not shift when Follow and the vote land. */
              <div className="social-actions social-actions--pending" aria-hidden="true" data-testid="social-actions-pending" />
            )}
          >
            {/* Summary + byline card above the action toolbar — see
                ReportSeries.tsx. */}
            {issue.summary || hasByline ? (
              <div className="report-summary">
                {issue.summary ? <p className="lede">{issue.summary}</p> : null}
                {series && hasByline ? (
                  <p className="meta-row report-series-byline">
                    {series.curator ? (
                      <span>
                        by{' '}
                        <ProfileHoverCard
                          handle={series.curator.handle}
                          displayName={series.curator.displayName}
                          avatarUrl={series.curator.avatarUrl}
                          profileId={series.curator.profileId}
                        >
                          <strong>{series.curator.displayName}</strong>
                          <span className="avatar collection-curator-avatar" aria-hidden>
                            <AvatarImage
                              url={series.curator.avatarUrl}
                              initials={profileInitials(series.curator.displayName, series.curator.handle)}
                            />
                          </span>
                        </ProfileHoverCard>
                      </span>
                    ) : null}
                    {/* The live follower count rides the byline, not the button:
                        the masthead slot holds controls only. */}
                    {followers != null ? (
                      <span data-testid="report-issue-followers">{plural(followers, 'follower')}</span>
                    ) : null}
                  </p>
                ) : null}
              </div>
            ) : null}
          </PageHead>

          <section className="report-entries" aria-label="Issue entries" data-testid="report-entries">
            {issue.sourceCollectionSlug ? (
              entries.load.status === 'loading' ? (
                <LoadingState label="Loading entries…" data-testid="report-issue-entries-loading" />
              ) : entries.load.status !== 'ready' ? (
                <EmptyState
                  role={entries.load.status === 'error' ? 'alert' : 'status'}
                  icon="collection"
                  title={entries.load.status === 'error' ? "Couldn't load this issue's entries" : 'Entries unavailable'}
                  description={entries.load.status === 'error'
                    ? entries.load.message
                    : "The source collection for this issue isn't available."}
                  action={
                    <>
                      {entries.load.status === 'error' ? (
                        <button className="btn btn-secondary btn-sm" type="button" onClick={entries.retry}>Try again</button>
                      ) : null}
                      <Link className="btn btn-ghost btn-sm" to={`/c/${encodeURIComponent(issue.sourceCollectionSlug)}`}>Open the collection</Link>
                    </>
                  }
                />
              ) : contents === null ? (
                <EmptyState
                  icon="collection"
                  title="Entries unavailable"
                  description="The source collection for this issue isn't available."
                />
              ) : (
                <IssueEntries
                  slug={issue.sourceCollectionSlug}
                  contents={contents}
                  cdnAllowed={entries.load.status === 'ready' && entries.load.snapshot.collection.faviconCdnAllowed === true}
                />
              )
            ) : (
              <EmptyState
                icon="collection"
                title="Entries unavailable"
                description="This issue doesn't link to a public collection."
              />
            )}
          </section>

          {canSaveAll || issue.sourceCollectionSlug ? (
            <div className="report-issue-actions">
              {canSaveAll ? (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setSaveAll(allResources)}
                >
                  Save all to library
                </button>
              ) : null}
              {issue.sourceCollectionSlug ? (
                <Link
                  className="btn btn-ghost btn-sm"
                  to={`/c/${encodeURIComponent(issue.sourceCollectionSlug)}`}
                >
                  Source collection
                </Link>
              ) : null}
            </div>
          ) : null}

          {neighbours && (neighbours.older || neighbours.newer) ? (
            <nav className="report-issue-neighbors" aria-label="More issues in this digest">
              {neighbours.older ? (
                <IssueNeighbour issue={neighbours.older} slug={slug} direction="older" />
              ) : (
                <span aria-hidden="true" />
              )}
              {neighbours.newer ? (
                <IssueNeighbour issue={neighbours.newer} slug={slug} direction="newer" />
              ) : (
                <span aria-hidden="true" />
              )}
            </nav>
          ) : null}

          {/* CS-03: edition comments need the series id for the same
              digest_edition target the vote control uses. */}
          {series ? (
            <CommunityComments
              query={{ kind: 'digest_edition', id: issue.id, seriesId: series.id }}
            />
          ) : null}
        </article>
      </div>

      {saveAll ? (
        <SaveResourcePicker resources={saveAll} onClose={() => setSaveAll(null)} />
      ) : null}
    </PageShell>
  )
}
