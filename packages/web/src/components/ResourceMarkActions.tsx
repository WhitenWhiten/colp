import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type SyntheticEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { useToast } from './AppToast'
import { ReadMarkGlyph, SaveMarkGlyph } from './Icon'
import { SaveFolderPicker } from './SaveFolderPicker'
import { anchorPopover, popoverStyle, type AnchorPopoverPos } from '../lib/anchorPopover'
import { EXIT_DURATION_FAST_MS, useExitAnimation } from '../lib/useExitAnimation'
import {
  loadReadIds,
  loadSavedMap,
  setSavedFolder,
  toggleReadId,
  type SavedMap,
} from '../lib/resourceMarks'

type Density = 'card' | 'list' | 'compact'

type Props = {
  resourceId: string
  resourceTitle: string
  density?: Density
  /** When true, stop pointer events from bubbling (canvas drag). */
  stopPointer?: boolean
  className?: string
}

const PICKER_WIDTH = 260

/**
 * Shared read (checkmark) + shortlist controls for board cards, list rows, and compact rows.
 * The shortlist is a device-local filing intent (localStorage), not a library write —
 * R7-04: the copy must never claim the resource landed in a collection.
 * Never succeeds silently: opens a folder picker portaled above all card layers.
 */
export function ResourceMarkActions({
  resourceId,
  resourceTitle,
  density = 'list',
  stopPointer = false,
  className = '',
}: Props) {
  const { toast, success } = useToast()
  const pickerId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const saveBtnRef = useRef<HTMLButtonElement>(null)
  const pickerRef = useRef<HTMLDivElement>(null)
  const [read, setRead] = useState(() => loadReadIds().has(resourceId))
  const [savedFolder, setSavedFolderState] = useState<string | null>(
    () => loadSavedMap()[resourceId] ?? null,
  )
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pos, setPos] = useState<AnchorPopoverPos | null>(null)
  // Exit phase: the picker pops out at the fast tier (matches its enter).
  const { mounted: pickerMounted, closing: pickerClosing } = useExitAnimation(
    pickerOpen,
    EXIT_DURATION_FAST_MS,
  )

  const reposition = useCallback(() => {
    const el = saveBtnRef.current
    if (!el) return
    setPos(
      anchorPopover(el.getBoundingClientRect(), {
        width: PICKER_WIDTH,
        maxHeight: 320,
        align: 'end',
      }),
    )
  }, [])

  useEffect(() => {
    setRead(loadReadIds().has(resourceId))
    setSavedFolderState(loadSavedMap()[resourceId] ?? null)
    setPickerOpen(false)
    setPos(null)
  }, [resourceId])

  useLayoutEffect(() => {
    // Keep the last position while the exit animation plays; a reopen
    // recomputes it here before paint.
    if (!pickerOpen) return
    reposition()
  }, [pickerOpen, reposition])

  useEffect(() => {
    if (!pickerOpen) return

    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node
      if (rootRef.current?.contains(t)) return
      if (pickerRef.current?.contains(t)) return
      setPickerOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPickerOpen(false)
    }
    const onReposition = () => reposition()

    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onReposition)
    window.addEventListener('scroll', onReposition, true)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onReposition)
      window.removeEventListener('scroll', onReposition, true)
    }
  }, [pickerOpen, reposition])

  const onStop = stopPointer
    ? (e: SyntheticEvent) => e.stopPropagation()
    : undefined

  const toggleRead = () => {
    const next = toggleReadId(loadReadIds(), resourceId)
    const nowRead = next.has(resourceId)
    setRead(nowRead)
    toast(nowRead ? 'Marked as read' : 'Marked as unread')
  }

  const openPicker = () => {
    setPickerOpen((v) => !v)
  }

  const pickFolder = (folder: string) => {
    const map = setSavedFolder(loadSavedMap(), resourceId, folder)
    setSavedFolderState(map[resourceId] ?? folder)
    setPickerOpen(false)
    success(`Shortlisted for ${folder} (this device)`)
  }

  const removeSave = () => {
    setSavedFolder(loadSavedMap(), resourceId, null)
    setSavedFolderState(null)
    setPickerOpen(false)
    toast('Removed from shortlist')
  }

  const saved = savedFolder != null

  const pickerStyle = pos ? popoverStyle(pos) : undefined

  /* Portal to body so card overflow / isolation / neighboring tiles cannot cover it. */
  const picker =
    pickerMounted &&
    pos &&
    typeof document !== 'undefined' &&
    createPortal(
      // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- event boundary only: keeps the host card's click/drag handlers from seeing picker interactions; the picker's controls are native buttons
      <div
        ref={pickerRef}
        id={pickerId}
        className={`save-folder-picker-portal${pickerClosing ? ' is-closing' : ''}`}
        style={pickerStyle}
        inert={pickerClosing || undefined}
        data-density={density}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <SaveFolderPicker
          resourceTitle={resourceTitle}
          currentFolder={savedFolder}
          density={density}
          onPick={pickFolder}
          onCancel={() => setPickerOpen(false)}
          onRemove={saved ? removeSave : undefined}
        />
      </div>,
      document.body,
    )

  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- event boundary only: stops mark-button clicks from bubbling to the host card's click/drag handlers; the buttons themselves are native
    <div
      ref={rootRef}
      className={`resource-mark-actions resource-mark-actions--${density} ${className}`.trim()}
      data-testid="resource-mark-actions"
      onPointerDown={onStop}
      onClick={onStop}
    >
      <div className="resource-mark-btns">
        <button
          type="button"
          className={`mark-action mark-action--read ${read ? 'is-active' : ''}`}
          aria-pressed={read}
          aria-label={read ? 'Mark as unread' : 'Mark as read'}
          title={read ? 'Mark as unread' : 'Mark as read'}
          onClick={toggleRead}
        >
          <ReadMarkGlyph />
        </button>

        <button
          ref={saveBtnRef}
          type="button"
          className={`mark-action mark-action--save ${saved ? 'is-active' : ''} ${pickerOpen ? 'is-open' : ''}`}
          aria-pressed={saved}
          aria-expanded={pickerOpen}
          aria-controls={pickerOpen ? pickerId : undefined}
          aria-haspopup="dialog"
          aria-label={
            saved
              ? `Shortlisted for ${savedFolder}. Change folder`
              : 'Shortlist for a folder (kept on this device)'
          }
          title={saved ? `Shortlisted · ${savedFolder}` : 'Shortlist for folder'}
          onClick={openPicker}
        >
          <SaveMarkGlyph />
        </button>
      </div>

      {picker}
    </div>
  )
}

/** Sync external consumers if needed (e.g. tests). */
export function getSavedFolder(resourceId: string): string | null {
  return loadSavedMap()[resourceId] ?? null
}

export function isResourceRead(resourceId: string): boolean {
  return loadReadIds().has(resourceId)
}

export type { SavedMap }
