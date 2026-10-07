import { useEffect, useState } from 'react'
import { isLive, isProductApiError, productClient } from '../api'
import { useAuth } from '../auth/AuthContext'
import { useToast } from '../components/AppToast'
import { EmptyState } from '../components/EmptyState'
import { LoadMoreButton } from '../components/LoadMoreButton'
import { PageHead } from '../components/PageHead'
import { PageSection, PageShell } from '../components/PageShell'
import { RouteState } from '../components/RouteState'
import type { GovernanceAppeal, GovernanceMyAction } from '@known/product-v1-client'
import { formatGovernanceTarget, governanceTargetKind, governanceTargetMeta } from '../lib/governanceTarget'
import { humanLabel, MODERATION_ACTION_LABEL, MODERATION_APPEAL_STATUS_LABEL, MODERATION_APPEAL_STATUS_TONE } from '../lib/moderationLabels'
import { StatusBadge } from '../components/StatusBadge'
import { ModerationRow, ModerationStatusFilter, ModerationTable } from '../components/ModerationTable'
import { formatDate } from '../lib/formatDate'
import '../styles/moderation.css'

const PAGE_LIMIT = 20

type StatusFilter = 'all' | 'submitted' | 'upheld' | 'rejected'
const STATUS_FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'submitted', label: 'Submitted' },
  { value: 'upheld', label: 'Upheld' },
  { value: 'rejected', label: 'Rejected' },
]

export function ModerationAppeals() {
  const { isLoggedIn } = useAuth()
  const { success } = useToast()
  const enabled = isLive('contentGovernance')
  const [items, setItems] = useState<GovernanceAppeal[] | null>(null)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState(false)
  const [actions, setActions] = useState<GovernanceMyAction[]>([])
  // Every action affecting me (active or revoked) resolves an appeal's subject.
  const [knownActions, setKnownActions] = useState<readonly GovernanceMyAction[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [actionId, setActionId] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [status, setStatus] = useState<StatusFilter>('all')

  useEffect(() => {
    if (!isLoggedIn) return
    if (!enabled) {
      setItems([])
      setActions([])
      return
    }
    const controller = new AbortController()
    setLoadError(null)
    Promise.all([
      productClient.listMyModerationAppeals({ limit: PAGE_LIMIT }, { signal: controller.signal, maxRetries: 0 }),
      productClient.listActionsAffectingMe({ limit: 50 }, { signal: controller.signal, maxRetries: 0 }),
    ])
      .then(([appeals, affecting]) => {
        if (controller.signal.aborted) return
        setItems([...appeals.items])
        setNextCursor(appeals.nextCursor)
        setMoreError(false)
        const active = affecting.items.filter((item) => item.state === 'active')
        setActions(active)
        setKnownActions(affecting.items)
        setActionId((current) => current || active[0]?.id || '')
      })
      .catch((err) => {
        if (controller.signal.aborted) return
        if (isProductApiError(err) && err.status === 404) {
          setItems([])
          setActions([])
          return
        }
        setLoadError(isProductApiError(err) ? err.recoveryHint : "Couldn't load appeals")
      })
    return () => controller.abort()
  }, [enabled, isLoggedIn, attempt])

  const visibleItems = (items ?? []).filter((item) => status === 'all' || item.status === status)

  async function submit() {
    if (!actionId) return
    setBusy(true)
    setSubmitError(null)
    try {
      const created = await productClient.createModerationAppeal(
        { actionId, description },
        { intentId: productClient.mutationIntentKey('moderation-appeal', productClient.newCommandId()), maxRetries: 0 },
      )
      setItems((current) => [created, ...(current ?? [])])
      setDescription('')
      success('Appeal submitted.')
    } catch (err) {
      setSubmitError(isProductApiError(err) ? err.recoveryHint : 'Appeal could not be submitted')
    } finally {
      setBusy(false)
    }
  }

  async function loadMore() {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    setMoreError(false)
    try {
      const page = await productClient.listMyModerationAppeals({ limit: PAGE_LIMIT, cursor: nextCursor }, { maxRetries: 0 })
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
        documentTitle="My appeals"
        eyebrow="Moderation"
        title="My appeals"
        lede="Appeal an official action on content you own. Decisions do not leak evidence or reporters."
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
          <RouteState kind="auth" returnTo="/moderation/appeals" />
        ) : loadError ? (
          <RouteState
            kind="error"
            title="Couldn't load appeals"
            description={loadError}
            onRetry={() => setAttempt((current) => current + 1)}
          />
        ) : items === null ? (
          <RouteState kind="loading" loadingLabel="Loading appeals" />
        ) : (
          <div className="stack">
            <form
              className="stack"
              data-testid="moderation-appeal-form"
              onSubmit={(event) => {
                event.preventDefault()
                void submit()
              }}
            >
              <div className="field">
                <label htmlFor="moderation-appeal-action">Official action</label>
                <select
                  id="moderation-appeal-action"
                  className="input"
                  value={actionId}
                  onChange={(event) => setActionId(event.target.value)}
                  required
                  data-testid="moderation-appeal-action"
                >
                  {actions.length === 0 ? (
                    <option value="">No active official actions</option>
                  ) : actions.map((item) => (
                    <option key={item.id} value={item.id}>
                      {humanLabel(MODERATION_ACTION_LABEL, item.action)} · {formatGovernanceTarget(item.target)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="moderation-appeal-description">Description</label>
                <textarea
                  id="moderation-appeal-description"
                  className="input"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  required
                />
              </div>
              {submitError ? <p className="field-error" role="alert">{submitError}</p> : null}
              <button type="submit" className="btn btn-primary" disabled={busy || actions.length === 0}>Submit appeal</button>
            </form>
            {items.length > 0 ? (
              <ModerationStatusFilter value={status} options={STATUS_FILTERS} onChange={setStatus} />
            ) : null}
            {items.length === 0 ? (
              <EmptyState
                icon="collection"
                title="No appeals yet"
                description="Appeals you submit against official actions appear here, with their status."
              />
            ) : visibleItems.length === 0 ? (
              <EmptyState
                icon="collection"
                title="No appeals with this status"
                description="Appeals you submit against official actions appear here, with their status."
              />
            ) : (
              <ModerationTable label="My appeals" testId="moderation-appeal-list" subjectLabel="Appeal">
                {visibleItems.map((item) => {
                  const action = knownActions.find((candidate) => candidate.id === item.actionId)
                  return (
                    <ModerationRow
                      key={item.id}
                      title={action ? humanLabel(MODERATION_ACTION_LABEL, action.action) : 'Appeal'}
                      meta={`${action ? `${governanceTargetKind(action.target)} ${governanceTargetMeta(action.target)} · ` : ''}Submitted ${formatDate(item.createdAt)}`}
                      detail={item.description}
                      status={(
                        <StatusBadge tone={MODERATION_APPEAL_STATUS_TONE[item.status] ?? 'neutral'}>
                          {humanLabel(MODERATION_APPEAL_STATUS_LABEL, item.status)}
                        </StatusBadge>
                      )}
                      note={item.resolution}
                    />
                  )
                })}
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
