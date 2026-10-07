import type { PublicCollectionResource } from '../../lib/publicCollectionTree'

export type NodePos = { id: string; x: number; y: number }

export const WIDTH = 720
export const HEIGHT = 520
export const MIN_ZOOM = 0.65
export const MAX_ZOOM = 2.4

/** Above this count, a single ring collides labels — use concentric rings. */
export const GRAPH_DENSE_COUNT = 18

/** Stable radial layout so the graph is readable without a physics engine. */
export function layoutNodes(resources: PublicCollectionResource[], width: number, height: number): NodePos[] {
  const cx = width / 2
  const cy = height / 2
  const n = resources.length
  if (n === 0) return []
  const first = resources[0]
  if (n === 1 && first) return [{ id: first.node.id, x: cx, y: cy }]

  const span = Math.min(width, height)
  if (n < GRAPH_DENSE_COUNT) {
    const ring = span * 0.34
    return resources.map((resource, i) => {
      const angle = (Math.PI * 2 * i) / n - Math.PI / 2
      const radius = ring * (0.88 + (i % 3) * 0.08)
      return {
        id: resource.node.id,
        x: cx + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius,
      }
    })
  }

  const ringCount = n >= 36 ? 3 : 2
  const weights = ringCount === 2 ? [0.38, 0.62] : [0.22, 0.33, 0.45]
  const counts: number[] = []
  let assigned = 0
  for (let r = 0; r < ringCount; r += 1) {
    const weight = weights[r] ?? 0
    const next = r === ringCount - 1 ? n - assigned : Math.max(1, Math.round(n * weight))
    counts.push(next)
    assigned += next
  }

  const inner = span * 0.16
  const outer = span * 0.40
  const out: NodePos[] = []
  let index = 0
  for (let r = 0; r < ringCount; r += 1) {
    const count = counts[r] ?? 0
    const radius = inner + ((outer - inner) * r) / Math.max(1, ringCount - 1)
    const offset = r * (Math.PI / Math.max(count, 1))
    for (let k = 0; k < count; k += 1) {
      const resource = resources[index]
      index += 1
      if (!resource) continue
      const angle = (Math.PI * 2 * k) / count - Math.PI / 2 + offset
      out.push({
        id: resource.node.id,
        x: cx + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius,
      })
    }
  }
  return out
}

export function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n))
}

/** Map a viewBox point through the same zoom-about-center + pan transform
    the SVG world group uses. Old tooltip math multiplied (x + pan) by zoom,
    so a centered node raced toward the canvas edge as soon as you zoomed. */
export function projectGraphPoint(
  point: { x: number; y: number },
  pan: { x: number; y: number },
  zoom: number,
  viewBox: { width: number; height: number } = { width: WIDTH, height: HEIGHT },
): { x: number; y: number } {
  const cx = viewBox.width / 2
  const cy = viewBox.height / 2
  return {
    x: (point.x - cx) * zoom + cx + pan.x,
    y: (point.y - cy) * zoom + cy + pan.y,
  }
}

const TOOLTIP_WIDTH = 220
const TOOLTIP_HEIGHT = 110
const TOOLTIP_GAP = 12

/** Canvas-local CSS offset for the hover card. Clamped so overflow:hidden
    on .graph-canvas cannot hide it; left/top stay relative to the canvas,
    not the viewport (.ctx-menu's position:fixed used to steal them). */
export function graphTooltipOffset(
  point: { x: number; y: number },
  pan: { x: number; y: number },
  zoom: number,
  canvas: { width: number; height: number },
): { left: number; top: number } {
  const projected = projectGraphPoint(point, pan, zoom)
  const scale = Math.max(0, Math.min(canvas.width / WIDTH, canvas.height / HEIGHT))
  const px = (canvas.width - WIDTH * scale) / 2 + projected.x * scale
  const py = (canvas.height - HEIGHT * scale) / 2 + projected.y * scale
  return {
    left: clamp(px + TOOLTIP_GAP, TOOLTIP_GAP, Math.max(TOOLTIP_GAP, canvas.width - TOOLTIP_WIDTH)),
    top: clamp(py + TOOLTIP_GAP, TOOLTIP_GAP, Math.max(TOOLTIP_GAP, canvas.height - TOOLTIP_HEIGHT)),
  }
}

/** Word-wrap a graph label so the selected node never paints a truncated mid-word. */
export function wrapGraphLabel(title: string, maxChars = 18, maxLines = 2): string[] {
  const text = title.trim()
  if (!text) return []
  const lines: string[] = []
  let remaining = text
  while (remaining) {
    const last = lines.length === maxLines - 1
    if (remaining.length <= maxChars) {
      lines.push(remaining)
      break
    }
    if (last) {
      lines.push(`${remaining.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`)
      break
    }
    let breakAt = remaining.lastIndexOf(' ', maxChars)
    if (breakAt <= 0) breakAt = maxChars
    lines.push(remaining.slice(0, breakAt).trimEnd())
    remaining = remaining.slice(breakAt).trimStart()
  }
  return lines
}

export function nodeInitial(title: string): string {
  const letter = title.trim().charAt(0)
  return letter ? letter.toUpperCase() : '·'
}


/** Place connected components together, with stable traversal inside each component. */
export function layoutConnectedNodes(
  resources: PublicCollectionResource[],
  edges: ReadonlyArray<{ fromNodeId: string; toNodeId: string }>,
  width: number,
  height: number,
): NodePos[] {
  const byId = new Map(resources.map((resource) => [resource.node.id, resource]))
  const adjacency = new Map(resources.map((resource) => [resource.node.id, new Set<string>()]))
  for (const edge of edges) {
    adjacency.get(edge.fromNodeId)?.add(edge.toNodeId)
    adjacency.get(edge.toNodeId)?.add(edge.fromNodeId)
  }
  const visited = new Set<string>()
  const groups: PublicCollectionResource[][] = []
  for (const resource of resources) {
    if (visited.has(resource.node.id)) continue
    const group: PublicCollectionResource[] = []
    const queue = [resource.node.id]
    visited.add(resource.node.id)
    for (let i = 0; i < queue.length; i += 1) {
      const id = queue[i]!
      const item = byId.get(id)
      if (item) group.push(item)
      for (const neighbor of adjacency.get(id) ?? []) {
        if (!visited.has(neighbor) && byId.has(neighbor)) { visited.add(neighbor); queue.push(neighbor) }
      }
    }
    groups.push(group)
  }
  // A single component or all isolated nodes use the full canvas.
  if (groups.length <= 1 || groups.every((group) => group.length === 1)) return layoutNodes(groups.flat(), width, height)
  const connected = groups.filter((group) => group.length > 1)
  const isolated = groups.filter((group) => group.length === 1).flat()
  if (isolated.length) connected.push(isolated)
  const cols = Math.ceil(Math.sqrt(connected.length * width / height))
  const rows = Math.ceil(connected.length / cols)
  return connected.flatMap((group, index) => layoutNodes(group, width / cols, height / rows).map((point) => ({
    ...point, x: point.x + index % cols * width / cols, y: point.y + Math.floor(index / cols) * height / rows,
  })))
}
