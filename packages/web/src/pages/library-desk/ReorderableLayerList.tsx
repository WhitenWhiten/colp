import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { insertionIndexForPointer, moveId } from '../../lib/libraryOrder'
import { DURATION_STATE_MS } from '../../lib/durations'
import { ReorderMoveButtons, fromReorderControls, type ReorderMoveAction } from '../../components/ReorderMoveButtons'

const LONG_PRESS_MS = 450
const LONG_PRESS_SLOP_PX = 8
const PRESS_WASH_MS = 150

type LayerReorderItem = {
  id: string
  /** Spoken name for the sortable wrapper while the inner row is inert. */
  label: string
  /** Kind glyph substitute for readings; null hides the glyph slot. */
  kind: 'folder' | 'bookmark' | null
  node: ReactNode
}

type ReorderableLayerListProps = {
  /** Row ids in canonical (render) order; must match `items` one to one. */
  ids: readonly string[]
  items: readonly LayerReorderItem[]
  /** True while this layer is the one being reordered. */
  active: boolean
  /** Fewer than two rows: the reorder list stays inert. */
  disabled?: boolean
  ariaLabel: string
  onActivate: () => void
  /** Live order updates while a row is dragged or moved with the keyboard. */
  onOrderChange: (ids: readonly string[]) => void
  /** Leave reorder mode. The parent persists on exit, not on every move. */
  onDismiss: () => void
}

/**
 * The desk's folder-layer reorder list, mirroring the sidebar
 * ReorderableNavList contract with list semantics: same drag-within-this-list
 * and Arrow/Home/End keyboard moves through the same `onOrderChange` sink, so
 * mouse and keyboard reach the identical command path. All pointer math stays
 * inside this component: a row can never leave its parent layer.
 */
export function ReorderableLayerList({
  ids,
  items,
  active,
  disabled = false,
  ariaLabel,
  onActivate,
  onOrderChange,
  onDismiss,
}: ReorderableLayerListProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef(new Map<string, HTMLDivElement>())
  const pressRef = useRef<{
    id: string
    x: number
    y: number
    timer: ReturnType<typeof setTimeout>
    wash: ReturnType<typeof setTimeout>
  } | null>(null)
  const dragRef = useRef<{ id: string; pointerId: number; startClientY: number; startOffsetTop: number } | null>(null)
  const suppressClickRef = useRef(false)
  const keyboardFocusRef = useRef<string | null>(null)
  const prevTopsRef = useRef(new Map<string, number>())
  const idsRef = useRef(ids)
  idsRef.current = ids
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dragOffset, setDragOffset] = useState(0)
  const [pressingId, setPressingId] = useState<string | null>(null)

  const cancelPress = () => {
    if (pressRef.current) {
      clearTimeout(pressRef.current.timer)
      clearTimeout(pressRef.current.wash)
      pressRef.current = null
    }
    setPressingId(null)
  }

  const endDrag = () => {
    if (!dragRef.current) return
    dragRef.current = null
    setDraggingId(null)
    setDragOffset(0)
  }

  useEffect(() => {
    if (!active) {
      cancelPress()
      endDrag()
    }
  }, [active])

  // FLIP: rows that changed slots glide to their new position; the dragged
  // row is excluded because it already follows the pointer transform.
  useLayoutEffect(() => {
    for (const id of ids) {
      const el = itemRefs.current.get(id)
      if (!el) continue
      const top = el.offsetTop
      const prev = prevTopsRef.current.get(id)
      if (prev !== undefined && prev !== top && id !== draggingId) {
        const reduceMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches
        if (!reduceMotion) {
          el.animate?.(
            [{ transform: `translateY(${prev - top}px)` }, { transform: 'translateY(0)' }],
            { duration: DURATION_STATE_MS, easing: 'cubic-bezier(0.25, 1, 0.5, 1)' },
          )
        }
      }
      prevTopsRef.current.set(id, top)
    }
  }, [draggingId, ids])

  useEffect(() => {
    if (!keyboardFocusRef.current) return
    itemRefs.current.get(keyboardFocusRef.current)?.focus()
    keyboardFocusRef.current = null
  }, [ids])

  /* R15-42: a move button keeps focus on the same action in the row's new
     slot (or the row, once that action is disabled at an end). */
  const buttonFocusRef = useRef<{ id: string; action: ReorderMoveAction } | null>(null)
  useEffect(() => {
    const target = buttonFocusRef.current
    if (!target) return
    buttonFocusRef.current = null
    const row = itemRefs.current.get(target.id)
    const button = row?.querySelector<HTMLButtonElement>(`[data-move="${target.action}"]`)
    if (button && !button.disabled) button.focus()
    else row?.focus()
  }, [ids])

  const buttonMove = (id: string, to: number, action: ReorderMoveAction) => {
    const from = idsRef.current.indexOf(id)
    if (from === -1) return
    const next = moveId(idsRef.current, from, to)
    if (next === idsRef.current) return
    buttonFocusRef.current = { id, action }
    onOrderChange(next)
  }

  const onPointerDown = (id: string, event: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || fromReorderControls(event.target)) return
    if (!active) {
      cancelPress()
      pressRef.current = {
        id,
        x: event.clientX,
        y: event.clientY,
        wash: setTimeout(() => setPressingId(id), PRESS_WASH_MS),
        timer: setTimeout(() => {
          pressRef.current = null
          setPressingId(null)
          suppressClickRef.current = true
          onActivate()
        }, LONG_PRESS_MS),
      }
      return
    }
    event.preventDefault()
    const el = itemRefs.current.get(id)
    if (!el) return
    el.setPointerCapture?.(event.pointerId)
    dragRef.current = {
      id,
      pointerId: event.pointerId,
      startClientY: event.clientY,
      startOffsetTop: el.offsetTop,
    }
    setDraggingId(id)
    setDragOffset(0)
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const press = pressRef.current
    if (press) {
      const distance = Math.hypot(event.clientX - press.x, event.clientY - press.y)
      if (distance > LONG_PRESS_SLOP_PX) cancelPress()
    }
    const drag = dragRef.current
    if (!drag || event.pointerId !== drag.pointerId) return
    const el = itemRefs.current.get(drag.id)
    const list = listRef.current
    if (!el || !list) return
    setDragOffset(event.clientY - drag.startClientY - (el.offsetTop - drag.startOffsetTop))
    const listTop = list.getBoundingClientRect().top
    const pointerY = event.clientY - listTop
    const midpoints = new Map<string, number>()
    for (const id of idsRef.current) {
      if (id === drag.id) continue
      const other = itemRefs.current.get(id)
      if (!other) continue
      midpoints.set(id, other.offsetTop + other.offsetHeight / 2)
    }
    const insertion = insertionIndexForPointer(idsRef.current, drag.id, pointerY, midpoints)
    const from = idsRef.current.indexOf(drag.id)
    if (from !== -1 && insertion !== from) {
      onOrderChange(moveId(idsRef.current, from, insertion))
    }
  }

  const onPointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    cancelPress()
    const drag = dragRef.current
    if (drag && event.pointerId === drag.pointerId) {
      itemRefs.current.get(drag.id)?.releasePointerCapture?.(drag.pointerId)
      endDrag()
    }
  }

  const onClickCapture = (event: React.MouseEvent<HTMLDivElement>) => {
    if (fromReorderControls(event.target)) return
    if (suppressClickRef.current || active) {
      event.preventDefault()
      event.stopPropagation()
      suppressClickRef.current = false
    }
  }

  const keyMove = (id: string, to: number) => {
    const from = idsRef.current.indexOf(id)
    if (from === -1) return
    const next = moveId(idsRef.current, from, to)
    if (next === idsRef.current) return
    keyboardFocusRef.current = id
    onOrderChange(next)
  }

  const onKeyDown = (id: string, event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!active) return
    if (event.key === 'Escape') {
      event.preventDefault()
      onDismiss()
      return
    }
    // Arrow keys move the row only from the row, not from its move buttons.
    if (event.target !== event.currentTarget) return
    const from = idsRef.current.indexOf(id)
    if (from === -1) return
    let to: number | null = null
    if (event.key === 'ArrowUp') to = from - 1
    else if (event.key === 'ArrowDown') to = from + 1
    else if (event.key === 'Home') to = 0
    else if (event.key === 'End') to = idsRef.current.length - 1
    if (to === null) return
    event.preventDefault()
    keyMove(id, to)
  }

  return (
    <div
      ref={listRef}
      className={
        active
          ? 'library-layer-reorder-list is-reordering'
          : disabled
            ? 'library-layer-reorder-list is-reorder-disabled'
            : 'library-layer-reorder-list'
      }
      role="list"
      aria-label={ariaLabel}
      data-layer-reordering={active || undefined}
    >
      {items.map(({ id, label, kind, node }, index) => (
        // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- pointer handlers drive drag/long-press reorder; the keyboard equivalent is Arrow/Home/End + Esc (onKeyDown below) after entering reorder mode from the layer Reorder button
        <div
          key={id}
          ref={(el) => {
            if (el) itemRefs.current.set(id, el)
            else itemRefs.current.delete(id)
          }}
          className={
            draggingId === id
              ? 'library-layer-reorder-item is-dragging'
              : pressingId === id
                ? 'library-layer-reorder-item is-pressing'
                : 'library-layer-reorder-item'
          }
          style={draggingId === id ? { transform: `translateY(${dragOffset}px)` } : undefined}
          data-reorder-id={id}
          data-layer-kind={kind ?? undefined}
          data-dragging={draggingId === id || undefined}
          role={active ? 'listitem' : undefined}
          tabIndex={active ? 0 : undefined}
          aria-label={active ? label : undefined}
          aria-roledescription={active ? 'sortable item' : undefined}
          aria-posinset={active ? index + 1 : undefined}
          aria-setsize={active ? ids.length : undefined}
          onPointerDown={(event) => onPointerDown(id, event)}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onClickCapture={onClickCapture}
          onKeyDown={(event) => onKeyDown(id, event)}
          onContextMenu={(event) => {
            if (active || pressRef.current) event.preventDefault()
          }}
        >
          <div inert={active || undefined}>
            {node}
          </div>
          {active ? (
            <ReorderMoveButtons label={label} index={index} count={ids.length} onMove={(to, action) => buttonMove(id, to, action)} />
          ) : null}
        </div>
      ))}
    </div>
  )
}