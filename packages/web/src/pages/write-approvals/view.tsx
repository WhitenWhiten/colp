import { useCallback, useState } from 'react'
import { Link } from 'react-router-dom'
import { productClient } from '../../api'
import { Breadcrumb } from '../../components/Breadcrumb'
import { EmptyState, LoadingState } from '../../components/EmptyState'
import { FilterRail } from '../../components/FilterRail'
import { PageHead } from '../../components/PageHead'
import { PageShell } from '../../components/PageShell'
import { RouteState } from '../../components/RouteState'
import { ApprovalCard } from './approvalCard'
import { useAutomationPlanActions, useAutomationPlans } from './automation'
import type { WriteApprovalsData } from './data'
import { idleDraft } from './types'

type Source = 'all' | 'automation' | 'agents'

export function WriteApprovalsView({ data }: { data: WriteApprovalsData }) {
  const {
    approvals,
    detailMode,
    invalidPlanId,
    missingDetail,
    authPending,
    loading,
    refreshing,
    loadError,
    loadErrorKind,
    drafts,
    collectionTitles,
    load,
    handleDecision,
    retryRefresh,
    startNewDecision,
    handleUndo,
  } = data
  const plans = useAutomationPlans(approvals)
  const refresh = useCallback(() => { void load('refresh') }, [load])
  const automation = useAutomationPlanActions(refresh)
  const [source, setSource] = useState<Source>('all')
  const automationCount = approvals.filter((approval) => plans.has(approval.planId)).length
  const showSources = !detailMode && automationCount > 0
  const shown = !showSources || source === 'all'
    ? approvals
    : approvals.filter((approval) => plans.has(approval.planId) === (source === 'automation'))

  return (
    <PageShell>
        <PageHead
          as="header"
          layout="split"
          variant="workbench"
          breadcrumb={detailMode
            ? <Breadcrumb items={[{ label: 'Approvals', to: '/approvals' }, { label: 'Plan' }]} />
            : undefined}
          title={detailMode ? 'Approval' : 'Approvals'}
          documentTitle={detailMode ? 'Approval' : 'Approvals'}
          lede="Changes your agents proposed wait here for you. Trusted agents’ moves arrive applied, with Undo."
          actions={!invalidPlanId && !authPending && loadErrorKind !== 'unavailable' ? (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={loading || refreshing}
              onClick={() => void load('refresh')}
            >
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </button>
          ) : undefined}
        />

        {/* The first load shows the shared loading state, which announces
            itself; a refresh keeps the list and says so here and on the
            Refresh button. */}
        <div className="visually-hidden" aria-live="polite">
          {!authPending && !loading && refreshing ? 'Refreshing write approvals…' : ''}
        </div>
        {(authPending || loading) && !loadError && !invalidPlanId && !missingDetail && (
          <LoadingState label={authPending ? 'Checking your session…' : 'Loading approvals…'} />
        )}

        {invalidPlanId && (
          <EmptyState
            className="write-approvals-error empty-state--compact"
            role="alert"
            icon="alert"
            title="Invalid approval link"
            description="This approval link is malformed. Open the approvals list to find a valid plan."
            action={<Link to="/approvals" className="btn btn-secondary btn-sm">View approvals</Link>}
          />
        )}

        {missingDetail && (
          <EmptyState
            className="write-approvals-error empty-state--compact"
            role="status"
            icon="collection"
            title="Approval not found"
            description="This plan may have expired, been removed, or belong to another account."
            action={<Link to="/approvals" className="btn btn-secondary btn-sm">View approvals</Link>}
          />
        )}

        {!invalidPlanId && !missingDetail && loadError && loadErrorKind === 'unavailable' && (
          <RouteState
            className="write-approvals-error empty-state--compact"
            kind="unavailable"
            icon="bell"
            title="Write approvals are not available yet"
            feature="MCP write approvals"
          />
        )}

        {!invalidPlanId && !missingDetail && loadError && loadErrorKind === 'auth' && (
          <RouteState
            className="write-approvals-error empty-state--compact"
            kind="auth"
            icon="bell"
            title="Sign in to review write approvals"
            description="You need to be signed in to review write approvals."
          />
        )}

        {!invalidPlanId && !missingDetail && loadError && loadErrorKind !== 'unavailable' && loadErrorKind !== 'auth' && (
          <EmptyState
            className="write-approvals-error empty-state--compact"
            role="alert"
            icon="alert"
            title="Couldn't load write approvals"
            description={loadError}
            action={
              loadErrorKind === 'csrf' ? (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => {
                    void (async () => {
                      try {
                        await productClient.getSession({ maxRetries: 0 })
                      } finally {
                        await load('refresh')
                      }
                    })()
                  }}
                >
                  Refresh session
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => void load('refresh')}
                >
                  Try again
                </button>
              )
            }
          />
        )}

        {!detailMode && !authPending && !loading && !loadError && approvals.length === 0 && (
          <EmptyState
            icon="check"
            title="Nothing waiting for you"
            description="When an agent proposes a change to your library, it waits here for you."
            action={<Link to="/agents" className="btn btn-secondary btn-sm">Connect an agent</Link>}
          />
        )}

        {!authPending && !loading && !loadError && !invalidPlanId && !missingDetail && approvals.length > 0 && (
          <div className="write-approvals-list">
            {showSources && (
              <FilterRail<Source>
                variant="segments"
                className="view-switch write-approvals-sources"
                label="Show approvals from"
                value={source}
                options={[
                  { value: 'all', label: 'All' },
                  { value: 'automation', label: `Automations · ${automationCount}` },
                  { value: 'agents', label: `Agents · ${approvals.length - automationCount}` },
                ]}
                onChange={setSource}
              />
            )}
            {shown.map((approval) => {
              const plan = plans.get(approval.planId)
              return (
              <ApprovalCard
                key={approval.planId}
                approval={approval}
                draft={drafts[approval.planId] ?? idleDraft}
                collectionTitles={collectionTitles}
                automation={plan ? {
                  plan,
                  state: automation.stateOf(approval.planId),
                  onDecide: (decision) => automation.decide(approval, plan, decision),
                  onUndo: () => automation.undo(approval, plan),
                  onProposeAgain: () => automation.proposeAgain(approval, plan),
                } : undefined}
                onDecision={(decision, replay) => void handleDecision(approval, decision, replay)}
                onRefresh={() => void retryRefresh(approval)}
                onStartNew={() => startNewDecision(approval.planId)}
                onUndo={(force) => handleUndo(approval, force)}
              />
              )
            })}
          </div>
        )}
    </PageShell>
  )
}
