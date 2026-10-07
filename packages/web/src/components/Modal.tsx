import {
  useEffect,
  useId,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react'
import { useBodyScrollLock } from '../lib/useBodyScrollLock'
import { useExitAnimation } from '../lib/useExitAnimation'
import { useFocusTrap, type InitialFocusTarget } from '../lib/useFocusTrap'
import { Icon } from './Icon'

const openModals: object[] = []
const stackListeners = new Set<() => void>()

function notifyModalStack() {
  for (const listener of stackListeners) listener()
}

function pushOpenModal(id: object) {
  openModals.push(id)
  notifyModalStack()
}

function popOpenModal(id: object) {
  const index = openModals.lastIndexOf(id)
  if (index >= 0) openModals.splice(index, 1)
  notifyModalStack()
}

function isTopOpenModal(id: object) {
  return openModals.at(-1) === id
}

/** Open instances form a stack; Esc and the focus trap apply only to the top. */
function useModalStack(open: boolean): boolean {
  const idRef = useRef<object>(null)
  if (!idRef.current) idRef.current = {}
  const id = idRef.current
  const [isTop, setIsTop] = useState(false)

  useEffect(() => {
    if (!open) {
      setIsTop(false)
      return
    }
    pushOpenModal(id)
    const sync = () => setIsTop(isTopOpenModal(id))
    sync()
    stackListeners.add(sync)
    return () => {
      stackListeners.delete(sync)
      popOpenModal(id)
    }
  }, [open, id])

  return isTop
}

const SHEET_VIEWPORT_QUERY = '(max-width: 639px)'
const SHEET_DISMISS_PX = 80
const SHEET_DISMISS_RATIO = 0.25
/** Fallback grabber band when the panel has no layout (≈ 3rem at 16px). */
const SHEET_GRABBER_BAND_PX = 48
const SHEET_DRAGGING_CLASS = 'is-sheet-dragging'

function isMobileSheetViewport(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(SHEET_VIEWPORT_QUERY).matches
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function sheetDismissThreshold(panel: HTMLElement): number {
  const height = panel.getBoundingClientRect().height
  if (!(height > 0)) return SHEET_DISMISS_PX
  return Math.min(SHEET_DISMISS_PX, height * SHEET_DISMISS_RATIO)
}

function isSheetGrabberOrigin(event: PointerEvent, panel: HTMLElement): boolean {
  const target = event.target
  if (!(target instanceof Element) || !panel.contains(target)) return false
  // Scrolling the body must not dismiss; the grabber + header are the handle.
  if (target.closest('.modal-body')) return false
  if (target.closest('.modal-header')) return true
  const rect = panel.getBoundingClientRect()
  const header = panel.querySelector('.modal-header')
  const headerRect = header?.getBoundingClientRect()
  const band = headerRect && headerRect.height > 0
    ? headerRect.bottom - rect.top
    : SHEET_GRABBER_BAND_PX
  if (!(rect.height > 0)) return target === panel
  return event.clientY - rect.top <= band
}

function clearSheetDrag(panel: HTMLElement) {
  panel.classList.remove(SHEET_DRAGGING_CLASS)
  panel.style.removeProperty('--modal-sheet-drag')
}

/**
 * Default-chrome phone sheet: grabber-band swipe-down closes. Follow-the-finger
 * is skipped under reduced motion; the threshold still dismisses on pointerup.
 */
function useDefaultChromeSheetDismiss(
  enabled: boolean,
  panelRef: RefObject<HTMLDivElement | null>,
  onClose: () => void,
) {
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!enabled) return
    const panel = panelRef.current
    if (!panel) return

    let pointerId: number | null = null
    let startY = 0
    let deltaY = 0

    const stopDocument = () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      document.removeEventListener('pointercancel', onCancel)
    }

    const endSession = () => {
      pointerId = null
      deltaY = 0
      stopDocument()
      clearSheetDrag(panel)
    }

    const onMove = (event: PointerEvent) => {
      if (pointerId === null || event.pointerId !== pointerId) return
      deltaY = Math.max(0, event.clientY - startY)
      if (deltaY === 0 || prefersReducedMotion()) return
      panel.classList.add(SHEET_DRAGGING_CLASS)
      panel.style.setProperty('--modal-sheet-drag', `${deltaY}px`)
    }

    const onUp = (event: PointerEvent) => {
      if (pointerId === null || event.pointerId !== pointerId) return
      const shouldClose = deltaY >= sheetDismissThreshold(panel)
      endSession()
      if (shouldClose) onCloseRef.current()
    }

    const onCancel = (event: PointerEvent) => {
      if (pointerId === null || event.pointerId !== pointerId) return
      endSession()
    }

    const onDown = (event: PointerEvent) => {
      if (pointerId !== null || event.button !== 0) return
      if (!isMobileSheetViewport()) return
      if (panel.classList.contains('is-closing')) return
      if (!isSheetGrabberOrigin(event, panel)) return
      pointerId = event.pointerId
      startY = event.clientY
      deltaY = 0
      document.addEventListener('pointermove', onMove)
      document.addEventListener('pointerup', onUp)
      document.addEventListener('pointercancel', onCancel)
    }

    panel.addEventListener('pointerdown', onDown)
    return () => {
      panel.removeEventListener('pointerdown', onDown)
      endSession()
    }
  }, [enabled, panelRef])
}

type ModalSize = 'sm' | 'md' | 'lg'
type ModalTone = 'default' | 'danger'
type ModalChrome = 'default' | 'bare' | 'inline' | 'sheet'

type ModalProps = {
  open: boolean
  onClose: () => void
  /** Accessible name for the dialog */
  label: string
  /** idrefs for aria-labelledby; takes precedence over `label`/`title` naming. */
  labelledBy?: string
  /**
   * Visible heading in the default header. Unused for `bare` / `inline`
   * (those callers own their own chrome).
   */
  title?: ReactNode
  /** Panel width step: sm 24rem / md 36rem / lg 52rem. Default chrome only. */
  size?: ModalSize
  /** Semantic emphasis (danger: destructive confirmations). Default chrome only. */
  tone?: ModalTone
  /** Focus target on open (selector scoped to the panel, or a ref).
      Danger tone defaults to the first non-destructive action in the body
      so a destructive confirm never starts focused. */
  initialFocus?: InitialFocusTarget
  /**
   * `default` — overlay + header + close.
   * `bare` — overlay + trap + Esc + backdrop; children are the full panel
   *   (command palette).
   * `inline` — no overlay, no scroll lock (in-place picker / hover popover).
   * `sheet` — sibling veil + panel; the panel is the role="dialog" element
   *   and owns its own head/foot chrome (side drawer / bottom sheet).
   */
  chrome?: ModalChrome
  overlayClassName?: string
  overlayProps?: Omit<HTMLAttributes<HTMLDivElement>, 'role' | 'className' | 'children' | 'onClick'>
    & { [key: `data-${string}`]: string | undefined }
  panelClassName?: string
  panelRef?: Ref<HTMLDivElement>
  panelProps?: Omit<HTMLAttributes<HTMLDivElement>, 'role' | 'className' | 'children'>
    & { [key: `data-${string}`]: string | undefined }
  /** Default true. Hover popovers pass false so opening does not steal focus. */
  trapFocus?: boolean
  /**
   * Exit-beat length in ms; must match the tier of the panel's .is-closing
   * CSS. Defaults to the state tier (EXIT_DURATION_MS); hover-grade inline
   * popovers pass EXIT_DURATION_FAST_MS.
   */
  exitDuration?: number
  children: ReactNode
}

/**
 * Shared modal base: overlay + panel with role="dialog" and aria-modal,
 * focus trapped inside the panel, Esc to close, backdrop click to close.
 * Overlay, panel, header, close button and focus ring are owned by this
 * component (CSS in<|close|>lays.css base layer); callers only configure the
 * semantic size/tone/title props. `bare` / `inline` reuse trap + Esc without
 * forcing header chrome.
 */
export function Modal({
  open,
  onClose,
  label,
  labelledBy,
  title,
  size = 'md',
  tone = 'default',
  initialFocus,
  chrome = 'default',
  overlayClassName,
  overlayProps,
  panelClassName,
  panelRef,
  panelProps,
  trapFocus = true,
  exitDuration,
  children,
}: ModalProps) {
  const isTop = useModalStack(open)
  const { mounted, closing } = useExitAnimation(open, exitDuration)
  const trapRef = useFocusTrap(
    open && trapFocus && isTop,
    initialFocus ?? (chrome === 'default' && tone === 'danger' ? '.modal-body button:not(.btn-danger)' : undefined),
  )
  const titleId = useId()
  useBodyScrollLock(open && chrome !== 'inline')

  // While the exit animation plays, keep painting the last open frame —
  // callers may swap/clear their children the moment they flip `open` off
  // (e.g. Settings drops its URL param), which would flash new content
  // under the fade.
  const lastChildrenRef = useRef(children)
  if (open) lastChildrenRef.current = children
  const content = closing ? lastChildrenRef.current : children
  const panelNodeRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open || !isTop) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose, isTop])

  useDefaultChromeSheetDismiss(
    mounted && chrome === 'default' && open && !closing && isTop,
    panelNodeRef,
    onClose,
  )

  if (!mounted) return null

  const closingClass = closing ? ' is-closing' : ''
  // While leaving, the dialog is inert: pointer-events CSS only blocks the
  // mouse — Tab could still reach the dying controls, and a hidden-but-
  // present aria-modal dialog confuses screen readers. `inert` removes it
  // from both the tab order and the accessibility tree for the exit beat.
  const closingInert = closing || undefined

  const setDialogRef = (node: HTMLDivElement | null) => {
    trapRef.current = node
    panelNodeRef.current = node
    if (typeof panelRef === 'function') panelRef(node)
    else if (panelRef) panelRef.current = node
  }

  if (chrome === 'inline') {
    return (
      <div
        ref={setDialogRef}
        role="dialog"
        aria-label={label}
        className={panelClassName ? `${panelClassName}${closingClass}` : closing ? 'is-closing' : undefined}
        inert={closingInert}
        data-chrome="inline"
        {...panelProps}
      >
        {content}
      </div>
    )
  }

  if (chrome === 'bare') {
    return (
      // eslint-disable-next-line jsx-a11y/click-events-have-key-events -- backdrop click-to-close; the keyboard equivalent is the Esc handler on document above
      <div
        ref={setDialogRef}
        className={`${overlayClassName ?? 'modal-overlay'}${closingClass}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-label={labelledBy ? undefined : label}
        inert={closingInert}
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose()
        }}
        {...overlayProps}
      >
        {content}
      </div>
    )
  }

  if (chrome === 'sheet') {
    /* The veil and the panel are siblings: the panel carries role="dialog"
       (aria-modal marks everything else — veil included — inert to AT) and
       keeps its own head/foot chrome. The veil is a plain backdrop, so any
       click on it is a backdrop click — no target guard needed. */
    return (
      <>
        {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- backdrop click-to-close; the keyboard equivalent is the Esc handler on document above */}
        <div
          className={`${overlayClassName ?? 'modal-overlay'}${closingClass}`}
          inert={closingInert}
          onClick={onClose}
          {...overlayProps}
        />
        <div
          ref={setDialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={labelledBy}
          aria-label={labelledBy ? undefined : label}
          className={`${panelClassName ?? 'modal-panel rise'}${closingClass}`}
          inert={closingInert}
          data-chrome="sheet"
          {...panelProps}
        >
          {content}
        </div>
      </>
    )
  }

  const sizeClass = size === 'md' ? '' : ` modal-panel--${size}`
  const toneClass = tone === 'default' ? '' : ` modal-panel--${tone}`

  /* aria-labelledby wins over aria-label in name computation — pointing it at
     an empty h2 (title omitted) would mask `label` with an empty name. */
  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events -- backdrop click-to-close; the keyboard equivalent is the Esc handler on document above
    <div
      className={`${overlayClassName ?? 'modal-overlay'}${closingClass}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy ?? (title ? titleId : undefined)}
      aria-label={labelledBy ? undefined : label}
      inert={closingInert}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      {...overlayProps}
    >
      <div ref={setDialogRef} data-testid="modal-panel" data-chrome="default" className={`modal-panel rise${sizeClass}${toneClass}${panelClassName ? ` ${panelClassName}` : ''}`}>
        <header className="modal-header">
          <h2 id={titleId} className="modal-title">
            {title}
          </h2>
          <button type="button" className="modal-close" aria-label="Close dialog" onClick={onClose}>
            <Icon name="cross" />
          </button>
        </header>
        <div className="modal-body" data-testid="modal-body">{content}</div>
      </div>
    </div>
  )
}
