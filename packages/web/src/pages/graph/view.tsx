import type { PublicCollectionSnapshot } from '../../api'
import { Breadcrumb } from '../../components/Breadcrumb'
import { PageHead } from '../../components/PageHead'
import { PageShell } from '../../components/PageShell'
import { GraphCanvas } from './canvas'
import { GraphSidebar } from './sidebar'
import { GraphToolbar } from './toolbar'
import { plural } from '../../lib/plural'
import type { GraphState } from './useGraphState'

export function GraphView({
  collection,
  slug,
  state,
}: {
  collection: PublicCollectionSnapshot['collection']
  slug: string
  state: GraphState
}) {
  return (
    <PageShell variant="grid" className="graph-page" data-testid="graph-page">
      <PageHead
        eyebrow="Connections"
        title={collection.title}
        documentTitle={`${collection.title} connections`}
        breadcrumb={
          <Breadcrumb items={[{ label: collection.title, to: `/c/${slug}` }, { label: 'Knowledge graph' }]} />
        }
        lede={
          <>
            Explore how bookmarks in <strong>{collection.title}</strong> connect through curated relations. Arrows show the direction of each relation.
          </>
        }
      />

      <GraphToolbar state={state} />
      {state.resources.length > 0 && state.allEdges.length === 0 && (
        <p className="meta" role="status">No visible relations yet. Bookmarks are shown without connections.</p>
      )}

      <p className="meta" role="status">
        {state.matching.length} of {plural(state.resources.length, 'bookmark')} · {plural(state.filteredEdges.length, 'relation')}
        {(state.matching.length > state.visible.length || state.filteredEdges.length > state.edges.length) && (
          <> · Canvas shows {plural(state.visible.length, 'bookmark')} and {plural(state.edges.length, 'relation')}. Search, focus a neighborhood, or browse the bookmark list to explore the rest.</>
        )}
      </p>
      <div className="graph-layout">
        <GraphCanvas state={state} />
        <GraphSidebar state={state} slug={slug} />
      </div>
    </PageShell>
  )
}
