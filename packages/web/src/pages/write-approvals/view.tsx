import { Link } from 'react-router-dom'
import { productClient } from '../../api'
import { EmptyState } from '../../components/EmptyState'
import { PageHead } from '../../components/PageHead'
import { PageShell } from '../../components/PageShell'
import { RouteState } from '../../components/RouteState'
import { ApprovalCard } from './approvalCard'
import type { WriteApprovalsData } from './data'
import { idleDraft } from './types'

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
  } = data

  return (
    <PageShell className="write-approvals-page">
        <PageHead
          as="header"
          className="write-approvals-head"
          layout="split"
          variant="workbench"
          title={detailMode ? 'Write approval' : 'Write approvals'}
          documentTitle={detailMode ? 'Write approval' : 'Write approvals'}
          lede="Review requested MCP changes before approving or denying them."
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

        <div className="write-approvals-live" aria-live="polite">
          {authPending
            ? 'Checking your session…'
            : loading
            ? 'Loading write approvals…'
            : refreshing
              ? 'Refreshing write approvals…'
              : ''}
        </div>

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
            icon="collection"
            title="No write approvals"
            description="Plans that need your decision will appear here."
          />
        )}

        {!authPending && !loading && !loadError && !invalidPlanId && !missingDetail && approvals.length > 0 && (
          <div className="write-approvals-list">
            {approvals.map((approval) => (
              <ApprovalCard
                key={approval.planId}
                approval={approval}
                draft={drafts[approval.planId] ?? idleDraft}
                collectionTitles={collectionTitles}
                onDecision={(decision, replay) => void handleDecision(approval, decision, replay)}
                onRefresh={() => void retryRefresh(approval)}
                onStartNew={() => startNewDecision(approval.planId)}
              />
            ))}
          </div>
        )}
    </PageShell>
  )
}
