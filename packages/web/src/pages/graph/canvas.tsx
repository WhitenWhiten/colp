import { Link } from 'react-router-dom'
import { useId, useMemo } from 'react'
import { graphEdgePaths, isDirected, relationLabel } from './relations'
import { EmptyState } from '../../components/EmptyState'
import { Icon } from '../../components/Icon'
import { graphResourceKind } from './resources'
import { clamp, HEIGHT, MAX_ZOOM, MIN_ZOOM, nodeInitial, WIDTH, wrapGraphLabel } from './layout'
import type { GraphState } from './useGraphState'

export function GraphCanvas({ state }: { state: GraphState }) {
  const arrowId = useId()
  const tooltipId = useId()
  const {
    canvasRef,
    zoom,
    setZoom,
    pan,
    resetView,
    visible,
    clearFilters,
    resourceMap,
    positions,
    resources,
    edges,
    posMap,
    dense,
    focusId,
    neighborIds,
    active,
    connectedEdge,
    setActiveId,
    setHoverId,
    hoverResource,
    tooltipStyle,
  } = state
  const paths = useMemo(() => graphEdgePaths(edges, posMap), [edges, posMap])

  return (
    <div className="graph-canvas" ref={canvasRef} data-testid="graph-canvas">
      <div className="graph-zoom-controls" role="group" aria-label="Zoom">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          aria-label="Zoom out"
          onClick={() => setZoom((z) => clamp(Number((z - 0.15).toFixed(2)), MIN_ZOOM, MAX_ZOOM))}
        >
          <Icon name="minus" />
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          // R15-41: the name starts with the visible percentage (2.5.3).
          aria-label={`${Math.round(zoom * 100)}%, fit graph to view`}
          onClick={resetView}
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          aria-label="Zoom in"
          onClick={() => setZoom((z) => clamp(Number((z + 0.15).toFixed(2)), MIN_ZOOM, MAX_ZOOM))}
        >
          <Icon name="plus" />
        </button>
      </div>

      {visible.length === 0 ? (
        <EmptyState
          className="graph-empty"
          icon="search"
          title={resources.length ? "No nodes match" : "No bookmarks yet"}
          description={resources.length ? "Try another type or clear the search." : "Add bookmarks to this collection to start a graph."}
          action={resources.length === 0
            ? state.canEdit && state.collection && <Link className="btn btn-secondary btn-sm" to={`/library/${encodeURIComponent(state.collection.id)}`}>Add bookmarks</Link>
            : <button type="button" className="btn btn-secondary btn-sm" onClick={clearFilters}>
              Clear filters
            </button>
          }
        />
      ) : (
        <>
          <svg
            className="graph-svg"
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            role="group"
            aria-label="Knowledge graph of collection bookmarks"
            data-active={focusId || undefined}
            data-dense={dense ? '' : undefined}
          >
            <defs>
              <marker
                id={arrowId}
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="5"
                markerHeight="5"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" opacity="0.35" />
              </marker>
            </defs>

            <g
              transform={`translate(${WIDTH / 2 + pan.x} ${HEIGHT / 2 + pan.y}) scale(${zoom}) translate(${-WIDTH / 2} ${-HEIGHT / 2})`}
            >
              {edges.map((edge) => (
                <path
                  key={edge.id}
                  className="graph-edge"
                  data-from={edge.fromNodeId}
                  data-to={edge.toNodeId}
                  data-relation-id={edge.id}
                  data-connected={connectedEdge(edge.fromNodeId, edge.toNodeId) ? '' : undefined}
                  d={paths.get(edge.id)}
                  markerEnd={isDirected(edge) ? `url(#${arrowId})` : undefined}
                >
                  <title>{relationLabel(edge.type)}{edge.label ? `: ${edge.label}` : ''}</title>
                </path>
              ))}

              {positions.map((p) => {
                const resource = resourceMap.get(p.id)
                if (!resource) return null
                const kind = graphResourceKind(resource)
                const isFocus = focusId === p.id
                const isNeighbor = neighborIds.has(p.id)
                const isActive = active?.node.id === p.id

                return (
                  <g
                    key={p.id}
                    className={[
                      'graph-node',
                      isActive ? 'is-active' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    data-node-id={p.id}
                    data-active-node={isNeighbor ? '' : undefined}
                    transform={`translate(${p.x} ${p.y})`}
                    onClick={() => setActiveId(p.id)}
                    onMouseEnter={() => setHoverId(p.id)}
                    onMouseLeave={() => setHoverId(null)}
                    onFocus={() => setHoverId(p.id)}
                    onBlur={() => setHoverId(null)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') setHoverId(null)
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        setActiveId(p.id)
                      }
                    }}
                    role="button"
                    aria-pressed={isActive}
                    aria-describedby={hoverResource?.node.id === p.id && tooltipStyle ? tooltipId : undefined}
                    tabIndex={0}
                    aria-label={`${kind}: ${resource.node.title}`}
                  >
                    <circle className="graph-hit" r={28} />
                    <circle className="graph-dot" r={isFocus || isActive ? 11 : 9} />
                    <text className="graph-mono" textAnchor="middle" dy="0.35em" data-testid="graph-node-initial">
                      {nodeInitial(resource.node.title)}
                    </text>
                    {(dense ? isFocus : neighborIds.has(p.id)) ? (
                      <text className="graph-label" y={26} textAnchor="middle" data-testid="graph-node-label">
                        {wrapGraphLabel(resource.node.title).map((line, index) => (
                          <tspan key={`${p.id}-${index}`} x={0} dy={index === 0 ? 0 : 13}>
                            {line}
                          </tspan>
                        ))}
                      </text>
                    ) : null}
                  </g>
                )
              })}
            </g>
          </svg>

          {hoverResource && tooltipStyle && (
            <div
              className="graph-tooltip"
              data-testid="graph-tooltip"
              style={{ left: tooltipStyle.left, top: tooltipStyle.top }}
              id={tooltipId}
              role="tooltip"
            >
              <span className="ctx-menu-label">{graphResourceKind(hoverResource)}</span>
              <strong>{hoverResource.node.title}</strong>
              {hoverResource.host && <span className="meta">{hoverResource.host}</span>}
            </div>
          )}
        </>
      )}
    </div>
  )
}
