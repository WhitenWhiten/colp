import {
  deleteCanvasBackgroundImage,
  loadCanvasBackground,
  persistCanvasBackground,
  readCanvasBackgroundImage,
  writeCanvasBackgroundImage,
  type CanvasBackgroundSettings,
} from '../../lib/canvasBackground'
import {
  clamp,
  layoutsFromResources,
  MAX_CANVAS,
  MIN_CANVAS,
  minSizeForResource,
  normalizeStackOrder,
  snapRect,
  snapToGrid,
  type CanvasSize,
  type LayoutMap,
} from './geometry'
import type { Resource } from '../../types/catalog'

export function canvasSizeStorageKey(storageKey: string): string {
  return `${storageKey}:canvas-size`
}

export function canvasBackgroundStorageKey(storageKey: string): string {
  return `${storageKey}:canvas-background`
}

export function snapCanvasSize(size: CanvasSize): CanvasSize {
  return {
    width: clamp(snapToGrid(size.width), MIN_CANVAS.width, MAX_CANVAS.width),
    height: clamp(snapToGrid(size.height), MIN_CANVAS.height, MAX_CANVAS.height),
  }
}

export function loadLayouts(storageKey: string, resources: Resource[]): LayoutMap {
  const base = layoutsFromResources(resources)
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return normalizeStackOrder(base)
    const parsed = JSON.parse(raw) as Array<CardLayoutPayload>
    if (!Array.isArray(parsed) || !parsed.length) return normalizeStackOrder(base)
    for (const item of parsed) {
      if (base[item.id]) {
        const resource = resources.find((r) => r.id === item.id)
        base[item.id] = snapRect(
          {
            x: item.x,
            y: item.y,
            w: item.w,
            h: item.h,
            z: item.z,
            locked: Boolean(item.locked),
          },
          { min: minSizeForResource(resource) },
        )
      }
    }
  } catch {
    /* ignore */
  }
  return normalizeStackOrder(base)
}

type CardLayoutPayload = {
  id: string
  x: number
  y: number
  w: number
  h: number
  z: number
  locked?: boolean
}

export function persistLayouts(storageKey: string, next: LayoutMap): void {
  try {
    const payload = Object.entries(next).map(([id, l]) => ({
      id,
      x: l.x,
      y: l.y,
      w: l.w,
      h: l.h,
      z: l.z,
      locked: Boolean(l.locked),
    }))
    localStorage.setItem(storageKey, JSON.stringify(payload))
  } catch {
    /* ignore */
  }
}

export function loadCanvasSize(key: string, fallback: CanvasSize): CanvasSize {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return snapCanvasSize(fallback)
    const parsed = JSON.parse(raw) as CanvasSize
    if (
      typeof parsed?.width === 'number' &&
      typeof parsed?.height === 'number' &&
      Number.isFinite(parsed.width) &&
      Number.isFinite(parsed.height)
    ) {
      return snapCanvasSize(parsed)
    }
  } catch {
    /* ignore */
  }
  return snapCanvasSize(fallback)
}

export function persistCanvasSize(key: string, size: CanvasSize): void {
  try {
    localStorage.setItem(key, JSON.stringify(size))
  } catch {
    /* ignore */
  }
}

export function clearCanvasStorage(storageKey: string, sizeKey?: string): void {
  try {
    localStorage.removeItem(storageKey)
    if (sizeKey) localStorage.removeItem(sizeKey)
  } catch {
    /* ignore */
  }
}

export function loadBoardBackground(storageKey: string): CanvasBackgroundSettings {
  return loadCanvasBackground(canvasBackgroundStorageKey(storageKey))
}

export function persistBoardBackground(
  storageKey: string,
  settings: CanvasBackgroundSettings,
): void {
  persistCanvasBackground(canvasBackgroundStorageKey(storageKey), settings)
}

export function readBoardBackgroundImage(storageKey: string) {
  return readCanvasBackgroundImage(canvasBackgroundStorageKey(storageKey))
}

export function writeBoardBackgroundImage(storageKey: string, image: Blob) {
  return writeCanvasBackgroundImage(canvasBackgroundStorageKey(storageKey), image)
}

export function deleteBoardBackgroundImage(storageKey: string) {
  return deleteCanvasBackgroundImage(canvasBackgroundStorageKey(storageKey))
}
