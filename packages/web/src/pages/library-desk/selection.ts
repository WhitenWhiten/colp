import { useCallback, useState } from 'react'
import type { EditableNodeView } from '../../api'
import { useExitAnimation } from '../../lib/useExitAnimation'

export type BulkVerb = 'Moving' | 'Copying' | 'Deleting' | 'Tagging'
export type BulkProgress = { verb: BulkVerb; done: number; total: number }
export type PickerState = { mode: 'move' | 'copy'; nodes: EditableNodeView[] }

/** One-time marker: the long-press multi-select tip has been shown. */
const SELECT_TIP_KEY = 'known.library.select-tip.v1'

export function useLibraryDeskSelection(options: {
  toast: (message: string) => void
}) {
  const { toast } = options
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set())
  // Exit phase: the bulk bar fades out when leaving select mode.
  const { mounted: bulkbarMounted, closing: bulkbarClosing } = useExitAnimation(selectMode)
  const [picker, setPicker] = useState<PickerState | null>(null)
  const [bulk, setBulk] = useState<BulkProgress | null>(null)

  const enterSelectMode = (initialId?: string, source: 'menu' | 'long-press' = 'menu') => {
    setSelectMode(true)
    // The selection resets on entry, not on exit: clearing at exit would
    // repaint the bulk bar as "0 selected" (disabled buttons, an aria-live
    // announcement) for the whole exit animation. Rows only reach this
    // handler while select mode is off, so a fresh set never wipes an
    // in-progress selection.
    setSelectedIds(initialId ? new Set([initialId]) : new Set())
    // One-time discoverability tip, only for the gesture entry (the menu path
    // already taught the user where Select lives).
    if (source === 'long-press') {
      try {
        if (localStorage.getItem(SELECT_TIP_KEY) === null) {
          localStorage.setItem(SELECT_TIP_KEY, '1')
          toast('Tip: long-press any bookmark to add it to the selection')
        }
      } catch { /* storage unavailable: tip may repeat, never blocks */ }
    }
  }

  const exitSelectMode = () => {
    // Leave selectedIds intact so the bulk bar keeps painting its last
    // counts while the exit animation plays; enterSelectMode resets them.
    setSelectMode(false)
  }

  const toggleSelected = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Replaces the set: Select all means these ids, not a union with leftovers.
  const selectAll = (ids: string[]) => {
    setSelectedIds(new Set(ids))
  }

  const resetSelection = useCallback(() => {
    setSelectMode(false)
    setSelectedIds(new Set())
    setPicker(null)
  }, [])

  return {
    selectMode,
    selectedIds,
    bulkbarMounted,
    bulkbarClosing,
    picker,
    setPicker,
    bulk,
    setBulk,
    enterSelectMode,
    exitSelectMode,
    toggleSelected,
    selectAll,
    resetSelection,
  }
}

export type LibraryDeskSelection = ReturnType<typeof useLibraryDeskSelection>
