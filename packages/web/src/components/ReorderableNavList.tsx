import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { insertionIndexForPointer, moveId } from '../lib/libraryOrder'
import { DURATION_STATE_MS } from '../lib/durations'
import { ReorderMoveButtons, fromReorderControls, type ReorderMoveAction } from './ReorderMoveButtons'

const LONG_PRESS_MS = 450
const LONG_PRESS_SLOP_PX = 8
const PRESS_WASH_MS = 150

type ReorderItem = {
  id: string
  /** Spoken name for the sortable wrapper while the inner link is inert. */
  label: string
  node: ReactNode
}

type ReorderableNavListProps = {
  /** Row ids in render order; must match `items` one to one. */
  ids: readonly string[]
  items: readonly ReorderItem[]
  /** True while this section is the one being reordered. */
  active: boolean
  /** Fewer than two rows: long-press stays inert. */
  disabled?: boolean
  ariaLabel: string
  onActivate: () => void
  /** Live order updates while a row is dragged or moved with the keyboard. */
  onOrderChange: (ids: readonly string[]) => void
  /** Leave reorder mode. The parent persists on exit, not on every move. */
  onDismiss: () => void
}

/**
 * A vertical list whose rows rearrange by drag within this list only.
 *
 * Long-pressing any row (or the section Reorder chip) asks the parent to
 * enter reorder mode; while active, row children are inert, clicks are
 * swallowed, and the wrapper itself is the treeitem in the tab order so AT
 * is not left focusing a tree with no reachable items. Rows can be dragged
 * or moved with Arrow keys. The pointer math never looks outside this
 * component, so a row cannot leave its section.
 */
export function ReorderableNavList({
  ids,
  items,
  active,
  disabled = false,
  ariaLabel,
  onActivate,
  onOrderChange,
  onDismiss,
}: ReorderableNavListProps) {
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

  const onKeyDown = (id: string, event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!active) return
    if (event.key === 'Escape') {
      event.preventDefault()
      onDismiss()
      return
    }
    // Arrow keys move the row only from the row, not from its move buttons.
    if (event.target !== event.currentTarget) return
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    const from = idsRef.current.indexOf(id)
    if (from === -1) return
    const next = moveId(idsRef.current, from, event.key === 'ArrowUp' ? from - 1 : from + 1)
    if (next === idsRef.current) return
    keyboardFocusRef.current = id
    onOrderChange(next)
  }

  return (
    <div
      ref={listRef}
      className={
        active
          ? 'library-nav-tree is-reordering'
          : disabled
            ? 'library-nav-tree is-reorder-disabled'
            : 'library-nav-tree'
      }
      /* R15-44 (R13 D-25 option B): a plain list while idle — the rows are
         links with their own disclosure buttons, not a keyboard tree — and
         a tree of sortable items only during reorder mode. */
      role={active ? 'tree' : 'list'}
      aria-label={ariaLabel}
      data-reordering={active || undefined}
    >
      {items.map(({ id, label, node }, index) => (
        // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- pointer handlers drive drag/long-press reorder; the keyboard equivalent is ArrowUp/Down + Esc (onKeyDown below) after entering reorder mode from the section's reorder button
        <div
          key={id}
          ref={(el) => {
            if (el) itemRefs.current.set(id, el)
            else itemRefs.current.delete(id)
          }}
          className={
            draggingId === id
              ? 'library-nav-reorder-item is-dragging'
              : pressingId === id
                ? 'library-nav-reorder-item is-pressing'
                : 'library-nav-reorder-item'
          }
          style={draggingId === id ? { transform: `translateY(${dragOffset}px)` } : undefined}
          data-reorder-id={id}
          data-dragging={draggingId === id || undefined}
          role={active ? 'treeitem' : 'listitem'}
          tabIndex={active ? 0 : undefined}
          aria-label={active ? label : undefined}
          aria-roledescription={active ? 'sortable collection' : undefined}
          aria-selected={active ? false : undefined}
          aria-level={active ? 1 : undefined}
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
