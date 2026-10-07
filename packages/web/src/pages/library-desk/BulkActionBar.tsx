import { useEffect, useRef, useState } from 'react'
import type { BookmarkNode } from '../../lib/libraryTree'
import type { BulkProgress } from './selection'

export function BulkActionBar({
  mounted,
  closing,
  bulk,
  selectedNodes,
  canMove,
  canDelete,
  canTag,
  onMove,
  onCopy,
  onTag,
  onDelete,
  onCancel,
  selectAll,
  layerBookmarkIds,
}: {
  mounted: boolean
  closing: boolean
  bulk: BulkProgress | null
  selectedNodes: BookmarkNode[]
  canMove: boolean
  canDelete: boolean
  canTag: boolean
  onMove: (nodes: BookmarkNode[]) => void
  onCopy: (nodes: BookmarkNode[]) => void
  onTag: (nodes: BookmarkNode[]) => void
  onDelete: (nodes: BookmarkNode[]) => void
  onCancel: () => void
  selectAll: (ids: string[]) => void
  layerBookmarkIds: string[]
}) {
  const barRef = useRef<HTMLDivElement>(null)
  const [barHeight, setBarHeight] = useState(0)

  useEffect(() => {
    if (!mounted) return
    const el = barRef.current
    if (!el) return
    const update = () => {
      setBarHeight(el.offsetHeight)
    }
    update()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [mounted])

  /* APG toolbar: one tab stop on the first enabled control; arrows roam. */
  useEffect(() => {
    let firstEnabledSeen = false
    for (const button of barRef.current?.querySelectorAll('button') ?? []) {
      const enabled = !button.disabled
      button.tabIndex = enabled && !firstEnabledSeen ? 0 : -1
      firstEnabledSeen ||= enabled
    }
  })

  const onToolbarKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const items = [...(barRef.current?.querySelectorAll('button') ?? [])].filter((b) => !b.disabled)
    if (items.length === 0) return
    const from = items.indexOf(document.activeElement as HTMLButtonElement)
    if (from < 0) return
    let next: number | null = null
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (from + 1) % items.length
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (from - 1 + items.length) % items.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = items.length - 1
    if (next === null || next === from) return
    event.preventDefault()
    items.forEach((b) => { b.tabIndex = -1 })
    const target = items[next]!
    target.tabIndex = 0
    target.focus({ preventScroll: true })
  }

  if (!mounted) return null
  return (
    <>
      <div
        ref={barRef}
        className={`library-bulkbar${closing ? ' is-closing' : ''}`}
        data-testid="library-bulkbar"
        role="toolbar"
        aria-label="Selected bookmark actions"
        inert={closing || undefined}
        onKeyDown={onToolbarKeyDown}
      >
      <span className="library-bulkbar-count" aria-live="polite">
        {bulk
          ? `${bulk.verb} ${Math.min(bulk.done + 1, bulk.total)}/${bulk.total}…`
          : `${selectedNodes.length} selected`}
      </span>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        disabled={bulk !== null}
        onClick={() => selectAll(layerBookmarkIds)}
      >
        Select all ({layerBookmarkIds.length})
      </button>
      {canMove && (
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={bulk !== null || selectedNodes.length === 0}
          onClick={() => onMove(selectedNodes)}
        >
          Move
        </button>
      )}
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        disabled={bulk !== null || selectedNodes.length === 0}
        onClick={() => onCopy(selectedNodes)}
      >
        Copy
      </button>
      {canTag && (
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          aria-haspopup="dialog"
          disabled={bulk !== null || selectedNodes.length === 0}
          onClick={() => onTag(selectedNodes)}
        >
          Tag…
        </button>
      )}
      {canDelete && (
        <button
          type="button"
          className="btn btn-danger-ghost btn-sm"
          disabled={bulk !== null || selectedNodes.length === 0}
          onClick={() => onDelete(selectedNodes)}
        >
          Delete
        </button>
      )}
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        disabled={bulk !== null}
        onClick={onCancel}
      >
        Cancel
      </button>
    </div>
    <div
      className="library-bulkbar-spacer"
      aria-hidden="true"
      style={{ ['--library-bulkbar-h' as string]: closing ? '0px' : `${barHeight}px` }}
    />
  </>
  )
}
