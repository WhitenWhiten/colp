import { describe, expect, it } from 'vitest'
import { graphEdgePaths, type GraphEdge } from './relations'

describe('graph edge geometry', () => {
  it('keeps parallel and reverse edges distinct, finite and inside the fitted canvas', () => {
    const edges: GraphEdge[] = Array.from({ length: 18 }, (_, i) => ({
      id: String(i), type: 'custom', fromNodeId: i % 2 ? 'b' : 'a', toNodeId: i % 2 ? 'a' : 'b',
    }))
    const paths = graphEdgePaths(edges, { a: { x: 40, y: 40 }, b: { x: 680, y: 40 } })
    expect(paths.size).toBe(edges.length)
    expect(new Set(paths.values()).size).toBe(edges.length)
    for (const path of paths.values()) {
      const coordinates = path.match(/-?\d+(?:\.\d+)?/gu)!.map(Number)
      expect(coordinates).toHaveLength(6)
      coordinates.forEach((value, i) => {
        expect(Number.isFinite(value)).toBe(true)
        expect(value).toBeGreaterThanOrEqual(0)
        expect(value).toBeLessThanOrEqual(i % 2 ? 520 : 720)
      })
    }
  })
})
