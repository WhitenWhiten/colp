import { useCallback, useRef, type CSSProperties } from 'react'
import { Icon } from '../Icon'
import { defaultThemeForType } from '../../lib/deskThemes'
import type { Resource } from '../../types/catalog'
import { SourceCard } from '../SourceCard'
import { BOARD_GRID, DEFAULT_CANVAS, type CanvasSize } from './geometry'
import { useCanvasBoard, type CanvasBoardThemeProps } from './useCanvasBoard'
import { useCanvasBackground } from './useCanvasBackground'
import { useCanvasPointer, useCanvasResize } from './interaction'
import { CanvasToolbar } from './CanvasToolbar'

export { BOARD_GRID }

type CanvasBoardBaseProps = {
  resources: Resource[]
  storageKey: string
  /** Toolbar for canvas size / reset. */
  showEditChrome?: boolean
  /**
   * When false: cards cannot be dragged/resized and the top drag bar is hidden.
   * Defaults to the same as showEditChrome when omitted.
   */
  layoutEditable?: boolean
  /** Enable custom canvas width/height (presets, inputs, corner drag). */
  customCanvasSize?: boolean
  /** Enable local color and image backgrounds for this canvas. */
  backgroundCustomizable?: boolean
  defaultCanvasSize?: CanvasSize
  /** When provided (and layout is editable), each card can be removed from the board. */
  onRemoveResource?: (id: string) => void
}

export type CanvasBoardProps = CanvasBoardBaseProps & CanvasBoardThemeProps

export function CanvasBoard({
  resources,
  storageKey,
  showEditChrome = true,
  layoutEditable,
  customCanvasSize = false,
  backgroundCustomizable = false,
  defaultCanvasSize = DEFAULT_CANVAS,
  onRemoveResource,
  ...themeControl
}: CanvasBoardProps) {
  const cancelRef = useRef<() => void>(() => {})
  const cancelInteraction = useCallback(() => {
    cancelRef.current()
  }, [])

  const board = useCanvasBoard({
    resources,
    storageKey,
    showEditChrome,
    layoutEditable,
    customCanvasSize,
    defaultCanvasSize,
    cancelInteraction,
    ...themeControl,
  })

  const background = useCanvasBackground({
    enabled: backgroundCustomizable,
    storageKey,
    markEditing: board.markEditing,
    markSaved: board.markSaved,
    showToast: board.showToast,
  })

  const pointer = useCanvasPointer({
    layoutsRef: board.layoutsRef,
    shellRef: board.shellRef,
    commitLayout: board.commitLayout,
    persist: board.persist,
    applyBoardMetrics: board.applyBoardMetrics,
    bringForward: board.bringForward,
    markEditing: board.markEditing,
    showToast: board.showToast,
    setSelected: board.setSelected,
  })
  cancelRef.current = pointer.cancel

  const { beginCanvasResize } = useCanvasResize({
    customCanvasSize,
    canvasSizeRef: board.canvasSizeRef,
    activeRef: pointer.activeRef,
    canvasResizeRef: pointer.canvasResizeRef,
    cleanupRef: pointer.cleanupRef,
    endInteraction: pointer.endInteraction,
    markEditing: board.markEditing,
    persistCanvasSize: board.persistCanvasSize,
    setCanvasSizeSafe: board.setCanvasSizeSafe,
    showToast: board.showToast,
  })

  const { canEditLayout } = board

  return (
    <>
      {showEditChrome && (
        <CanvasToolbar
          status={board.status}
          customCanvasSize={customCanvasSize}
          canvasSize={board.canvasSize}
          widthInput={board.widthInput}
          heightInput={board.heightInput}
          onWidthInput={board.setWidthInput}
          onHeightInput={board.setHeightInput}
          onApplyInputs={board.applyInputs}
          onFitToContent={board.fitToContent}
          onSetCanvasSize={board.setCanvasSizeSafe}
          onReset={board.reset}
          backgroundCustomizable={backgroundCustomizable}
          backgroundPanelOpen={background.backgroundPanelOpen}
          onToggleBackgroundPanel={() =>
            background.setBackgroundPanelOpen((open) => !open)
          }
          onCloseBackgroundPanel={() => background.setBackgroundPanelOpen(false)}
          backgroundPanelMounted={background.backgroundPanelMounted}
          backgroundPanelClosing={background.backgroundPanelClosing}
          backgroundInputId={background.backgroundInputId}
          background={background.background}
          backgroundBusy={background.backgroundBusy}
          onUpdateBackground={background.updateCanvasBackground}
          onUploadBackground={(file) => void background.uploadCanvasBackground(file)}
          onRemoveBackgroundImage={() => void background.removeCanvasBackgroundImage()}
        />
      )}

      <div
        className={[
          'canvas-shell',
          customCanvasSize ? 'canvas-shell--custom' : '',
          board.shellOverflow.start ? 'canvas-shell--overflow-start' : '',
          board.shellOverflow.end ? 'canvas-shell--overflow-end' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        ref={board.shellRef}
      >
        <div className="canvas-shell-align">
          <div
            className={`board ${canEditLayout ? 'board--grid' : ''} ${customCanvasSize ? 'board--custom-size' : ''} ${backgroundCustomizable ? 'board--custom-background' : ''} ${background.background.kind === 'image' && background.backgroundImageUrl ? 'has-image-background' : ''} bg-fit-${background.background.fit}`}
            ref={board.boardRef}
          style={
            {
              ...background.canvasBackgroundStyle,
              ...(canEditLayout ? { '--board-grid': `${BOARD_GRID}px` } : null),
            } as CSSProperties
          }
          role="list"
          aria-label={
            customCanvasSize
              ? canEditLayout
                ? `Editable dashboard canvas on a ${BOARD_GRID} pixel grid, ${board.canvasSize.width} by ${board.canvasSize.height} pixels`
                : `Dashboard canvas, ${board.canvasSize.width} by ${board.canvasSize.height} pixels`
              : canEditLayout
                ? `Editable resource canvas on a ${BOARD_GRID} pixel grid`
                : 'Resource canvas'
          }
        >
          {backgroundCustomizable && (
            <div className="board-background" aria-hidden>
              <div className="board-background-image" />
              <div className="board-background-veil" />
            </div>
          )}
          {canEditLayout && <div className="board-grid" aria-hidden />}
          {resources.map((r) => {
            const layout = board.layouts[r.id] ?? r.layout
            return (
              <SourceCard
                key={r.id}
                resource={r}
                layout={layout}
                editable={canEditLayout}
                stackLocked={Boolean(layout.locked)}
                selected={canEditLayout ? board.selected === r.id : false}
                moving={canEditLayout && pointer.activeUi?.type === 'move' && pointer.activeUi.id === r.id}
                resizing={canEditLayout && pointer.activeUi?.type === 'resize' && pointer.activeUi.id === r.id}
                themeId={board.themes[r.id] ?? defaultThemeForType(r.type)}
                onSelect={canEditLayout ? () => board.setSelected(r.id) : undefined}
                onToggleLock={canEditLayout ? () => board.toggleLock(r.id) : undefined}
                onRemove={
                  canEditLayout && onRemoveResource
                    ? () => onRemoveResource(r.id)
                    : undefined
                }
                onThemeChange={canEditLayout ? (t) => board.setThemeFor(r.id, t) : undefined}
                onMoveStart={
                  canEditLayout ? (e) => pointer.beginInteraction('move', r.id, e) : undefined
                }
                onResizeStart={
                  canEditLayout ? (e) => pointer.beginInteraction('resize', r.id, e) : undefined
                }
                onMoveKey={canEditLayout ? (e) => pointer.moveWithKeyboard(r.id, e) : undefined}
                onResizeKey={canEditLayout ? (e) => pointer.resizeWithKeyboard(r.id, e) : undefined}
              />
            )
          })}

          {customCanvasSize && canEditLayout && (
            <button
              type="button"
              className="canvas-resize-handle"
              aria-label="Resize canvas. Drag to change width and height."
              onPointerDown={beginCanvasResize}
            >
              <Icon name="resize" />
            </button>
          )}
          </div>
        </div>
        {customCanvasSize && (board.shellOverflow.start || board.shellOverflow.end) ? (
          <p className="canvas-scroll-hint" role="note">
            Scroll or drag to see more of the board
          </p>
        ) : null}
      </div>

      {board.toastMounted && (
        <div className={`canvas-toast${board.toastClosing ? ' is-closing' : ''}`} role="status">
          {board.toastClosing ? board.lastToastRef.current : board.toast}
        </div>
      )}
    </>
  )
}
