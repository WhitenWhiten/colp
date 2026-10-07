import { contentBounds, MAX_CANVAS, type CanvasSize, type LayoutMap } from './geometry'

export function applyBoardMetrics(
  board: HTMLDivElement | null,
  map: LayoutMap,
  customCanvasSize: boolean,
  size: CanvasSize,
): void {
  if (!board) return

  if (customCanvasSize) {
    const { bottom, right } = contentBounds(map)
    // Canvas size is a floor — grow if cards need more room
    const w = Math.max(size.width, Math.min(right, MAX_CANVAS.width))
    const h = Math.max(size.height, Math.min(bottom, MAX_CANVAS.height))
    board.style.width = `${w}px`
    board.style.maxWidth = 'none'
    board.style.height = `${h}px`
    board.style.setProperty('--canvas-height', `${h}px`)
    board.dataset.canvasW = String(size.width)
    board.dataset.canvasH = String(size.height)
    return
  }

  const values = Object.values(map)
  const bottom = values.length
    ? Math.max(...values.map((l) => l.y + l.h))
    : 640
  board.style.removeProperty('width')
  board.style.removeProperty('max-width')
  const contentH = Math.max(640, bottom + 72)
  board.style.setProperty('--canvas-height', `max(${contentH}px, var(--canvas-min-height))`)
}
