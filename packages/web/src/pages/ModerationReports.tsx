import { useEffect, useState } from 'react'
import { isLive, isProductApiError, productClient } from '../api'
import { useAuth } from '../auth/AuthContext'
import { EmptyState } from '../components/EmptyState'
import { LoadMoreButton } from '../components/LoadMoreButton'
import { PageHead } from '../components/PageHead'
import { PageSection, PageShell } from '../components/PageShell'
import { RouteState } from '../components/RouteState'
import { StatusBadge } from '../components/StatusBadge'
import { ModerationRow, ModerationStatusFilter, ModerationTable } from '../components/ModerationTable'
import type { GovernanceMyCase } from '@known/product-v1-client'
import { formatDate } from '../lib/formatDate'
import { governanceTargetHref, governanceTargetKind, governanceTargetMeta } from '../lib/governanceTarget'
import {
  MODERATION_CATEGORY_LABEL,
  MODERATION_STATUS_LABEL,
  MODERATION_STATUS_TONE,
  humanLabel,
} from '../lib/moderationLabels'
import '../styles/moderation.css'

const PAGE_LIMIT = 20

type StatusFilter = 'all' | 'submitted' | 'in_review' | 'resolved' | 'dismissed'
const STATUS_FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'submitted', label: 'Submitted' },
  { value: 'in_review', label: 'In review' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'dismissed', label: 'Dismissed' },
]
const statusQuery = (status: StatusFilter) => (status === 'all' ? {} : { status })

export function ModerationReports() {
  const { isLoggedIn } = useAuth()
  const enabled = isLive('contentGovernance')
  const [items, setItems] = useState<GovernanceMyCase[] | null>(null)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [status, setStatus] = useState<StatusFilter>('all')

  useEffect(() => {
    if (!isLoggedIn) return
    if (!enabled) {
      setItems([])
      return
    }
    const controller = new AbortController()
    setError(null)
    setItems(null)
    setNextCursor(null)
    productClient.listMyModerationReports({ ...statusQuery(status), limit: PAGE_LIMIT }, { signal: controller.signal, maxRetries: 0 })
      .then((page) => {
        if (controller.signal.aborted) return
        setItems([...page.items])
        setNextCursor(page.nextCursor)
        setMoreError(false)
      })
      .catch((err) => {
        if (controller.signal.aborted) return
        if (isProductApiError(err) && err.status === 404) {
          setItems([])
          return
        }
        setError(isProductApiError(err) ? err.recoveryHint : "Couldn't load reports")
      })
    return () => controller.abort()
  }, [enabled, isLoggedIn, attempt, status])

  async function loadMore() {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    setMoreError(false)
    try {
      const page = await productClient.listMyModerationReports({ ...statusQuery(status), limit: PAGE_LIMIT, cursor: nextCursor }, { maxRetries: 0 })
      setItems((current) => {
        const seen = new Set((current ?? []).map((item) => item.id))
        return [...(current ?? []), ...page.items.filter((item) => !seen.has(item.id))]
      })
      setNextCursor(page.nextCursor)
    } catch {
      setMoreError(true)
    } finally {
      setLoadingMore(false)
    }
  }

  return (
    <PageShell>
      <PageHead
        variant="workbench"
        documentTitle="My content reports"
        eyebrow="Moderation"
        title="My content reports"
        lede="Status and public outcomes for reports you submitted."
      />
      <PageSection>
        {!enabled ? (
          <RouteState
            kind="unavailable"
            icon="bell"
            title="Moderation reports are not available yet"
            feature="Moderation reports"
          />
        ) : !isLoggedIn ? (
          <RouteState kind="auth" returnTo="/moderation/reports" />
        ) : error ? (
          <RouteState
            kind="error"
            title="Couldn't load reports"
            description={error}
            onRetry={() => setAttempt((current) => current + 1)}
          />
        ) : (
          <div className="stack">
            {status !== 'all' || items === null || items.length > 0 ? (
              <ModerationStatusFilter value={status} options={STATUS_FILTERS} onChange={setStatus} />
            ) : null}
            {items === null ? (
              <RouteState kind="loading" loadingLabel="Loading reports" />
            ) : items.length === 0 ? (
              <EmptyState
                icon="collection"
                title={status === 'all' ? 'No reports yet' : 'No reports with this status'}
                description="Reports you submit appear here, with their status and public outcome."
              />
            ) : (
              <ModerationTable label="My content reports" testId="moderation-report-list">
                {items.map((item) => (
                  <ModerationRow
                    key={item.id}
                    title={governanceTargetKind(item.target)}
                    href={governanceTargetHref(item.target)}
                    meta={`${governanceTargetMeta(item.target)} · Reported ${formatDate(item.createdAt)}`}
                    reason={humanLabel(MODERATION_CATEGORY_LABEL, item.category)}
                    status={(
                      <StatusBadge tone={MODERATION_STATUS_TONE[item.status] ?? 'neutral'}>
                        {humanLabel(MODERATION_STATUS_LABEL, item.status)}
                      </StatusBadge>
                    )}
                    note={item.publicResolution}
                  />
                ))}
              </ModerationTable>
            )}
            {nextCursor ? (
              <div className="moderation-more">
                <LoadMoreButton
                  loading={loadingMore}
                  onClick={() => void loadMore()}
                  status="Loading more reports"
                />
                {moreError ? <p className="field-error" role="alert">Couldn't load more reports.</p> : null}
              </div>
            ) : null}
          </div>
        )}
      </PageSection>
    </PageShell>
  )
}
