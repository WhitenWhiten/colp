import { isReportsExposureEnabled, type PublicReportIssue, type PublicReportSeries } from '../../api'
import { canonicalSiteOrigin } from '../../lib/chrome'
import { formatDate } from '../../lib/formatDate'
import { flattenPublicCollection } from '../../lib/publicCollectionTree'
import { firstVisibleIssue, issueLabel, reportIssuePath, reportSeriesPath } from '../../lib/reports'
import { useDocumentTitle } from '../../lib/useDocumentTitle'
import { usePageMeta } from '../../lib/usePageMeta'
import { usePublicCollectionSnapshot } from '../../lib/usePublicCollectionSnapshot'
import { usePublicReportIssue } from '../../lib/usePublicReportIssue'
import { usePublicReportSeries } from '../../lib/usePublicReportSeries'
import { EmbedCard, EmbedState, resourceEmbedRows } from './EmbedCard'

/** Gate before mounting hooks: disabled deployments do not fetch digest data. */
export function DigestEmbed({ slug, editionId }: { slug: string; editionId?: string }) {
  if (!isReportsExposureEnabled()) return <DigestUnavailable />
  return editionId
    ? <IssueEmbed key={`${slug}:${editionId}`} slug={slug} editionId={editionId} />
    : <SeriesEmbed key={slug} slug={slug} />
}

function DigestUnavailable() {
  useDocumentTitle('Digest unavailable')
  usePageMeta({ canonicalPath: null, robots: 'noindex' }, 'Digest unavailable — Know-N')
  return <EmbedState message="This digest is not available." />
}

function SeriesEmbed({ slug }: { slug: string }) {
  const { load, reload } = usePublicReportSeries(slug)
  if (load.status === 'loading') return <EmbedState loading />
  if (load.status === 'error') return <EmbedState message={load.message} retry={reload} />
  if (load.status === 'unavailable') return <DigestUnavailable />
  const latest = firstVisibleIssue(load.series.issues)
  return <DigestContent key={`${latest?.id}:${latest?.sourceCollectionSlug}`} series={load.series} issue={latest} />
}

function IssueEmbed({ slug, editionId }: { slug: string; editionId: string }) {
  const { load, reload } = usePublicReportIssue(slug, editionId)
  const series = usePublicReportSeries(slug)
  if (load.status === 'unavailable' || series.load.status === 'unavailable'
    || (load.status === 'ready' && load.issue.state === 'hidden')) return <DigestUnavailable />
  if (load.status === 'error') return <EmbedState message={load.message} retry={reload} />
  if (series.load.status === 'error') return <EmbedState message={series.load.message} retry={series.reload} />
  if (load.status !== 'ready' || series.load.status !== 'ready') return <EmbedState loading />
  return <DigestContent key={`${load.issue.id}:${load.issue.sourceCollectionSlug}`} series={series.load.series} issue={load.issue} fixedIssue />
}

function DigestContent({ series, issue, fixedIssue = false }: { series: PublicReportSeries; issue: PublicReportIssue | null; fixedIssue?: boolean }) {
  // The issue projection, never the series' current source, owns the edition contents.
  const { load, retry } = usePublicCollectionSnapshot(issue?.sourceCollectionSlug ?? null)
  const title = fixedIssue && issue ? issue.title : series.title
  const summary = fixedIssue && issue ? issue.summary : series.summary
  const path = fixedIssue && issue ? reportIssuePath(series.slug, issue.id) : reportSeriesPath(series.slug)
  useDocumentTitle(title)
  usePageMeta({ description: summary ?? undefined, canonicalPath: path, ...(series.indexable ? {} : { robots: 'noindex' }) }, `${title} — Know-N`)
  if (issue?.sourceCollectionSlug && load.status === 'loading') return <EmbedState loading />
  if (issue?.sourceCollectionSlug && load.status === 'error') return <EmbedState message={load.message} retry={retry} />
  // A withdrawn source must not reveal a cached collection or fall back to a different issue.
  if (issue?.sourceCollectionSlug && load.status === 'unavailable') return <EmbedState message="This issue's contents are not available." />
  const snapshot = issue?.sourceCollectionSlug && load.status === 'ready' ? load.snapshot : null
  const published = snapshot ? flattenPublicCollection(snapshot) : null
  if (snapshot && !published) return <EmbedState message="This issue's contents are not available." />
  const resources = published?.resources ?? []
  const issueHref = issue ? `${canonicalSiteOrigin()}${reportIssuePath(series.slug, issue.id)}` : undefined
  return <EmbedCard title={title} label={fixedIssue ? 'Digest issue' : 'News digest'} summary={summary}
    curator={series.curator} rows={resourceEmbedRows(resources, snapshot?.collection.faviconCdnAllowed === true)}
    openHref={`${canonicalSiteOrigin()}${path}`} moreHref={issueHref}
    detail={issue ? <a href={issueHref} target="_blank" rel="noreferrer">{fixedIssue ? issueLabel(issue) : `Latest · ${issue.title}`} · {formatDate(issue.publishedAt)}</a> : null}
    emptyMessage={issue ? 'No public links in this issue yet.' : 'No published issues yet.'} />
}
