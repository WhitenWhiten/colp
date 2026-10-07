import { HEIGHT, WIDTH } from './layout'
import type { PublicCollectionRelation } from '../../api/types'

export type GraphEdge = PublicCollectionRelation
export const relationLabel = (type: string) => type.replaceAll('_', ' ')
export const isDirected = (edge: GraphEdge) => edge.type !== 'related'

/** Keep parallel and opposite relations; only deduplicate the same relation ID. */
export function graphEdges(relations: readonly GraphEdge[], nodeIds: ReadonlySet<string>): GraphEdge[] {
  const seen = new Set<string>()
  return relations.filter((edge) => {
    if (seen.has(edge.id) || edge.fromNodeId === edge.toNodeId
      || !nodeIds.has(edge.fromNodeId) || !nodeIds.has(edge.toNodeId)) return false
    seen.add(edge.id)
    return true
  })
}

export function neighborsOf(id: string | null, edges: readonly GraphEdge[]): Set<string> {
  const ids = new Set<string>()
  if (!id) return ids
  ids.add(id)
  for (const edge of edges) {
    if (edge.fromNodeId === id) ids.add(edge.toNodeId)
    if (edge.toNodeId === id) ids.add(edge.fromNodeId)
  }
  return ids
}

/** Group once, then generate all geometry in linear time. Hover only changes styling. */
export function graphEdgePaths(edges: readonly GraphEdge[], positions: Record<string, { x: number; y: number }>): Map<string, string> {
  const groups = new Map<string, GraphEdge[]>()
  for (const edge of edges) {
    const key = JSON.stringify([edge.fromNodeId, edge.toNodeId].sort())
    const group = groups.get(key)
    if (group) group.push(edge)
    else groups.set(key, [edge])
  }
  const paths = new Map<string, string>()
  for (const group of groups.values()) {
    group.forEach((edge, index) => paths.set(edge.id, edgePath(edge, index, group.length, positions)))
  }
  return paths
}

/** Keep arrows outside node circles and parallel curves within the fitted viewport. */
function edgePath(edge: GraphEdge, index: number, count: number, positions: Record<string, { x: number; y: number }>) {
  const from = positions[edge.fromNodeId]
  const to = positions[edge.toNodeId]
  if (!from || !to) return ''
  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = Math.hypot(dx, dy) || 1
  const midX = (from.x + to.x) / 2
  const midY = (from.y + to.y) / 2
  // Scale the entire bundle to the available clearance. Clamping each curve
  // independently would collapse parallel edges at the viewport boundary.
  const clearance = Math.max(0, Math.min(72,
    dy === 0 ? Infinity : Math.min(midX - 16, WIDTH - 16 - midX) * length / Math.abs(dy),
    dx === 0 ? Infinity : Math.min(midY - 16, HEIGHT - 16 - midY) * length / Math.abs(dx),
  ))
  const spacing = Math.min(24, 2 * clearance / Math.max(1, count - 1))
  const bend = (index - (count - 1) / 2) * spacing * (edge.fromNodeId < edge.toNodeId ? 1 : -1)
  const cx = midX - dy / length * bend
  const cy = midY + dx / length * bend
  const startLength = Math.hypot(cx - from.x, cy - from.y) || 1
  const endLength = Math.hypot(to.x - cx, to.y - cy) || 1
  return `M ${from.x + (cx - from.x) / startLength * 13} ${from.y + (cy - from.y) / startLength * 13} Q ${cx} ${cy} ${to.x - (to.x - cx) / endLength * 15} ${to.y - (to.y - cy) / endLength * 15}`
}
