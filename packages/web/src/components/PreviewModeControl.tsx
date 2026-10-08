import { useCallback, useEffect, useRef, useState } from 'react'
import { isProductApiError, productClient } from '../api'
import type { BookmarkPreviewModeView } from '../api/types'
import { isSelfHostedEdition } from '../lib/edition'
import { previewCover } from '../lib/linkPreview'

type ModeState =
  | { kind: 'loading' }
  | { kind: 'ready'; view: BookmarkPreviewModeView }
  | { kind: 'hidden' }

/**
 * LP-07 bookmark drawer → preview image. Owners and editors choose whether
 * this bookmark shows its page's sharing image (everywhere, public pages
 * included) or none; `none` prevents new requests for this bookmark. The control
 * disappears when link previews are off (404) or the viewer may not change
 * it (403), so it never shows a setting that does nothing.
 */
export function PreviewModeControl({ collectionId, nodeId, disabled, onChanged }: {
  collectionId: string
  nodeId: string
  disabled: boolean
  onChanged?: (view: BookmarkPreviewModeView) => void | Promise<void>
}) {
  const [state, setState] = useState<ModeState>({ kind: 'loading' })
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const generation = useRef(0)

  const load = useCallback(async (signal?: AbortSignal) => {
    if (isSelfHostedEdition()) { setState({ kind: 'hidden' }); return }
    const mine = ++generation.current
    try {
      const view = await productClient.getBookmarkPreviewMode(collectionId, nodeId, { signal, maxRetries: 0 })
      if (mine === generation.current) setState({ kind: 'ready', view })
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      if (mine === generation.current) setState({ kind: 'hidden' })
    }
  }, [collectionId, nodeId])

  useEffect(() => {
    const controller = new AbortController()
    setState({ kind: 'loading' })
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  if (state.kind !== 'ready') return null
  const { view } = state
  const cover = previewCover(view.previewImage)

  const choose = async (mode: BookmarkPreviewModeView['mode']) => {
    if (mode === view.mode || busy) return
    setBusy(true)
    setNotice(null)
    try {
      const next = await productClient.setBookmarkPreviewMode(collectionId, nodeId, mode, view.etag, {
        intentId: productClient.mutationIntentKey(`preview-mode:${collectionId}:${nodeId}:${mode}`, productClient.newCommandId()),
      })
      setState({ kind: 'ready', view: next })
      await onChanged?.(next)
    } catch (error) {
      if (isProductApiError(error) && error.status === 412) {
        setNotice('This bookmark changed elsewhere. The latest setting is shown; try again.')
        await load()
      } else {
        setNotice(isProductApiError(error) ? error.recoveryHint : 'Could not save. Try again.')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="preview-mode-control" data-testid="preview-mode-control">
      <fieldset className="option-group" disabled={disabled || busy}>
        <legend>Preview image</legend>
        {cover && view.mode === 'auto' ? (
          <img
            className="preview-mode-thumb"
            data-testid="preview-mode-thumb"
            src={cover.url}
            width={cover.width}
            height={cover.height}
            alt=""
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
          />
        ) : null}
        <label className="option-row">
          <input
            type="radio"
            name={`preview-mode-${nodeId}`}
            value="auto"
            checked={view.mode === 'auto'}
            onChange={() => void choose('auto')}
          />
          <span>Show the page’s preview image</span>
        </label>
        <label className="option-row">
          <input
            type="radio"
            name={`preview-mode-${nodeId}`}
            value="none"
            checked={view.mode === 'none'}
            onChange={() => void choose('none')}
          />
          <span>Hide for this bookmark</span>
        </label>
        <p className="field-hint">
          Hides this bookmark’s preview in your library and public collections. Already queued fetches may
          finish, and existing image links and cached copies remain accessible.
        </p>
        {notice && <p className="field-error" role="alert">{notice}</p>}
      </fieldset>
    </div>
  )
}
