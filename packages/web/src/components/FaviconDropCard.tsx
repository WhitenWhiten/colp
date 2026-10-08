import { Icon } from './Icon'

/** Server-enforced favicon allow-list (mirrors the editor's existing input). */
export const FAVICON_ACCEPT = 'image/png,image/jpeg,image/webp,image/x-icon,image/vnd.microsoft.icon,.ico'

/**
 * FE-09: the generic upload card that replaced the native file input. The
 * `.file-drop-card` label owns the click target, the input stays in the DOM
 * (visually hidden, still focusable/disabled) so keyboard and AT users keep
 * the native control, and the preview slot shows the current object URL.
 */
export function FaviconDropCard({
  inputId,
  labelId,
  currentIconUrl,
  disabled,
  onPick,
  onRemove,
  removeDisabled = disabled,
}: {
  inputId: string
  /** Ties the card's accessible name to the visible "Favicon" label. */
  labelId: string
  /** Uploaded product favicon object URL; null falls back to the file glyph. */
  currentIconUrl: string | null
  disabled?: boolean
  onPick: (file: File | undefined) => void
  onRemove?: () => void
  removeDisabled?: boolean
}) {
  return (
    <div className="field">
      <label id={labelId}>Favicon</label>
      <label className="file-drop-card" aria-labelledby={labelId}>
        <input
          id={inputId}
          type="file"
          accept={FAVICON_ACCEPT}
          disabled={disabled}
          onChange={(event) => {
            onPick(event.currentTarget.files?.[0])
            event.currentTarget.value = ''
          }}
        />
        <span className="file-drop-card-preview" aria-hidden data-testid="favicon-drop-preview">
          {currentIconUrl
            ? <img src={currentIconUrl} alt="" width={20} height={20} />
            : <Icon name="file" />}
        </span>
        <span className="file-drop-card-copy" data-testid="favicon-drop-copy">
          <strong>{currentIconUrl ? 'Replace favicon' : 'Upload favicon'}</strong>
          <small>PNG, JPEG, WebP or ICO</small>
        </span>
      </label>
      {currentIconUrl && onRemove && (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={removeDisabled}
          onClick={onRemove}
        >
          Remove favicon
        </button>
      )}
    </div>
  )
}
