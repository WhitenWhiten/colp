import { useEffect, useState } from 'react'
import { isLive, isProductApiError, productClient } from '../../api'
import { useAuth } from '../../auth/AuthContext'
import { useToast } from '../../components/AppToast'
import { useConfirm } from '../../components/ConfirmModal'
import { EmptyState } from '../../components/EmptyState'
import { LoadMoreButton } from '../../components/LoadMoreButton'
import { PageHead } from '../../components/PageHead'
import { PageSection, PageShell } from '../../components/PageShell'
import { RouteState } from '../../components/RouteState'
import { StatusBadge } from '../../components/StatusBadge'
import type { GovernanceAppeal } from '@known/product-v1-client'
import { humanLabel, MODERATION_APPEAL_STATUS_LABEL, MODERATION_APPEAL_STATUS_TONE } from '../../lib/moderationLabels'
import { ModerationRow, ModerationStatusFilter, ModerationTable } from '../../components/ModerationTable'
import { shortGovernanceId } from '../../lib/governanceTarget'
import { formatDate } from '../../lib/formatDate'
import '../../styles/moderation.css'

const PAGE_LIMIT = 20

type StatusFilter = 'all' | 'submitted' | 'upheld' | 'rejected'
const STATUS_FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'submitted', label: 'Submitted' },
  { value: 'upheld', label: 'Upheld' },
  { value: 'rejected', label: 'Rejected' },
]
const statusQuery = (status: StatusFilter) => (status === 'all' ? {} : { status })

export function ModerationAppeals() {
  const { isLoggedIn } = useAuth()
  const confirm = useConfirm()
  const { success } = useToast()
  const enabled = isLive('contentGovernance')
  const [items, setItems] = useState<GovernanceAppeal[] | null>(null)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [forbidden, setForbidden] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [status, setStatus] = useState<StatusFilter>('all')

  useEffect(() => {
    if (!isLoggedIn) return
    if (!enabled) {
      setItems([])
      return
    }
    const controller = new AbortController()
    setLoadError(null)
    setForbidden(false)
    setItems(null)
    setNextCursor(null)
    productClient.listModerationAppeals({ ...statusQuery(status), limit: PAGE_LIMIT }, { signal: controller.signal, maxRetries: 0 })
      .then((page) => {
        if (controller.signal.aborted) return
        setItems([...page.items])
        setNextCursor(page.nextCursor)
        setMoreError(false)
      })
      .catch((err) => {
        if (controller.signal.aborted) return
        if (isProductApiError(err) && (err.status === 403 || err.status === 404)) {
          setForbidden(true)
          return
        }
        setLoadError(isProductApiError(err) ? err.recoveryHint : "Couldn't load appeals")
      })
    return () => controller.abort()
  }, [enabled, isLoggedIn, attempt, status])

  async function decide(item: GovernanceAppeal, decision: 'uphold' | 'reject') {
    const title = decision === 'uphold' ? 'Uphold this appeal?' : 'Reject this appeal?'
    const confirmLabel = decision === 'uphold' ? 'Uphold' : 'Reject'
    if (!(await confirm({ title, confirmLabel }))) return
    setBusy(true)
    setActionError(null)
    try {
      const updated = await productClient.decideModerationAppeal(
        item.id,
        {
          decision,
          resolution: decision === 'uphold'
            ? 'Uphold appeal and revoke only this action.'
            : 'Reject appeal; the action remains active.',
        },
        `"${item.revision}"`,
        { intentId: productClient.mutationIntentKey('moderation-appeal-decide', productClient.newCommandId()), maxRetries: 0 },
      )
      setItems((current) => (current ?? []).map((row) => row.id === updated.id ? updated : row))
      success(decision === 'uphold' ? 'Appeal upheld.' : 'Appeal rejected.')
    } catch (err) {
      setActionError(isProductApiError(err) ? err.recoveryHint : 'Appeal could not be decided')
    } finally {
      setBusy(false)
    }
  }

  async function loadMore() {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    setMoreError(false)
    try {
      const page = await productClient.listModerationAppeals({ ...statusQuery(status), limit: PAGE_LIMIT, cursor: nextCursor }, { maxRetries: 0 })
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
        documentTitle="Moderation appeals"
        eyebrow="Admin"
        title="Moderation appeals"
        lede="Server-checked official decisions. Uphold revokes only the appealed action."
      />
      <PageSection>
        {!enabled ? (
          <RouteState
            kind="unavailable"
            icon="bell"
            title="Moderation appeals are not available yet"
            feature="Moderation appeals"
          />
        ) : !isLoggedIn ? (
          <RouteState kind="auth" returnTo="/admin/moderation/appeals" />
        ) : forbidden ? (
          <RouteState
            kind="forbidden"
            title="Official reviewer access is required."
            description="This console is limited to official reviewers."
          />
        ) : loadError ? (
          <RouteState
            kind="error"
            title="Couldn't load appeals"
            description={loadError}
            onRetry={() => setAttempt((current) => current + 1)}
          />
        ) : (
          <div className="stack">
            {status !== 'all' || items === null || items.length > 0 ? (
              <ModerationStatusFilter value={status} options={STATUS_FILTERS} onChange={setStatus} />
            ) : null}
            {actionError ? <p className="field-error" role="alert">{actionError}</p> : null}
            {items === null ? (
              <RouteState kind="loading" loadingLabel="Loading appeals" />
            ) : items.length === 0 ? (
              <EmptyState
                icon="collection"
                title={status === 'all' ? 'No appeals' : 'No appeals with this status'}
                description="Appeals waiting for an official decision appear here."
              />
            ) : (
              <ModerationTable label="Moderation appeals" testId="admin-moderation-appeal-list" subjectLabel="Appeal" actionsLabel="Decision">
                {items.map((item) => (
                  <ModerationRow
                    key={item.id}
                    title="Appeal"
                    meta={`Action ${shortGovernanceId(item.actionId)} · Submitted ${formatDate(item.createdAt)}`}
                    detail={item.description}
                    status={(
                      <StatusBadge tone={MODERATION_APPEAL_STATUS_TONE[item.status] ?? 'neutral'}>
                        {humanLabel(MODERATION_APPEAL_STATUS_LABEL, item.status)}
                      </StatusBadge>
                    )}
                    note={item.resolution}
                    actions={item.status === 'submitted' ? (
                      <>
                        <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void decide(item, 'uphold')}>Uphold</button>
                        <button type="button" className="btn btn-danger-ghost btn-sm" disabled={busy} onClick={() => void decide(item, 'reject')}>Reject</button>
                      </>
                    ) : null}
                  />
                ))}
              </ModerationTable>
            )}
            {nextCursor ? (
              <div className="moderation-more">
                <LoadMoreButton
                  loading={loadingMore}
                  onClick={() => void loadMore()}
                  status="Loading more appeals"
                />
                {moreError ? <p className="field-error" role="alert">Couldn't load more appeals.</p> : null}
              </div>
            ) : null}
          </div>
        )}
      </PageSection>
    </PageShell>
  )
}
