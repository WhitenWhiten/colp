import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { transientToastDwell } from '../AppToast'
import { CARD_CHROME_H } from '../../lib/cardChrome'
import { loadThemeMap, persistThemeMap, type DeskThemeId, type ThemeMap } from '../../lib/deskThemes'
import { useExitAnimation } from '../../lib/useExitAnimation'
import { DURATION_STATE_MS } from '../../lib/durations'
import { canvasShellOverflows, type CanvasShellOverflow } from '../../lib/canvasShellOverflow'
import type { CardLayout, Resource } from '../../types/catalog'
import {
  clamp,
  contentBounds,
  DEFAULT_CANVAS,
  layoutsFromResources,
  MAX_CANVAS,
  maxZ,
  MIN_CANVAS,
  minSizeForResource,
  normalizeStackOrder,
  snapLayoutMap,
  snapRect,
  type CanvasSize,
  type LayoutMap,
} from './geometry'
import { applyBoardMetrics as writeBoardMetrics } from './metrics'
import {
  canvasSizeStorageKey,
  clearCanvasStorage,
  loadCanvasSize,
  loadLayouts,
  persistCanvasSize as persistCanvasSizeToStorage,
  persistLayouts,
  snapCanvasSize,
} from './persistence'

const SHELL_OVERFLOW_NONE: CanvasShellOverflow = { start: false, end: false }

/** Local theme state + persistThemeMap. Both fields must stay omitted together. */
export type CanvasBoardUncontrolledThemes = {
  themeMap?: undefined
  onThemeMapChange?: undefined
}

/** Parent-owned theme map. Passing `themeMap` without the writer is a type error. */
export type CanvasBoardControlledThemes = {
  themeMap: ThemeMap
  onThemeMapChange: (next: ThemeMap) => void
}

export type CanvasBoardThemeProps = CanvasBoardUncontrolledThemes | CanvasBoardControlledThemes

type CanvasBoardStateBase = {
  resources: Resource[]
  storageKey: string
  showEditChrome?: boolean
  layoutEditable?: boolean
  customCanvasSize?: boolean
  defaultCanvasSize?: CanvasSize
  cancelInteraction: () => void
}

export type CanvasBoardStateProps = CanvasBoardStateBase & CanvasBoardThemeProps

export function useCanvasBoard({
  resources,
  storageKey,
  showEditChrome = true,
  layoutEditable,
  customCanvasSize = false,
  defaultCanvasSize = DEFAULT_CANVAS,
  themeMap: themeMapProp,
  onThemeMapChange,
  cancelInteraction,
}: CanvasBoardStateProps) {
  const canEditLayout = layoutEditable ?? showEditChrome
  const boardRef = useRef<HTMLDivElement>(null)
  const shellRef = useRef<HTMLDivElement>(null)
  const sizeKey = canvasSizeStorageKey(storageKey)
  const initial = useMemo(() => layoutsFromResources(resources), [resources])

  const [layouts, setLayouts] = useState<LayoutMap>(() =>
    loadLayouts(storageKey, resources),
  )
  const [localThemes, setLocalThemes] = useState<ThemeMap>(() => loadThemeMap(storageKey))
  const controlledThemes = themeMapProp !== undefined && onThemeMapChange !== undefined
  const themes = controlledThemes ? themeMapProp : localThemes

  const setThemeFor = useCallback(
    (id: string, themeId: DeskThemeId) => {
      if (themeMapProp !== undefined && onThemeMapChange !== undefined) {
        onThemeMapChange({ ...themeMapProp, [id]: themeId })
        return
      }
      setLocalThemes((prev) => {
        const next = { ...prev, [id]: themeId }
        persistThemeMap(storageKey, next)
        return next
      })
    },
    [themeMapProp, onThemeMapChange, storageKey],
  )
  const layoutsRef = useRef(layouts)
  layoutsRef.current = layouts

  const [canvasSize, setCanvasSize] = useState<CanvasSize>(() =>
    customCanvasSize
      ? loadCanvasSize(sizeKey, defaultCanvasSize)
      : { width: 0, height: 0 },
  )
  const canvasSizeRef = useRef(canvasSize)
  canvasSizeRef.current = canvasSize

  const [selected, setSelected] = useState<string | null>(null)
  const [status, setStatus] = useState<'saved' | 'editing'>('saved')
  /* Board-local status pill, deliberately not the global AppToast: board edit
     feedback (lock/reset/resize) belongs next to the canvas, is transient
     (dwell shared via transientToastDwell), non-interactive (pointer-events
     none, so no close/pause needed), and dies with the board on route change.
     AppToast stays the channel for app-level events and actions (Undo). */
  const [toast, setToast] = useState<string | null>(null)
  const [widthInput, setWidthInput] = useState(String(canvasSize.width || defaultCanvasSize.width))
  const [heightInput, setHeightInput] = useState(
    String(canvasSize.height || defaultCanvasSize.height),
  )
  const [shellOverflow, setShellOverflow] = useState<CanvasShellOverflow>(SHELL_OVERFLOW_NONE)

  const zRef = useRef(maxZ(initial))
  const toastTimer = useRef<number | undefined>(undefined)
  const saveTimer = useRef<number | undefined>(undefined)

  const showToast = useCallback((msg: string) => {
    window.clearTimeout(toastTimer.current)
    setToast(msg)
    toastTimer.current = window.setTimeout(() => setToast(null), transientToastDwell(msg))
  }, [])

  const { mounted: toastMounted, closing: toastClosing } = useExitAnimation(toast !== null)
  const lastToastRef = useRef('')
  if (toast !== null) lastToastRef.current = toast

  const markEditing = useCallback(() => {
    setStatus('editing')
  }, [])

  const markSaved = useCallback(() => {
    window.clearTimeout(saveTimer.current)
    /* Settle delay on the state tier: the status pill flips editing → saved
       on the same clock as its CSS state transition. */
    saveTimer.current = window.setTimeout(() => setStatus('saved'), DURATION_STATE_MS)
  }, [])

  const persist = useCallback(
    (next: LayoutMap) => {
      persistLayouts(storageKey, next)
      markSaved()
    },
    [storageKey, markSaved],
  )

  const persistCanvasSize = useCallback(
    (size: CanvasSize) => {
      if (!customCanvasSize) return
      persistCanvasSizeToStorage(sizeKey, size)
      markSaved()
    },
    [customCanvasSize, sizeKey, markSaved],
  )

  const applyBoardMetrics = useCallback(
    (map: LayoutMap, size?: CanvasSize) => {
      writeBoardMetrics(
        boardRef.current,
        map,
        customCanvasSize,
        size ?? canvasSizeRef.current,
      )
    },
    [customCanvasSize],
  )

  useEffect(() => {
    applyBoardMetrics(layouts, canvasSize)
  }, [layouts, canvasSize, applyBoardMetrics])

  useEffect(() => {
    if (!customCanvasSize) {
      setShellOverflow(SHELL_OVERFLOW_NONE)
      return
    }
    const shell = shellRef.current
    if (!shell) return

    const update = () => {
      shell.style.setProperty('--canvas-shell-port', `${shell.clientWidth}px`)
      setShellOverflow(canvasShellOverflows(shell))
    }
    update()
    shell.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    if (typeof ResizeObserver === 'undefined') {
      return () => {
        shell.removeEventListener('scroll', update)
        window.removeEventListener('resize', update)
      }
    }
    const observer = new ResizeObserver(update)
    observer.observe(shell)
    const board = boardRef.current
    if (board) observer.observe(board)
    return () => {
      shell.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
      observer.disconnect()
    }
  }, [customCanvasSize, canvasSize, layouts])

  useEffect(() => {
    setLayouts((prev) => {
      let changed = false
      const next = { ...prev }
      for (const r of resources) {
        if (!next[r.id]) {
          next[r.id] = snapRect(r.layout, { min: minSizeForResource(r) })
          changed = true
        }
      }
      return changed ? normalizeStackOrder(next) : prev
    })
  }, [resources])

  const setCanvasSizeSafe = useCallback(
    (next: CanvasSize, opts?: { persist?: boolean; toast?: string }) => {
      const size = snapCanvasSize(next)
      canvasSizeRef.current = size
      setCanvasSize(size)
      setWidthInput(String(size.width))
      setHeightInput(String(size.height))
      applyBoardMetrics(layoutsRef.current, size)
      if (opts?.persist !== false) {
        persistCanvasSize(size)
        markEditing()
      }
      if (opts?.toast) showToast(opts.toast)
    },
    [applyBoardMetrics, persistCanvasSize, markEditing, showToast],
  )

  const boardLimit = useCallback(() => {
    const board = boardRef.current
    if (!board) {
      return {
        width: canvasSizeRef.current.width || 1280,
        height: canvasSizeRef.current.height || 900,
      }
    }
    return { width: board.clientWidth, height: board.clientHeight }
  }, [])

  const editChromeH = canEditLayout ? CARD_CHROME_H : 0

  const applyLayouts = useCallback(
    (next: LayoutMap, opts?: { persist?: boolean }) => {
      const snapped = snapLayoutMap(next, resources, boardLimit(), editChromeH)
      const ordered = normalizeStackOrder(snapped)
      zRef.current = maxZ(ordered)
      layoutsRef.current = ordered
      setLayouts(ordered)
      applyBoardMetrics(ordered)
      if (opts?.persist) persist(ordered)
      return ordered
    },
    [applyBoardMetrics, persist, resources, boardLimit, editChromeH],
  )

  const commitLayout = useCallback(
    (id: string, rect: CardLayout) => {
      const prev = layoutsRef.current[id]
      const resource = resources.find((r) => r.id === id)
      const snapped = snapRect(
        {
          ...rect,
          locked: Boolean(prev?.locked ?? rect.locked),
        },
        {
          min: minSizeForResource(resource),
          limits: boardLimit(),
          chromeH: editChromeH,
        },
      )
      const next = {
        ...layoutsRef.current,
        [id]: snapped,
      }
      layoutsRef.current = next
      setLayouts(next)
      applyBoardMetrics(next)
      return next
    },
    [applyBoardMetrics, boardLimit, resources, editChromeH],
  )

  const bringForward = useCallback(
    (id: string) => {
      const cur = layoutsRef.current[id]
      if (!cur) return cur
      // Bump z; normalizeStackOrder keeps locked cards above unlocked.
      const next = {
        ...layoutsRef.current,
        [id]: { ...cur, z: zRef.current + 1 },
      }
      const ordered = applyLayouts(next)
      return ordered[id]
    },
    [applyLayouts],
  )

  const toggleLock = useCallback(
    (id: string) => {
      const cur = layoutsRef.current[id]
      if (!cur) return
      const locking = !cur.locked
      const next = {
        ...layoutsRef.current,
        [id]: {
          ...cur,
          locked: locking,
          // Newly locked cards rise to the top of the locked stack.
          z: locking ? zRef.current + 1 : cur.z,
        },
      }
      applyLayouts(next, { persist: true })
      markEditing()
      showToast(locking ? 'Locked · stays on top' : 'Unlocked')
    },
    [applyLayouts, markEditing, showToast],
  )

  const reset = () => {
    cancelInteraction()
    setSelected(null)
    const resetMap = normalizeStackOrder(initial)
    layoutsRef.current = resetMap
    setLayouts(resetMap)
    zRef.current = maxZ(resetMap)
    clearCanvasStorage(storageKey, customCanvasSize ? sizeKey : undefined)
    if (customCanvasSize) {
      setCanvasSizeSafe(defaultCanvasSize, { persist: true, toast: 'Layout & canvas reset' })
    } else {
      applyBoardMetrics(resetMap)
      markSaved()
      showToast('Layout reset')
    }
  }

  const fitToContent = () => {
    const { bottom, right } = contentBounds(layoutsRef.current)
    setCanvasSizeSafe(
      {
        width: clamp(right, MIN_CANVAS.width, MAX_CANVAS.width),
        height: clamp(bottom, MIN_CANVAS.height, MAX_CANVAS.height),
      },
      { toast: 'Fitted to content' },
    )
  }

  const applyInputs = () => {
    const w = Number(widthInput)
    const h = Number(heightInput)
    if (!Number.isFinite(w) || !Number.isFinite(h)) {
      showToast('Enter valid width & height')
      return
    }
    setCanvasSizeSafe({ width: w, height: h }, { toast: `Canvas ${Math.round(w)} × ${Math.round(h)}` })
  }

  return {
    canEditLayout,
    boardRef,
    shellRef,
    layouts,
    layoutsRef,
    canvasSize,
    canvasSizeRef,
    selected,
    setSelected,
    status,
    toast,
    toastMounted,
    toastClosing,
    lastToastRef,
    widthInput,
    setWidthInput,
    heightInput,
    setHeightInput,
    shellOverflow,
    themes,
    setThemeFor,
    showToast,
    markEditing,
    markSaved,
    persist,
    persistCanvasSize,
    applyBoardMetrics,
    setCanvasSizeSafe,
    commitLayout,
    bringForward,
    toggleLock,
    reset,
    fitToContent,
    applyInputs,
  }
}
