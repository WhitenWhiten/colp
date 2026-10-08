import type { CardLayout, Resource } from '../../types/catalog'

export type LayoutMap = Record<string, CardLayout>

export type CanvasSize = { width: number; height: number }

export type CardMinSize = { width: number; height: number }

/** Board grid unit (px). All card x/y/w/h and canvas sizes snap to this. */
export const BOARD_GRID = 20

export const SIZE_PRESETS: { id: string; label: string; size: CanvasSize }[] = [
  { id: 'compact', label: 'Compact', size: { width: 960, height: 720 } },
  { id: 'default', label: 'Default', size: { width: 1280, height: 900 } },
  { id: 'wide', label: 'Wide', size: { width: 1440, height: 960 } },
  { id: 'ultrawide', label: 'Ultra', size: { width: 1680, height: 1000 } },
  { id: 'tall', label: 'Tall', size: { width: 1280, height: 1400 } },
]

export const DEFAULT_CANVAS: CanvasSize = { width: 1280, height: 900 }
export const MIN_CANVAS = { width: 640, height: 480 }
export const MAX_CANVAS = { width: 3200, height: 4000 }

export function snapToGrid(n: number, grid: number = BOARD_GRID): number {
  if (!Number.isFinite(n)) return 0
  return Math.round(n / grid) * grid
}

/** Snap a size up to at least `min`, always on the grid. */
export function snapSize(n: number, min: number, grid: number = BOARD_GRID): number {
  const minSnapped = Math.ceil(Math.max(min, grid) / grid) * grid
  return Math.max(minSnapped, snapToGrid(n, grid))
}

export function floorToGrid(n: number, grid: number = BOARD_GRID): number {
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.floor(n / grid) * grid
}

export function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n))
}

/**
 * Strict grid rect for the **content** box (not edit chrome).
 * When `chromeH` is set, y is clamped so the chrome above the content stays on-board.
 */
export function snapRect(
  rect: Pick<CardLayout, 'x' | 'y' | 'w' | 'h'> & Partial<CardLayout>,
  opts?: {
    min?: CardMinSize
    limits?: { width: number; height: number }
    /** Edit chrome height sitting above the content box. */
    chromeH?: number
  },
): CardLayout {
  const minW = opts?.min?.width ?? BOARD_GRID * 5
  const minH = opts?.min?.height ?? BOARD_GRID * 5
  const chromeH = Math.max(0, opts?.chromeH ?? 0)
  let w = snapSize(rect.w, minW)
  let h = snapSize(rect.h, minH)
  let x = Math.max(0, snapToGrid(rect.x))
  // Content top sits below chrome; keep chrome on the board when present.
  const minY = chromeH > 0 ? snapToGrid(chromeH) : 0
  let y = Math.max(minY, snapToGrid(rect.y))

  if (opts?.limits) {
    const maxW = Math.max(snapSize(minW, minW), floorToGrid(opts.limits.width - x))
    // Content bottom is the shell bottom (chrome only expands upward).
    const maxH = Math.max(snapSize(minH, minH), floorToGrid(opts.limits.height - y))
    w = clamp(w, snapSize(minW, minW), maxW)
    h = clamp(h, snapSize(minH, minH), maxH)
    const maxX = floorToGrid(Math.max(0, opts.limits.width - w))
    const maxY = floorToGrid(Math.max(0, opts.limits.height - h))
    x = clamp(x, 0, maxX)
    y = clamp(y, minY, Math.max(minY, maxY))
  }

  return {
    x,
    y,
    w,
    h,
    z: rect.z ?? 1,
    locked: rect.locked,
  }
}

export function minSizeForResource(resource: Resource | undefined): CardMinSize {
  // Content-box mins (edit chrome is outside this rect), on the board grid.
  if (resource?.type === 'search') return { width: 220, height: 80 }
  return { width: 220, height: 160 }
}

export function snapLayoutMap(
  map: LayoutMap,
  resources: Resource[],
  limits?: { width: number; height: number },
  chromeH: number = 0,
): LayoutMap {
  const byId = new Map(resources.map((r) => [r.id, r]))
  const next: LayoutMap = {}
  for (const [id, layout] of Object.entries(map)) {
    next[id] = snapRect(layout, {
      min: minSizeForResource(byId.get(id)),
      limits,
      chromeH,
    })
  }
  return next
}

export function layoutsFromResources(resources: Resource[]): LayoutMap {
  return Object.fromEntries(
    resources.map((r) => [
      r.id,
      snapRect(r.layout, { min: minSizeForResource(r) }),
    ]),
  )
}

/** Unlocked cards first (by z), then locked cards on top — always. */
export function normalizeStackOrder(map: LayoutMap): LayoutMap {
  const entries = Object.entries(map)
  if (!entries.length) return map

  const unlocked = entries
    .filter(([, l]) => !l.locked)
    .sort((a, b) => a[1].z - b[1].z || a[0].localeCompare(b[0]))
  const locked = entries
    .filter(([, l]) => l.locked)
    .sort((a, b) => a[1].z - b[1].z || a[0].localeCompare(b[0]))

  let z = 1
  const next: LayoutMap = {}
  for (const [id, layout] of unlocked) {
    next[id] = { ...layout, locked: false, z: z++ }
  }
  for (const [id, layout] of locked) {
    next[id] = { ...layout, locked: true, z: z++ }
  }
  return next
}

export function maxZ(map: LayoutMap) {
  const values = Object.values(map)
  if (!values.length) return 1
  return Math.max(1, ...values.map((l) => l.z))
}

export function contentBounds(map: LayoutMap) {
  const values = Object.values(map)
  if (!values.length) {
    return { bottom: MIN_CANVAS.height, right: MIN_CANVAS.width }
  }
  return {
    bottom: Math.max(...values.map((l) => l.y + l.h)) + 48,
    right: Math.max(...values.map((l) => l.x + l.w)) + 48,
  }
}
