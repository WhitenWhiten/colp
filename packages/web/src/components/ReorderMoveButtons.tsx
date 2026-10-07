import { Icon } from './Icon'

/**
 * R15-42: a single-pointer way to reorder (2.5.7). In reorder mode each row
 * offers Move to top / Move up / Move down, next to drag and the
 * Arrow/Home/End keys, through the same move command.
 */
export function ReorderMoveButtons({ label, index, count, onMove }: {
  /** The row's spoken name, used in each button's name. */
  label: string
  index: number
  count: number
  onMove: (to: number, action: ReorderMoveAction) => void
}) {
  const first = index === 0
  const last = index === count - 1
  return (
    <div className="reorder-move-buttons" data-reorder-controls>
      <button type="button" className="btn btn-ghost btn-sm" data-move="top" aria-label={`Move ${label} to top`} disabled={first} onClick={() => onMove(0, 'top')}>
        <Icon name="arrow-up" />
      </button>
      <button type="button" className="btn btn-ghost btn-sm" data-move="up" aria-label={`Move ${label} up`} disabled={first} onClick={() => onMove(index - 1, 'up')}>
        <Icon name="chevron-up" />
      </button>
      <button type="button" className="btn btn-ghost btn-sm" data-move="down" aria-label={`Move ${label} down`} disabled={last} onClick={() => onMove(index + 1, 'down')}>
        <Icon name="chevron-down" />
      </button>
    </div>
  )
}

export type ReorderMoveAction = 'top' | 'up' | 'down'

/** Is this event from inside a row's move buttons (not the draggable row)? */
export function fromReorderControls(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-reorder-controls]') !== null
}
