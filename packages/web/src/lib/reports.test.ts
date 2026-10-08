import { describe, expect, it } from 'vitest'
import type { PublicReportIssue } from '../api/types'
import { firstVisibleIssue, issueNeighbours, reportIssuePath, reportSeriesPath, sharedSourceCollectionSlug } from './reports'

function issue(id: string): PublicReportIssue {
  return { id, title: id, summary: null, publishedAt: '2026-09-01T00:00:00.000Z', url: `/reports/s/issues/${id}` }
}

describe('report paths', () => {
  it('encodes slugs and issue ids once', () => {
    expect(reportSeriesPath('weekly notes/2026')).toBe('/reports/weekly%20notes%2F2026')
    expect(reportIssuePath('weekly-notes', 'ed 1?')).toBe('/reports/weekly-notes/issues/ed%201%3F')
  })
})

describe('issueNeighbours', () => {
  const archive = [issue('newest'), issue('middle'), issue('oldest')]

  it('reads the newest-first archive so the next entry is the older issue', () => {
    expect(issueNeighbours(archive, 'middle')).toEqual({ older: archive[2], newer: archive[0] })
  })

  it('leaves the missing side null at either end of the archive', () => {
    expect(issueNeighbours(archive, 'newest')).toEqual({ older: archive[1], newer: null })
    expect(issueNeighbours(archive, 'oldest')).toEqual({ older: null, newer: archive[1] })
  })

  it('returns null when the issue is outside the bounded archive', () => {
    expect(issueNeighbours(archive, 'ancient')).toBeNull()
    expect(issueNeighbours([], 'newest')).toBeNull()
  })

  it('skips hide_public tombstones so a footer link never lands on a gated edition', () => {
    const tombstone = { ...issue('middle'), state: 'hidden' as const, url: null }
    const withHidden = [archive[0]!, tombstone, archive[2]!]
    expect(issueNeighbours(withHidden, 'newest')).toEqual({ older: archive[2], newer: null })
    expect(issueNeighbours(withHidden, 'oldest')).toEqual({ older: null, newer: archive[0] })
  })
})

describe('sharedSourceCollectionSlug', () => {
  it('returns the slug only when every readable issue shares it', () => {
    const shared = [
      { ...issue('newest'), sourceCollectionSlug: 'climate' },
      { ...issue('older'), sourceCollectionSlug: 'climate' },
    ]
    expect(sharedSourceCollectionSlug(shared)).toBe('climate')
    expect(sharedSourceCollectionSlug([
      { ...issue('newest'), sourceCollectionSlug: 'papers' },
      { ...issue('older'), sourceCollectionSlug: 'engineering' },
    ])).toBeNull()
  })

  it('ignores hide_public tombstones and hides the link when a readable issue has no source', () => {
    const tombstone = { ...issue('hidden'), state: 'hidden' as const, url: null, sourceCollectionSlug: null }
    const readable = { ...issue('older'), sourceCollectionSlug: 'climate' }
    expect(sharedSourceCollectionSlug([tombstone, readable])).toBe('climate')
    expect(sharedSourceCollectionSlug([
      readable,
      { ...issue('sourceless'), sourceCollectionSlug: null },
    ])).toBeNull()
    expect(sharedSourceCollectionSlug([tombstone])).toBeNull()
    expect(sharedSourceCollectionSlug([])).toBeNull()
  })
})

describe('firstVisibleIssue', () => {
  it('returns the newest readable edition, skipping hide_public tombstones', () => {
    const newest = issue('newest')
    const older = issue('older')
    expect(firstVisibleIssue([newest, older])).toBe(newest)
    const tombstone = { ...issue('tombstone'), state: 'hidden' as const, url: null }
    expect(firstVisibleIssue([tombstone, older])).toBe(older)
    expect(firstVisibleIssue([tombstone])).toBeNull()
    expect(firstVisibleIssue([])).toBeNull()
  })
})
