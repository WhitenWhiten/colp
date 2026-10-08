import { describe, expect, it } from 'vitest'
import type { CardLayout, Resource } from '../../types/catalog'
import {
  BOARD_GRID,
  clamp,
  contentBounds,
  floorToGrid,
  layoutsFromResources,
  maxZ,
  MIN_CANVAS,
  minSizeForResource,
  normalizeStackOrder,
  snapLayoutMap,
  snapRect,
  snapSize,
  snapToGrid,
  type LayoutMap,
} from './geometry'

function layout(partial: Partial<CardLayout> = {}): CardLayout {
  return { x: 0, y: 0, w: 220, h: 160, z: 1, ...partial }
}

function resource(partial: Partial<Resource> & { id: string }): Resource {
  return {
    title: 'Card',
    url: 'https://example.com',
    summary: '',
    host: 'example.com',
    type: 'article',
    layout: layout(),
    ...partial,
  }
}

describe('snapToGrid', () => {
  it('rounds to the nearest board grid unit', () => {
    expect(snapToGrid(0)).toBe(0)
    expect(snapToGrid(20)).toBe(20)
    expect(snapToGrid(25)).toBe(20)
    expect(snapToGrid(30)).toBe(40)
    expect(snapToGrid(10)).toBe(20)
  })

  it('returns 0 for non-finite values', () => {
    expect(snapToGrid(Number.NaN)).toBe(0)
    expect(snapToGrid(Number.POSITIVE_INFINITY)).toBe(0)
    expect(snapToGrid(Number.NEGATIVE_INFINITY)).toBe(0)
  })

  it('honors a custom grid', () => {
    expect(snapToGrid(18, 16)).toBe(16)
    expect(snapToGrid(24, 16)).toBe(32)
  })
})

describe('snapSize', () => {
  it('never drops below the snapped minimum', () => {
    expect(snapSize(0, 220)).toBe(220)
    expect(snapSize(200, 220)).toBe(220)
    expect(snapSize(230, 220)).toBe(240)
  })

  it('keeps search-card mins on the grid', () => {
    expect(snapSize(80, 80)).toBe(80)
    expect(snapSize(70, 80)).toBe(80)
  })
})

describe('floorToGrid', () => {
  it('floors toward zero on the grid and rejects non-positive values', () => {
    expect(floorToGrid(40)).toBe(40)
    expect(floorToGrid(39)).toBe(20)
    expect(floorToGrid(19)).toBe(0)
    expect(floorToGrid(0)).toBe(0)
    expect(floorToGrid(-40)).toBe(0)
    expect(floorToGrid(Number.NaN)).toBe(0)
  })
})

describe('clamp', () => {
  it('pins a number to [min, max]', () => {
    expect(clamp(5, 0, 10)).toBe(5)
    expect(clamp(-1, 0, 10)).toBe(0)
    expect(clamp(11, 0, 10)).toBe(10)
  })
})

describe('snapRect', () => {
  it('snaps x/y/w/h onto the board grid', () => {
    expect(snapRect({ x: 3, y: 5, w: 230, h: 165, z: 4 })).toEqual({
      x: 0,
      y: 0,
      w: 240,
      h: 160,
      z: 4,
      locked: undefined,
    })
  })

  it('raises y so edit chrome stays on the board', () => {
    const snapped = snapRect(
      { x: 0, y: 0, w: 220, h: 160, z: 1 },
      { chromeH: 40 },
    )
    expect(snapped.y).toBe(snapToGrid(40))
    expect(snapped.y).toBe(40)
  })

  it('clamps the content box to board limits without leaving the grid', () => {
    const snapped = snapRect(
      { x: 80, y: 80, w: 400, h: 400, z: 2, locked: true },
      { limits: { width: 200, height: 200 } },
    )
    expect(snapped.x % BOARD_GRID).toBe(0)
    expect(snapped.y % BOARD_GRID).toBe(0)
    expect(snapped.w % BOARD_GRID).toBe(0)
    expect(snapped.h % BOARD_GRID).toBe(0)
    expect(snapped.x + snapped.w).toBeLessThanOrEqual(200)
    expect(snapped.y + snapped.h).toBeLessThanOrEqual(200)
    expect(snapped.locked).toBe(true)
    expect(snapped.z).toBe(2)
  })

  it('uses search mins when provided', () => {
    const snapped = snapRect(
      { x: 0, y: 0, w: 80, h: 80, z: 1 },
      { min: minSizeForResource(resource({ id: 's', type: 'search' })) },
    )
    expect(snapped.w).toBeGreaterThanOrEqual(220)
    expect(snapped.h).toBe(80)
  })
})

describe('minSizeForResource', () => {
  it('uses a shorter content box for search cards', () => {
    expect(minSizeForResource(resource({ id: 's', type: 'search' }))).toEqual({
      width: 220,
      height: 80,
    })
    expect(minSizeForResource(undefined)).toEqual({ width: 220, height: 160 })
  })
})

describe('layoutsFromResources / snapLayoutMap', () => {
  it('snaps each resource layout', () => {
    const resources = [
      resource({ id: 'a', layout: layout({ x: 3, w: 230 }) }),
      resource({ id: 'b', type: 'search', layout: layout({ h: 80 }) }),
    ]
    const map = layoutsFromResources(resources)
    expect(map.a!.x).toBe(0)
    expect(map.a!.w).toBe(240)
    expect(map.b!.h).toBe(80)
  })

  it('re-snaps an existing map against current resources and limits', () => {
    const resources = [resource({ id: 'a' })]
    const map: LayoutMap = { a: layout({ x: 11, y: 9, w: 300, h: 180, z: 3 }) }
    const next = snapLayoutMap(map, resources, { width: 1280, height: 900 })
    expect(next.a!.x).toBe(20)
    expect(next.a!.y).toBe(0)
    expect(next.a!.w % BOARD_GRID).toBe(0)
  })
})

describe('normalizeStackOrder', () => {
  it('returns the same map when empty', () => {
    const empty: LayoutMap = {}
    expect(normalizeStackOrder(empty)).toBe(empty)
  })

  it('keeps locked cards above unlocked cards', () => {
    const map: LayoutMap = {
      u2: layout({ z: 9 }),
      l1: layout({ z: 1, locked: true }),
      u1: layout({ z: 2 }),
      l2: layout({ z: 3, locked: true }),
    }
    const next = normalizeStackOrder(map)
    expect(next.u1!.z).toBeLessThan(next.l1!.z)
    expect(next.u2!.z).toBeLessThan(next.l1!.z)
    expect(next.l1!.locked).toBe(true)
    expect(next.u1!.locked).toBe(false)
    expect(Object.values(next).map((l) => l.z).sort((a, b) => a - b)).toEqual([1, 2, 3, 4])
  })
})

describe('maxZ', () => {
  it('is 1 for an empty map and otherwise the highest z', () => {
    expect(maxZ({})).toBe(1)
    expect(maxZ({ a: layout({ z: 3 }), b: layout({ z: 8 }) })).toBe(8)
  })
})

describe('contentBounds', () => {
  it('falls back to the minimum canvas when there are no cards', () => {
    expect(contentBounds({})).toEqual({
      bottom: MIN_CANVAS.height,
      right: MIN_CANVAS.width,
    })
  })

  it('adds padding beyond the farthest card edge', () => {
    expect(
      contentBounds({
        a: layout({ x: 20, y: 40, w: 220, h: 160 }),
        b: layout({ x: 400, y: 10, w: 220, h: 80 }),
      }),
    ).toEqual({ bottom: 40 + 160 + 48, right: 400 + 220 + 48 })
  })
})
