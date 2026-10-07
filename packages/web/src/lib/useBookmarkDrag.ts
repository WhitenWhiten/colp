import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { BookmarkNode } from './libraryTree'

/** Pointer travel beyond this turns a press into a drag (below = click). */
export const BOOKMARK_DRAG_THRESHOLD_PX = 6

export type BookmarkDragTarget = {
  /** Sidebar row that receives the .is-drop-target highlight. */
  element: Element
  /** Folder (or root) the dragged bookmarks would be appended to. */
  parentId: string
}

export type BookmarkDragGhost = { title: string; count: number }

type BookmarkDragOptions = {
  /** Sidebar reorder active or a bulk operation in flight: never arm. */
  suppressed: boolean
  /** Expand the pressed row to the nodes the drop applies to (multi-select). */
  nodesForRow: (node: BookmarkNode) => BookmarkNode[]
  /** Map the hovered element to a drop target; null = invalid, no highlight. */
  resolveTarget: (element: Element, nodes: BookmarkNode[]) => BookmarkDragTarget | null
  /** Perform the move; the executor appends (afterId/beforeId stay null). */
  onDrop: (nodes: BookmarkNode[], parentId: string) => void
}

type DragSession = {
  pointerId: number
  originX: number
  originY: number
  lastX: number
  lastY: number
  node: BookmarkNode
  nodes: BookmarkNode[]
  activated: boolean
  cancelled: boolean
  frame: number | null
  targetElement: Element | null
  targetParentId: string | null
}

/**
 * Desktop-only (hover + fine pointer) drag of Library bookmark rows onto
 * sidebar folders / the current collection root. Pointer events, no HTML5
 * DnD: a left-button mouse press arms the gesture, crossing the threshold
 * activates it (and swallows the click so the row link never navigates),
 * Esc cancels, releasing over a resolved target fires onDrop.
 *
 * While active, <body data-bookmark-drag> disables text selection and
 * doubles as the mutual-exclusion signal the sidebar reorder checks.
 */
export function useBookmarkDrag(options: BookmarkDragOptions) {
  const [ghost, setGhost] = useState<BookmarkDragGhost | null>(null)
  const optionsRef = useRef(options)
  optionsRef.current = options

  const engine = useMemo(() => {
    let session: DragSession | null = null
    let ghostElement: HTMLDivElement | null = null

    const positionGhost = () => {
      if (!session || !ghostElement) return
      ghostElement.style.transform = `translate3d(${session.lastX + 14}px, ${session.lastY + 10}px, 0)`
    }

    // rAF-aligned cursor following; no easing, so reduced motion needs no
    // JS special case (the CSS side is handled by the polish.css gate).
    const scheduleGhostFrame = () => {
      if (!session || session.frame !== null) return
      session.frame = requestAnimationFrame(() => {
        if (session) session.frame = null
        positionGhost()
      })
    }

    const clearTarget = () => {
      if (!session) return
      session.targetElement?.classList.remove('is-drop-target')
      session.targetElement?.removeAttribute('data-drop-target')
      session.targetElement = null
      session.targetParentId = null
    }

    const swallowClick = (event: MouseEvent) => {
      event.preventDefault()
      event.stopPropagation()
      document.removeEventListener('click', swallowClick, true)
    }

    /** Visual teardown; the pointer keeps being tracked until it lifts. */
    const deactivate = () => {
      if (!session) return
      clearTarget()
      if (session.frame !== null) {
        cancelAnimationFrame(session.frame)
        session.frame = null
      }
      document.body.removeAttribute('data-bookmark-drag')
      setGhost(null)
    }

    const finish = () => {
      if (!session) return
      const wasActivated = session.activated
      deactivate()
      session = null
      document.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('pointerup', onPointerUp)
      document.removeEventListener('pointercancel', onPointerCancel)
      document.removeEventListener('keydown', onKeyDown, true)
      if (wasActivated) {
        // The click born from this gesture dispatches synchronously after
        // pointerup; drop the swallow listener on the next macrotask.
        window.setTimeout(() => document.removeEventListener('click', swallowClick, true), 0)
      }
    }

    const onPointerMove = (event: PointerEvent) => {
      if (!session || event.pointerId !== session.pointerId || session.cancelled) return
      session.lastX = event.clientX
      session.lastY = event.clientY
      if (!session.activated) {
        const travel = Math.hypot(event.clientX - session.originX, event.clientY - session.originY)
        if (travel <= BOOKMARK_DRAG_THRESHOLD_PX) return
        session.activated = true
        session.nodes = optionsRef.current.nodesForRow(session.node)
        document.addEventListener('click', swallowClick, true)
        document.body.setAttribute('data-bookmark-drag', '')
        setGhost({ title: session.node.title, count: session.nodes.length })
      }
      event.preventDefault()
      scheduleGhostFrame()
      const hovered = event.target instanceof Element ? event.target : null
      const next = hovered ? optionsRef.current.resolveTarget(hovered, session.nodes) : null
      if (next?.element !== session.targetElement) {
        clearTarget()
        if (next) {
          session.targetElement = next.element
          session.targetParentId = next.parentId
          next.element.classList.add('is-drop-target')
          next.element.setAttribute('data-drop-target', 'true')
        }
      }
    }

    const onPointerUp = (event: PointerEvent) => {
      if (!session || event.pointerId !== session.pointerId) return
      const drop = session.activated && !session.cancelled && session.targetParentId !== null
        ? { nodes: session.nodes, parentId: session.targetParentId }
        : null
      finish()
      if (drop) optionsRef.current.onDrop(drop.nodes, drop.parentId)
    }

    const onPointerCancel = (event: PointerEvent) => {
      if (!session || event.pointerId !== session.pointerId) return
      finish()
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !session || !session.activated) return
      session.cancelled = true
      deactivate()
    }

    const rowPointerDown = (node: BookmarkNode) => (event: ReactPointerEvent) => {
      if (session || optionsRef.current.suppressed) return
      // Mouse left button on a hover-capable fine pointer only; touch keeps
      // its long-press semantics and the P0 destination picker.
      if (event.pointerType !== 'mouse' || event.button !== 0) return
      if (!globalThis.matchMedia?.('(hover: hover) and (pointer: fine)').matches) return
      const pressed = event.target instanceof Element ? event.target : null
      // The selection checkbox and the row ⋯ menu keep their own clicks.
      if (pressed?.closest('input, button')) return
      session = {
        pointerId: event.pointerId,
        originX: event.clientX,
        originY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        node,
        nodes: [node],
        activated: false,
        cancelled: false,
        frame: null,
        targetElement: null,
        targetParentId: null,
      }
      document.addEventListener('pointermove', onPointerMove)
      document.addEventListener('pointerup', onPointerUp)
      document.addEventListener('pointercancel', onPointerCancel)
      document.addEventListener('keydown', onKeyDown, true)
    }

    const attachGhost = (el: HTMLDivElement | null) => {
      ghostElement = el
      positionGhost()
    }

    return { rowPointerDown, attachGhost, finish }
  }, [])

  useEffect(() => () => engine.finish(), [engine])

  return {
    /** True from threshold crossing until drop / cancel. */
    dragging: ghost !== null,
    ghost,
    attachGhost: engine.attachGhost,
    rowPointerDown: engine.rowPointerDown,
  }
}
