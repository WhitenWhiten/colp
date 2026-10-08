import {
  CANVAS_COLORS,
  CANVAS_FINISHES,
  CANVAS_FITS,
  type CanvasBackgroundSettings,
} from '../../lib/canvasBackground'
import { BOARD_GRID, MIN_CANVAS, MAX_CANVAS, SIZE_PRESETS, type CanvasSize } from './geometry'
import { Icon } from '../Icon'

type Props = {
  status: 'saved' | 'editing'
  customCanvasSize: boolean
  canvasSize: CanvasSize
  widthInput: string
  heightInput: string
  onWidthInput: (value: string) => void
  onHeightInput: (value: string) => void
  onApplyInputs: () => void
  onFitToContent: () => void
  onSetCanvasSize: (next: CanvasSize, opts?: { persist?: boolean; toast?: string }) => void
  onReset: () => void
  backgroundCustomizable: boolean
  backgroundPanelOpen: boolean
  onToggleBackgroundPanel: () => void
  onCloseBackgroundPanel: () => void
  backgroundPanelMounted: boolean
  backgroundPanelClosing: boolean
  backgroundInputId: string
  background: CanvasBackgroundSettings
  backgroundBusy: boolean
  onUpdateBackground: (patch: Partial<CanvasBackgroundSettings>) => void
  onUploadBackground: (file: File | undefined) => void
  onRemoveBackgroundImage: () => void
}

export function CanvasToolbar({
  status,
  customCanvasSize,
  canvasSize,
  widthInput,
  heightInput,
  onWidthInput,
  onHeightInput,
  onApplyInputs,
  onFitToContent,
  onSetCanvasSize,
  onReset,
  backgroundCustomizable,
  backgroundPanelOpen,
  onToggleBackgroundPanel,
  onCloseBackgroundPanel,
  backgroundPanelMounted,
  backgroundPanelClosing,
  backgroundInputId,
  background,
  backgroundBusy,
  onUpdateBackground,
  onUploadBackground,
  onRemoveBackgroundImage,
}: Props) {
  const activePreset = SIZE_PRESETS.find(
    (p) =>
      customCanvasSize &&
      p.size.width === canvasSize.width &&
      p.size.height === canvasSize.height,
  )?.id

  return (
    <div className="canvas-toolbar">
      <div className="canvas-toolbar-inner canvas-toolbar-inner--wrap">
        <div className="row row--gapped">
          <span className={`save-status ${status === 'editing' ? 'is-editing' : ''}`}>
            {status === 'editing' ? 'Editing' : 'Saved locally'}
          </span>
          {customCanvasSize ? (
            <span className="meta canvas-size-readout">
              Canvas {canvasSize.width} × {canvasSize.height}px
            </span>
          ) : (
            <span className="meta">
              Drag · resize · right-click color · × remove
            </span>
          )}
        </div>

        <div className="row row--tight">
          {customCanvasSize && (
            <>
              <div className="view-switch canvas-presets" role="group" aria-label="Canvas presets">
                {SIZE_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    aria-pressed={activePreset === p.id}
                    onClick={() =>
                      onSetCanvasSize(p.size, {
                        toast: `${p.label} · ${p.size.width}×${p.size.height}`,
                      })
                    }
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <div className="canvas-size-fields">
                <label>
                  <span className="visually-hidden">Width</span>
                  <input
                    type="number"
                    min={MIN_CANVAS.width}
                    max={MAX_CANVAS.width}
                    step={16}
                    value={widthInput}
                    onChange={(e) => onWidthInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') onApplyInputs()
                    }}
                    aria-label="Canvas width in pixels"
                  />
                  <span>W</span>
                </label>
                <span className="meta" aria-hidden>
                  ×
                </span>
                <label>
                  <span className="visually-hidden">Height</span>
                  <input
                    type="number"
                    min={MIN_CANVAS.height}
                    max={MAX_CANVAS.height}
                    step={16}
                    value={heightInput}
                    onChange={(e) => onHeightInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') onApplyInputs()
                    }}
                    aria-label="Canvas height in pixels"
                  />
                  <span>H</span>
                </label>
                <button type="button" className="btn btn-secondary btn-sm" onClick={onApplyInputs}>
                  Apply
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={onFitToContent}>
                  Fit content
                </button>
              </div>
            </>
          )}
          {backgroundCustomizable && (
            <button
              type="button"
              className={`btn btn-secondary btn-sm ${backgroundPanelOpen ? 'is-active' : ''}`}
              aria-expanded={backgroundPanelOpen}
              aria-controls={`${backgroundInputId}-panel`}
              onClick={onToggleBackgroundPanel}
            >
              Background
            </button>
          )}
          <button type="button" className="btn btn-secondary btn-sm" onClick={onReset}>
            Reset
          </button>
        </div>
      </div>
      {backgroundCustomizable && backgroundPanelMounted && (
        <div
          id={`${backgroundInputId}-panel`}
          className={`canvas-background-panel${backgroundPanelClosing ? ' is-closing' : ''}`}
          role="region"
          aria-label="Canvas background settings"
          inert={backgroundPanelClosing || undefined}
        >
          <div className="canvas-background-panel-head">
            <div>
              <strong>Canvas background</strong>
              <span>Stored only in this browser</span>
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={onCloseBackgroundPanel}
            >
              Close
            </button>
          </div>

          <div className="canvas-background-layout">
            <section className="canvas-background-section">
              <div className="canvas-background-section-head">
                <span>Source</span>
                <div className="view-switch" role="group" aria-label="Background source">
                  <button
                    type="button"
                    aria-pressed={background.kind === 'color'}
                    onClick={() => onUpdateBackground({ kind: 'color' })}
                  >
                    Color
                  </button>
                  <button
                    type="button"
                    aria-pressed={background.kind === 'image'}
                    onClick={() => onUpdateBackground({ kind: 'image' })}
                  >
                    Image
                  </button>
                </div>
              </div>

              {background.kind === 'color' ? (
                <div className="canvas-bg-color-grid" role="group" aria-label="Canvas colors">
                  {CANVAS_COLORS.map((color) => (
                    <button
                      key={color.id}
                      type="button"
                      aria-label={color.label}
                      aria-pressed={background.colorId === color.id}
                      title={color.label}
                      onClick={() =>
                        onUpdateBackground({ kind: 'color', colorId: color.id })
                      }
                    >
                      <i className="canvas-bg-swatch" style={{ ['--swatch' as string]: color.value }} aria-hidden />
                      <span>{color.label}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="canvas-bg-upload-area">
                  <div className="canvas-bg-file-row">
                    <label className="btn btn-secondary btn-sm canvas-bg-upload" htmlFor={`${backgroundInputId}-file`}>
                      {backgroundBusy ? 'Saving…' : background.imageName ? 'Replace image' : 'Upload image'}
                    </label>
                    <input
                      id={`${backgroundInputId}-file`}
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/avif,image/gif"
                      disabled={backgroundBusy}
                      onChange={(event) => {
                        onUploadBackground(event.currentTarget.files?.[0])
                        event.currentTarget.value = ''
                      }}
                    />
                    {background.imageName && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={backgroundBusy}
                        onClick={() => onRemoveBackgroundImage()}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                  <p className="meta canvas-bg-file-name">
                    {background.imageName || 'PNG, JPEG, WebP, AVIF or GIF. Maximum 20 MB.'}
                  </p>
                </div>
              )}
            </section>

            {background.kind === 'image' && (
              <>
                <section className="canvas-background-section">
                  <div className="canvas-background-section-head">
                    <span>Image display</span>
                  </div>
                  <div className="canvas-bg-option-grid">
                    {CANVAS_FITS.map((fit) => (
                      <button
                        key={fit.id}
                        type="button"
                        aria-pressed={background.fit === fit.id}
                        onClick={() => onUpdateBackground({ fit: fit.id })}
                      >
                        <Icon name={fit.id === 'tile' ? 'collection' : `fit-${fit.id}`} className="canvas-bg-fit-icon" />
                        <span><strong>{fit.label}</strong><small>{fit.note}</small></span>
                      </button>
                    ))}
                  </div>
                </section>

                <section className="canvas-background-section">
                  <div className="canvas-background-section-head">
                    <span>Image finish</span>
                  </div>
                  <div className="canvas-bg-option-grid">
                    {CANVAS_FINISHES.map((finish) => (
                      <button
                        key={finish.id}
                        type="button"
                        aria-pressed={background.finish === finish.id}
                        onClick={() => onUpdateBackground({ finish: finish.id })}
                      >
                        <i className={`canvas-bg-finish-icon ${finish.iconClass}`} aria-hidden />
                        <span><strong>{finish.label}</strong><small>{finish.note}</small></span>
                      </button>
                    ))}
                  </div>
                </section>
              </>
            )}
          </div>
        </div>
      )}
      {customCanvasSize && (
        <p className="meta canvas-size-hint">
          {BOARD_GRID}px grid · cards snap on move &amp; resize · drag the board’s bottom-right
          handle to resize the canvas · height grows if content needs more room
        </p>
      )}
    </div>
  )
}
