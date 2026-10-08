import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { isLive, isProductApiError, productClient } from '../../api'
import { useAuth } from '../../auth/AuthContext'
import { EmptyState } from '../../components/EmptyState'
import { LoadMoreButton } from '../../components/LoadMoreButton'
import { PageHead } from '../../components/PageHead'
import { PageSection, PageShell } from '../../components/PageShell'
import { RouteState } from '../../components/RouteState'
import { StatusBadge } from '../../components/StatusBadge'
import {
  MODERATION_CATEGORY_LABEL,
  MODERATION_STATUS_LABEL,
  MODERATION_STATUS_TONE,
  humanLabel,
} from '../../lib/moderationLabels'
import { governanceTargetKind, governanceTargetMeta } from '../../lib/governanceTarget'
import { formatDate } from '../../lib/formatDate'
import { ModerationRow, ModerationStatusFilter, ModerationTable } from '../../components/ModerationTable'
import type { GovernanceOfficialCase } from '@known/product-v1-client'
import '../../styles/moderation.css'
import { privateSessionIdentity, subscribeSession } from '../../api/sessionStore'

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

export function ModerationCases() {
  const { isLoggedIn } = useAuth()
  const sessionIdentity = useSyncExternalStore(subscribeSession, privateSessionIdentity, privateSessionIdentity)
  const enabled = isLive('contentGovernance')
  const [items, setItems] = useState<GovernanceOfficialCase[] | null>(null)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [forbidden, setForbidden] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [status, setStatus] = useState<StatusFilter>('all')
  const renderedIdentityRef = useRef(sessionIdentity)

  useEffect(() => {
    renderedIdentityRef.current = sessionIdentity
    if (!isLoggedIn) return
    if (!enabled) {
      setItems([])
      return
    }
    const controller = new AbortController()
    const requestIdentity = sessionIdentity
    setError(null)
    setForbidden(false)
    setItems(null)
    setNextCursor(null)
    productClient.listModerationCases({ ...statusQuery(status), limit: PAGE_LIMIT }, { signal: controller.signal, maxRetries: 0 })
      .then((page) => {
        if (controller.signal.aborted || privateSessionIdentity() !== requestIdentity) return
        setItems([...page.items])
        setNextCursor(page.nextCursor)
        setMoreError(false)
      })
      .catch((err) => {
        if (controller.signal.aborted || privateSessionIdentity() !== requestIdentity) return
        if (isProductApiError(err) && (err.status === 403 || err.status === 404)) {
          setForbidden(true)
          return
        }
        setError(isProductApiError(err) ? err.recoveryHint : "Couldn't load cases")
      })
    return () => controller.abort()
  }, [enabled, isLoggedIn, attempt, status, sessionIdentity])

  async function loadMore() {
    if (!nextCursor || loadingMore) return
    const requestIdentity = sessionIdentity
    setLoadingMore(true)
    setMoreError(false)
    try {
      const page = await productClient.listModerationCases({ ...statusQuery(status), limit: PAGE_LIMIT, cursor: nextCursor }, { maxRetries: 0 })
      if (privateSessionIdentity() !== requestIdentity) return
      setItems((current) => {
        const seen = new Set((current ?? []).map((row) => row.case.id))
        return [...(current ?? []), ...page.items.filter((row) => !seen.has(row.case.id))]
      })
      setNextCursor(page.nextCursor)
    } catch {
      if (privateSessionIdentity() === requestIdentity) setMoreError(true)
    } finally {
      if (privateSessionIdentity() === requestIdentity) setLoadingMore(false)
    }
  }

  const identityReady = renderedIdentityRef.current === sessionIdentity
  const visibleItems = identityReady ? items : null
  const visibleNextCursor = identityReady ? nextCursor : null
  const visibleLoadingMore = identityReady ? loadingMore : false
  const visibleMoreError = identityReady ? moreError : false
  const visibleError = identityReady ? error : null
  const visibleForbidden = identityReady ? forbidden : false

  return (
    <PageShell>
      <PageHead
        variant="workbench"
        documentTitle="Moderation cases"
        eyebrow="Admin"
        title="Moderation cases"
        lede="Reports that need an official decision. Actions are checked on the server."
      />
      <PageSection>
        {!enabled ? (
          <RouteState
            kind="unavailable"
            icon="bell"
            title="Moderation cases are not available yet"
            feature="Moderation cases"
          />
        ) : !isLoggedIn ? (
          <RouteState kind="auth" returnTo="/admin/moderation/cases" />
        ) : visibleForbidden ? (
          <RouteState
            kind="forbidden"
            title="Official reviewer access is required."
            description="This console is limited to official reviewers."
          />
        ) : visibleError ? (
          <RouteState
            kind="error"
            title="Couldn't load cases"
            description={visibleError}
            onRetry={() => setAttempt((current) => current + 1)}
          />
        ) : (
          <div className="stack">
            {status !== 'all' || visibleItems === null || visibleItems.length > 0 ? (
              <ModerationStatusFilter value={status} options={STATUS_FILTERS} onChange={setStatus} />
            ) : null}
            {visibleItems === null ? (
              <RouteState kind="loading" loadingLabel="Loading cases" />
            ) : visibleItems.length === 0 ? (
              <EmptyState
                icon="collection"
                title={status === 'all' ? 'No cases' : 'No cases with this status'}
                description="Reported content waiting for an official review appears here."
              />
            ) : (
              <ModerationTable label="Moderation cases" testId="admin-moderation-case-list">
                {visibleItems.map((item) => (
                  <ModerationRow
                    key={item.case.id}
                    title={governanceTargetKind(item.case.target)}
                    href={`/admin/moderation/cases/${item.case.id}`}
                    meta={`${governanceTargetMeta(item.case.target)} · Reported ${formatDate(item.case.createdAt)}`}
                    reason={humanLabel(MODERATION_CATEGORY_LABEL, item.case.category)}
                    detail={item.description}
                    status={(
                      <StatusBadge tone={MODERATION_STATUS_TONE[item.case.status] ?? 'neutral'}>
                        {humanLabel(MODERATION_STATUS_LABEL, item.case.status)}
                      </StatusBadge>
                    )}
                    note={item.case.publicResolution}
                  />
                ))}
              </ModerationTable>
            )}
            {visibleNextCursor ? (
              <div className="moderation-more">
                <LoadMoreButton
                  loading={visibleLoadingMore}
                  onClick={() => void loadMore()}
                  status="Loading more cases"
                />
                {visibleMoreError ? <p className="field-error" role="alert">Couldn't load more cases.</p> : null}
              </div>
            ) : null}
          </div>
        )}
      </PageSection>
    </PageShell>
  )
}
