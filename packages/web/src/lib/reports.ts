import type { PublicReportIssue } from '../api'

/** SPA routes for the News Digest surfaces (/reports*), encoded once. */
export function reportSeriesPath(slug: string): string {
  return `/reports/${encodeURIComponent(slug)}`
}

export function reportIssuePath(slug: string, issueId: string): string {
  return `${reportSeriesPath(slug)}/issues/${encodeURIComponent(issueId)}`
}

/** Short edition label for pickers: `No. 12`, else the issue key, else null. */
export function issueLabel(issue: PublicReportIssue): string | null {
  if (issue.editionOrdinal != null) return `No. ${issue.editionOrdinal}`
  return issue.issueKey ?? null
}

/**
 * #21: the newest READABLE edition. A hide_public tombstone keeps its
 * archive slot as a position fact, but it never fronts the nameplate, the
 * rail's Latest stat, or any other lead position.
 */
export function firstVisibleIssue(issues: readonly PublicReportIssue[]): PublicReportIssue | null {
  return issues.find((issue) => issue.state !== 'hidden') ?? null
}

/**
 * Slug for a series-level "Source collection" link. The series has one source
 * only when every readable issue points at that same collection. A hide_public
 * tombstone has no slug and is ignored. Rotated sources stay on each issue.
 */
export function sharedSourceCollectionSlug(issues: readonly PublicReportIssue[]): string | null {
  let shared: string | null = null
  for (const issue of issues) {
    if (issue.state === 'hidden') continue
    const slug = issue.sourceCollectionSlug
    if (!slug) return null
    if (shared === null) shared = slug
    else if (shared !== slug) return null
  }
  return shared
}

export type IssueNeighbours = {
  /** Published before the current issue (further down the newest-first archive). */
  older: PublicReportIssue | null
  /** Published after the current issue (further up the archive). */
  newer: PublicReportIssue | null
}

/**
 * Neighbouring issues of `issueId` inside a series archive. The public
 * projection sorts issues newest-first, so the entry after the current one
 * is the older issue. Returns null when the issue is not in the (bounded)
 * archive, in which case the page renders no neighbour navigation.
 */
export function issueNeighbours(
  issues: readonly PublicReportIssue[],
  issueId: string,
): IssueNeighbours | null {
  if (!issues.some((issue) => issue.id === issueId)) return null
  // #21: neighbours are navigation, not the archive listing — a hide_public
  // tombstone is skipped so the footer never links into a gated edition.
  const readable = issues.filter((issue) => issue.state !== 'hidden')
  const index = readable.findIndex((issue) => issue.id === issueId)
  if (index === -1) return { newer: null, older: null }
  return {
    newer: readable[index - 1] ?? null,
    older: readable[index + 1] ?? null,
  }
}
