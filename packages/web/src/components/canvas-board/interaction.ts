import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as REPointerEvent } from 'react'
import type { CardLayout } from '../../types/catalog'
import { BOARD_GRID, type CanvasSize, type LayoutMap } from './geometry'

type Active = {
  type: 'move' | 'resize'
  id: string
  pointerId: number
  startClientX: number
  startClientY: number
  startScrollLeft: number
  original: CardLayout
}

type CanvasResizeActive = {
  pointerId: number
  startClientX: number
  startClientY: number
  original: CanvasSize
}

type PointerOpts = {
  layoutsRef: { current: LayoutMap }
  shellRef: { current: HTMLDivElement | null }
  commitLayout: (id: string, rect: CardLayout) => LayoutMap
  persist: (next: LayoutMap) => void
  applyBoardMetrics: (map: LayoutMap) => void
  bringForward: (id: string) => CardLayout | undefined
  markEditing: () => void
  showToast: (msg: string) => void
  setSelected: (id: string | null) => void
}

export function useCanvasPointer(opts: PointerOpts) {
  const {
    layoutsRef,
    shellRef,
    commitLayout,
    persist,
    applyBoardMetrics,
    bringForward,
    markEditing,
    showToast,
    setSelected,
  } = opts

  const [activeUi, setActiveUi] = useState<{
    id: string
    type: 'move' | 'resize'
  } | null>(null)
  const activeRef = useRef<Active | null>(null)
  const canvasResizeRef = useRef<CanvasResizeActive | null>(null)
  const cleanupRef = useRef<(() => void) | null>(null)

  const cancel = useCallback(() => {
    cleanupRef.current?.()
    cleanupRef.current = null
    activeRef.current = null
    canvasResizeRef.current = null
    setActiveUi(null)
    document.body.classList.remove('is-manipulating')
  }, [])

  useEffect(() => {
    return () => {
      cleanupRef.current?.()
      document.body.classList.remove('is-manipulating')
    }
  }, [])

  const endInteraction = useCallback(
    (cancelled: boolean) => {
      const a = activeRef.current
      if (!a) return

      cleanupRef.current?.()
      cleanupRef.current = null
      activeRef.current = null
      setActiveUi(null)
      document.body.classList.remove('is-manipulating')

      if (cancelled) {
        commitLayout(a.id, a.original)
        showToast('Change cancelled')
        return
      }

      const final = layoutsRef.current
      persist(final)
      applyBoardMetrics(final)
      showToast(a.type === 'move' ? 'Position saved' : 'Size saved')
    },
    [applyBoardMetrics, commitLayout, layoutsRef, persist, showToast],
  )

  const beginInteraction = useCallback(
    (type: 'move' | 'resize', id: string, e: REPointerEvent<HTMLElement>) => {
      e.preventDefault()
      e.stopPropagation()

      if (layoutsRef.current[id]?.locked) {
        setSelected(id)
        bringForward(id)
        showToast('Unlock to move or resize')
        return
      }

      const targetEl = e.currentTarget
      const pointerId = e.pointerId
      const startClientX = e.clientX
      const startClientY = e.clientY

      if (activeRef.current) endInteraction(false)
      if (canvasResizeRef.current) {
        cleanupRef.current?.()
        canvasResizeRef.current = null
      }

      setSelected(id)
      const brought = bringForward(id)
      const original = brought
        ? { ...brought }
        : { ...(layoutsRef.current[id] ?? { x: 0, y: 0, w: 280, h: 220, z: 1 }) }
      activeRef.current = {
        type,
        id,
        pointerId,
        startClientX,
        startClientY,
        startScrollLeft: shellRef.current?.scrollLeft ?? 0,
        original,
      }
      setActiveUi({ id, type })
      document.body.classList.add('is-manipulating')
      markEditing()

      try {
        targetEl.setPointerCapture(pointerId)
      } catch {
        /* ignore */
      }

      const onMove = (ev: PointerEvent) => {
        const a = activeRef.current
        if (!a || ev.pointerId !== a.pointerId) return
        if (ev.pointerType !== 'mouse') ev.preventDefault()

        if (a.type === 'move') {
          const w = a.original.w
          const h = a.original.h
          const dx = ev.clientX - a.startClientX
          const dy = ev.clientY - a.startClientY
          // commitLayout snaps to grid + clamps; feed raw deltas for magnetic feel
          const x = a.original.x + dx
          const y = a.original.y + dy
          commitLayout(a.id, { ...a.original, x, y, w, h })

          const edge = 56
          if (ev.clientY < edge) window.scrollBy(0, -18)
          if (ev.clientY > window.innerHeight - edge) window.scrollBy(0, 18)
        } else {
          const dx = ev.clientX - a.startClientX
          const dy = ev.clientY - a.startClientY
          let w = a.original.w + dx
          let h = a.original.h + dy

          if (ev.shiftKey) {
            const ratio = a.original.w / Math.max(1, a.original.h)
            if (Math.abs(dx) > Math.abs(dy)) h = w / ratio
            else w = h * ratio
          }

          // Size + bounds snap enforced in commitLayout
          commitLayout(a.id, { ...a.original, w, h })
        }
      }

      const onUp = (ev: PointerEvent) => {
        const a = activeRef.current
        if (!a || ev.pointerId !== a.pointerId) return
        try {
          if (targetEl.hasPointerCapture(ev.pointerId)) {
            targetEl.releasePointerCapture(ev.pointerId)
          }
        } catch {
          /* ignore */
        }
        endInteraction(false)
      }

      const onKey = (ev: globalThis.KeyboardEvent) => {
        if (ev.key === 'Escape' && activeRef.current) {
          ev.preventDefault()
          endInteraction(true)
        }
      }

      window.addEventListener('pointermove', onMove, { passive: true })
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
      window.addEventListener('keydown', onKey)

      cleanupRef.current = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
        window.removeEventListener('keydown', onKey)
      }
    },
    [
      bringForward,
      commitLayout,
      endInteraction,
      layoutsRef,
      markEditing,
      setSelected,
      shellRef,
      showToast,
    ],
  )

  const moveWithKeyboard = (id: string, e: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return
    e.preventDefault()
    setSelected(id)
    const cur = layoutsRef.current[id]
    if (!cur) return
    if (cur.locked) {
      bringForward(id)
      showToast('Unlock to move or resize')
      return
    }
    bringForward(id)
    const step = e.shiftKey ? BOARD_GRID * 3 : BOARD_GRID
    let { x, y, w, h, z, locked } = cur
    if (e.key === 'ArrowLeft') x -= step
    if (e.key === 'ArrowRight') x += step
    if (e.key === 'ArrowUp') y -= step
    if (e.key === 'ArrowDown') y += step
    const next = commitLayout(id, { x, y, w, h, z, locked })
    persist(next)
  }

  const resizeWithKeyboard = (id: string, e: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return
    e.preventDefault()
    setSelected(id)
    const cur = layoutsRef.current[id]
    if (!cur) return
    if (cur.locked) {
      bringForward(id)
      showToast('Unlock to move or resize')
      return
    }
    bringForward(id)
    const step = e.shiftKey ? BOARD_GRID * 3 : BOARD_GRID
    let { x, y, w, h, z, locked } = cur
    if (e.key === 'ArrowLeft') w -= step
    if (e.key === 'ArrowRight') w += step
    if (e.key === 'ArrowUp') h -= step
    if (e.key === 'ArrowDown') h += step
    const next = commitLayout(id, { x, y, w, h, z, locked })
    persist(next)
  }

  return {
    activeUi,
    activeRef,
    canvasResizeRef,
    cleanupRef,
    beginInteraction,
    endInteraction,
    moveWithKeyboard,
    resizeWithKeyboard,
    cancel,
    setActiveUi,
  }
}

type ResizeOpts = {
  customCanvasSize: boolean
  canvasSizeRef: { current: CanvasSize }
  activeRef: { current: Active | null }
  canvasResizeRef: { current: CanvasResizeActive | null }
  cleanupRef: { current: (() => void) | null }
  endInteraction: (cancelled: boolean) => void
  markEditing: () => void
  persistCanvasSize: (size: CanvasSize) => void
  setCanvasSizeSafe: (next: CanvasSize, opts?: { persist?: boolean; toast?: string }) => void
  showToast: (msg: string) => void
}

export function useCanvasResize(opts: ResizeOpts) {
  const {
    customCanvasSize,
    canvasSizeRef,
    activeRef,
    canvasResizeRef,
    cleanupRef,
    endInteraction,
    markEditing,
    persistCanvasSize,
    setCanvasSizeSafe,
    showToast,
  } = opts

  const beginCanvasResize = (e: REPointerEvent<HTMLButtonElement>) => {
    if (!customCanvasSize) return
    e.preventDefault()
    e.stopPropagation()

    const targetEl = e.currentTarget
    const pointerId = e.pointerId
    const original = { ...canvasSizeRef.current }

    if (activeRef.current) endInteraction(false)

    canvasResizeRef.current = {
      pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      original,
    }
    document.body.classList.add('is-manipulating')
    markEditing()

    try {
      targetEl.setPointerCapture(pointerId)
    } catch {
      /* ignore */
    }

    const onMove = (ev: PointerEvent) => {
      const a = canvasResizeRef.current
      if (!a || ev.pointerId !== a.pointerId) return
      const dx = ev.clientX - a.startClientX
      const dy = ev.clientY - a.startClientY
      setCanvasSizeSafe(
        {
          width: a.original.width + dx,
          height: a.original.height + dy,
        },
        { persist: false },
      )
    }

    const onUp = (ev: PointerEvent) => {
      const a = canvasResizeRef.current
      if (!a || ev.pointerId !== a.pointerId) return
      try {
        if (targetEl.hasPointerCapture(ev.pointerId)) {
          targetEl.releasePointerCapture(ev.pointerId)
        }
      } catch {
        /* ignore */
      }
      canvasResizeRef.current = null
      cleanupRef.current?.()
      cleanupRef.current = null
      document.body.classList.remove('is-manipulating')
      persistCanvasSize(canvasSizeRef.current)
      showToast(
        `Canvas ${canvasSizeRef.current.width} × ${canvasSizeRef.current.height}`,
      )
    }

    window.addEventListener('pointermove', onMove, { passive: true })
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    cleanupRef.current = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }

  return { beginCanvasResize }
}
