import { useParams } from 'react-router-dom'
import { ABSENCE_CORNERS, AbsenceStage } from '../components/AbsenceStage'
import { RouteLoading } from '../components/RouteLoading'
import { PageShell } from '../components/PageShell'
import { RouteState } from '../components/RouteState'
import { useGraphState } from './graph/useGraphState'
import { GraphView } from './graph/view'
// Route-owned stylesheet (see main.tsx); ships with this chunk.
import '../styles/graph.css'
import '../styles/not-found.css'

export {
  GRAPH_DENSE_COUNT,
  graphTooltipOffset,
  layoutNodes,
  projectGraphPoint,
  wrapGraphLabel,
} from './graph/layout'

export function Graph() {
  const { slug = '' } = useParams()
  return <GraphCollection key={slug} slug={slug} />
}

function GraphCollection({ slug }: { slug: string }) {
  const state = useGraphState(slug)
  const { load, retry, collection, published } = state

  if (load.status === 'loading') {
    return <RouteLoading label={load.restartCount > 0 ? 'Refreshing the collection snapshot…' : 'Loading collection…'} />
  }

  if (load.status === 'unavailable') {
    return (
      <AbsenceStage
        title="Collection unavailable"
        description="This collection was not found, has been withdrawn, or is not available to this account."
        corners={ABSENCE_CORNERS.collection}
        exits={[{ to: '/', label: 'Back home' }]}
      />
    )
  }

  if (load.status === 'error') {
    return (
      <PageShell variant="bare">
        <RouteState kind="error" titleAs="h1" title="Couldn't load this collection" description={load.message} onRetry={retry} />
      </PageShell>
    )
  }

  if (!collection || !published) {
    return (
      <AbsenceStage
        title="Collection unavailable"
        description="This collection is still being published. Try again in a moment."
        corners={ABSENCE_CORNERS.collection}
        exits={[{ label: 'Try again', onClick: retry }, { to: '/', label: 'Back home' }]}
      />
    )
  }

  return <GraphView collection={collection} slug={slug} state={state} />
}
