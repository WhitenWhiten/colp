import { Link } from 'react-router-dom'
import { EmptyState } from '../components/EmptyState'
import { PageShell } from '../components/PageShell'
import { libraryFeatureUnavailable } from '../lib/libraryCopy'
import { useDocumentTitle } from '../lib/useDocumentTitle'
import { useWriteApprovals } from './write-approvals/data'
import { WriteApprovalsView } from './write-approvals/view'
// Route-owned stylesheet (see main.tsx); ships with this chunk.
import '../styles/write-approvals.css'

export type { DecisionDraft, DraftPhase, FrozenDecision } from './write-approvals/types'

export function WriteApprovals() {
  const data = useWriteApprovals()
  // Same names as the nav and the page head (this effect runs after the head's).
  useDocumentTitle(data.detailMode ? 'Approval' : 'Approvals')

  if (!data.enabled) {
    return (
      <PageShell data-testid="write-approvals-flag-off">
        <EmptyState
          illustration="network"
          title="Write approvals are not available yet"
          description={
            <>
              {libraryFeatureUnavailable('MCP write approvals')}{' '}
              Connecting a client uses <Link to="/agents">Agents</Link>, not this page.
            </>
          }
        />
      </PageShell>
    )
  }

  return <WriteApprovalsView data={data} />
}
