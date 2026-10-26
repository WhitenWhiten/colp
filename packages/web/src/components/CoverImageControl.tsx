import { useEffect, useId, useRef, useState } from 'react'
import { isProductApiError, productClient, type CoverMode, type CoverPreferenceView } from '../api'
import { previewCover } from '../lib/linkPreview'
import { Icon } from './Icon'

const MAX_BYTES = 2 * 1024 * 1024
const ACCEPT = 'image/png,image/jpeg,image/webp'
type Operation = {
  mode: CoverMode
  revision: string
  assetId: string | null
  file?: File
  uploadIntent: string
  updateIntent: string
}

/** Immediate cover mutations keep both command identities when the user retries. */
export function CoverImageControl({ collectionId, nodeId, kind, mode, revision, image, disabled, onSaved, onSuccess }: {
  collectionId: string
  nodeId: string
  kind: 'bookmark' | 'folder'
  mode: CoverMode
  revision: string
  image: unknown
  disabled: boolean
  onSaved: () => Promise<void>
  onSuccess?: () => void
}) {
  const inputId = useId()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [saved, setSaved] = useState<CoverPreferenceView | null>(null)
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const operation = useRef<Operation | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const newer = saved !== null && BigInt(saved.revision) > BigInt(revision)
  const currentMode = newer ? saved.mode : mode
  const currentRevision = newer ? saved.revision : revision
  const cover = previewCover(newer ? saved.image : image)

  const run = async (pending: Operation) => {
    if (busy || disabled) return
    operation.current = pending
    setBusy(true)
    setError('')
    setNotice(pending.file && pending.assetId === null ? 'Uploading cover…' : 'Saving cover…')
    try {
      if (pending.file && pending.assetId === null) {
        const uploaded = await productClient.uploadCollectionImage(collectionId, pending.file, { intentId: pending.uploadIntent })
        pending.assetId = uploaded.assetId
      }
      const result = await productClient.updateNodeCover(collectionId, nodeId,
        { mode: pending.mode, assetId: pending.assetId }, pending.revision, { intentId: pending.updateIntent })
      if (!mounted.current) return
      setSaved(result)
      operation.current = null
      setNotice('')
      onSuccess?.()
      await onSaved().catch(() => {
        if (mounted.current) setNotice('Cover updated. Refresh the page to update the gallery.')
      })
    } catch (cause) {
      if (!mounted.current) return
      setNotice('')
      if (isProductApiError(cause) && cause.status === 412) {
        operation.current = null
        setError('This cover changed elsewhere. Review it and try again.')
        await onSaved().catch(() => undefined)
      } else {
        if (isProductApiError(cause) && !cause.sameRequestRetrySafe) operation.current = null
        setError(isProductApiError(cause) ? cause.recoveryHint : 'Could not update this cover.')
      }
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const choose = (next: CoverMode, file?: File) => {
    if (busy || disabled) return
    if (file && (file.size === 0 || file.size > MAX_BYTES || !ACCEPT.split(',').includes(file.type))) {
      operation.current = null
      setError('Choose a PNG, JPEG or WebP image up to 2 MiB.')
      return
    }
    const scope = `cover:${collectionId}:${nodeId}`
    void run({ mode: next, revision: currentRevision, assetId: null, file,
      uploadIntent: productClient.mutationIntentKey(`${scope}:upload`, productClient.newCommandId()),
      updateIntent: productClient.mutationIntentKey(`${scope}:update`, productClient.newCommandId()) })
  }

  return (
    <section className="stack" aria-labelledby={`${inputId}-label`} aria-busy={busy}>
      <div className="field">
        <label id={`${inputId}-label`} htmlFor={inputId}>Gallery cover</label>
        <label className="file-drop-card" htmlFor={inputId} aria-labelledby={`${inputId}-label`}>
          <input ref={fileInput} id={inputId} type="file" accept={ACCEPT} disabled={disabled || busy}
            aria-labelledby={`${inputId}-label`}
            aria-describedby={`${inputId}-hint`} onChange={event => {
              const file = event.currentTarget.files?.[0]
              event.currentTarget.value = ''
              if (file) choose('custom', file)
            }} />
          <span className="file-drop-card-preview" aria-hidden>
            {cover && currentMode !== 'none' && cover.url !== failedUrl
              ? <img src={cover.url} width={20} height={20} alt="" referrerPolicy="no-referrer" onError={() => setFailedUrl(cover.url)} />
              : <Icon name="file" />}
          </span>
          <span className="file-drop-card-copy">
            <strong>{currentMode === 'custom' ? 'Replace cover' : 'Upload cover'}</strong>
            <small id={`${inputId}-hint`}>PNG, JPEG or WebP · Up to 2 MB</small>
          </span>
        </label>
      </div>
      <fieldset className="option-group" disabled={disabled || busy}>
        <legend className="visually-hidden">Cover source</legend>
        <label className="option-row">
          <input type="radio" name={`${inputId}-mode`} value="auto" checked={currentMode === 'auto'} onChange={() => choose('auto')} />
          <span>{kind === 'folder' ? 'Automatic mosaic' : 'Website image'}</span>
        </label>
        {currentMode === 'custom' && (
          <label className="option-row">
            <input type="radio" name={`${inputId}-mode`} value="custom" checked onChange={() => fileInput.current?.click()} />
            <span>Uploaded image</span>
          </label>
        )}
        <label className="option-row">
          <input type="radio" name={`${inputId}-mode`} value="none" checked={currentMode === 'none'} onChange={() => choose('none')} />
          <span>No cover</span>
        </label>
        {notice && <p className="meta" role="status">{notice}</p>}
        {error && <p className="field-error" role="alert">{error}</p>}
        {error && operation.current && <button type="button" className="btn btn-secondary btn-sm"
          onClick={() => { if (operation.current) void run(operation.current) }}>Retry</button>}
      </fieldset>
    </section>
  )
}
