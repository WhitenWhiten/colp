import { graphRelationWorkspacePath } from '../../lib/graphNavigation'
import { useState } from 'react'
import { GraphNodeList } from './nodeList'
import { Link } from 'react-router-dom'
import { relationLabel } from './relations'
import type { GraphState } from './useGraphState'
import { UGC_REL } from '../../lib/ugcRel'

export function GraphSidebar({ state, slug }: { state: GraphState; slug: string }) {
  const { active, activeKind, selectedEdges, resourceMap, setActiveId } = state

  const [relationLimit, setRelationLimit] = useState(50)

  return (
    <aside className="graph-side">
      {active ? (
        <>
          <p className="section-label">{activeKind}</p>
          <h3 title={active.node.title}>{active.node.title}</h3>
          {/* R9-31: omit the summary when the node carries none — the bare
              '-' read as content rather than absence. */}
          {active.node.description && (
            <p className="graph-side-summary">{active.node.description}</p>
          )}
          <div className="graph-side-meta">
            <span>{active.host}</span>
          </div>

          <div className="graph-side-actions">
            {state.canEdit && state.collection && (
              <Link className="btn btn-secondary btn-sm" to={graphRelationWorkspacePath(state.collection.id, slug, active.node.id)}>Manage relations</Link>
            )}
            {active.href && (
              <a
                className="btn btn-primary btn-sm"
                href={active.href}
                target="_blank"
                rel={UGC_REL}
              >
                Open bookmark
              </a>
            )}
            <Link to={`/c/${slug}`} className="btn btn-secondary btn-sm">
              View on board
            </Link>
          </div>

          <hr className="divider" />
          <p className="meta">
            Relations ({selectedEdges.length})
          </p>
          {selectedEdges.length === 0 ? (
            <p className="graph-side-summary">No visible relations for this node.</p>
          ) : (
            <ul className="graph-neighbor-list">
              {selectedEdges.slice(0, relationLimit).map((edge) => {
                const outgoing = edge.fromNodeId === active.node.id
                const neighbor = resourceMap.get(outgoing ? edge.toNodeId : edge.fromNodeId)!
                return (
                <li key={edge.id}>
                  <button type="button" onClick={() => setActiveId(neighbor.node.id)}>
                    <span className="graph-neighbor-type">
                      {edge.type === 'related' ? 'Related' : outgoing ? 'Outgoing' : 'Incoming'} · {relationLabel(edge.type)}
                    </span>
                    <span>{neighbor.node.title}</span>
                    {edge.label && <span>{edge.label}</span>}
                  </button>
                </li>
              )})}
            </ul>
          )}
          {selectedEdges.length > relationLimit && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setRelationLimit((value) => value + 50)}>Show more relations</button>}
        </>
      ) : (
        <p className="graph-side-summary">Select a node to inspect relations.</p>
      )}
      <GraphNodeList key={`${state.query}:${state.typeFilter}:${state.relationType}:${state.neighborhoodId}`} resources={state.matching} selectedId={state.selectedId} select={setActiveId} />
    </aside>
  )
}
