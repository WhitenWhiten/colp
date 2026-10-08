import { useEffect, useRef, useState } from 'react'
import { clamp, HEIGHT, WIDTH, MAX_ZOOM, MIN_ZOOM } from './layout'

/* Drag threshold before a blank-area pointer becomes a pan, and the point
   where a touch decides between graph pan (horizontal) and page scroll
   (vertical — .graph-svg keeps touch-action: pan-y, so the browser takes
   vertical gestures and fires pointercancel). */
const DRAG_THRESHOLD_PX = 4
const TOUCH_THRESHOLD_PX = 10

export function useGraphViewport(ready: boolean) {
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const canvasRef = useRef<HTMLDivElement>(null)
  const panRef = useRef(pan)
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    panX: number
    panY: number
    active: boolean
    touch: boolean
  } | null>(null)
  panRef.current = pan

  useEffect(() => {
    if (!ready) return
    const el = canvasRef.current
    if (!el) return
    const onWheel = (event: WheelEvent) => {
      /* Bare wheel = page scroll, even over the canvas. Zoom only on an
         explicit modifier: ctrl/meta covers ctrl+wheel and trackpad pinch
         (which browsers report as ctrlKey wheel). */
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      const delta = event.deltaY > 0 ? -0.08 : 0.08
      setZoom((z) => clamp(Number((z + delta).toFixed(2)), MIN_ZOOM, MAX_ZOOM))
    }
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || !event.isPrimary) return
      if ((event.target as Element | null)?.closest?.('button, a, .graph-node, .graph-zoom-controls, .graph-tooltip')) return
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        panX: panRef.current.x,
        panY: panRef.current.y,
        active: false,
        touch: event.pointerType === 'touch',
      }
      /* Pointer capture waits until the gesture is actually a pan — a touch
         captured at pointerdown would still lose to the browser's pan-y
         scroll anyway, and capturing early only muddies the handoff. */
      if (event.pointerType === 'mouse') el.setPointerCapture(event.pointerId)
    }
    const onPointerMove = (event: PointerEvent) => {
      const drag = dragRef.current
      if (!drag || event.pointerId !== drag.pointerId) return
      const dxPx = event.clientX - drag.startX
      const dyPx = event.clientY - drag.startY
      if (!drag.active) {
        const distance = Math.hypot(dxPx, dyPx)
        if (drag.touch) {
          if (distance < TOUCH_THRESHOLD_PX) return
          /* A vertical-dominant touch is a page scroll — release the
             gesture so the browser's pan-y scroll can take it. */
          if (Math.abs(dyPx) > Math.abs(dxPx)) {
            dragRef.current = null
            return
          }
        } else if (distance < DRAG_THRESHOLD_PX) return
        drag.active = true
        if (!el.hasPointerCapture(drag.pointerId)) {
          try { el.setPointerCapture(drag.pointerId) } catch { /* pointer already released */ }
        }
      }
      const rect = el.getBoundingClientRect()
      const scale = Math.min(rect.width / WIDTH, rect.height / HEIGHT)
      if (scale <= 0) return
      setPan({ x: drag.panX + dxPx / scale, y: drag.panY + dyPx / scale })
    }
    const onPointerUp = () => {
      dragRef.current = null
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('pointermove', onPointerMove)
    el.addEventListener('pointerup', onPointerUp)
    el.addEventListener('pointercancel', onPointerUp)
    el.addEventListener('lostpointercapture', onPointerUp)
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('pointermove', onPointerMove)
      el.removeEventListener('pointerup', onPointerUp)
      el.removeEventListener('pointercancel', onPointerUp)
      el.removeEventListener('lostpointercapture', onPointerUp)
      dragRef.current = null
    }
  }, [ready])

  const resetView = () => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }

  return { zoom, setZoom, pan, resetView, canvasRef }
}
