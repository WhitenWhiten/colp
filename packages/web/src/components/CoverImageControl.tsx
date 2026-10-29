import { useEffect, useId, useRef, useState } from 'react'
import { isProductApiError, productClient, type CoverMode, type CoverPreferenceView } from '../api'
import { previewCover, type PreviewCover } from '../lib/linkPreview'
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
export function CoverImageControl({ collectionId, nodeId, kind, mode, revision, image, mosaic = [], disabled, onSaved, onSuccess }: {
  collectionId: string
  nodeId: string
  kind: 'bookmark' | 'folder'
  mode: CoverMode
  revision: string
  image: unknown
  /** A folder's automatic covers: the first ones filed inside, as its gallery card shows them. */
  mosaic?: readonly PreviewCover[]
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

  const showImage = cover !== null && currentMode !== 'none' && cover.url !== failedUrl
  const tiles = kind === 'folder' && currentMode === 'auto' && !showImage ? mosaic.slice(0, 4) : []
  const empty = currentMode === 'none' ? 'No cover'
    : kind === 'folder' ? 'Made from the bookmarks inside' : 'No website image yet'

  /* The preview is the gallery card's cover at the card's width, so the
     owner sees what the gallery will show; it is also the upload target. */
  return (
    <section className="cover-field" aria-labelledby={`${inputId}-label`} aria-busy={busy}>
      <label id={`${inputId}-label`} className="cover-field-label">Gallery cover</label>
      <div className="cover-field-body">
        <label className="cover-field-preview" data-testid="cover-preview" htmlFor={inputId} data-empty={showImage || tiles.length > 0 ? undefined : ''}>
          <input ref={fileInput} id={inputId} type="file" accept={ACCEPT} disabled={disabled || busy}
            aria-labelledby={`${inputId}-label`}
            aria-describedby={`${inputId}-hint`} onChange={event => {
              const file = event.currentTarget.files?.[0]
              event.currentTarget.value = ''
              if (file) choose('custom', file)
            }} />
          {showImage
            ? <img src={cover.url} width={cover.width} height={cover.height} alt="" referrerPolicy="no-referrer" onError={() => setFailedUrl(cover.url)} />
            : tiles.length > 0
              ? <span className="folder-gallery-cover" data-count={tiles.length}>
                {tiles.map(tile => <img key={tile.url} src={tile.url} width={tile.width} height={tile.height} alt="" referrerPolicy="no-referrer" />)}
              </span>
              : <span className="cover-field-empty"><Icon name={kind === 'folder' ? 'masonry' : 'file'} />{empty}</span>}
        </label>
        <div className="cover-field-side">
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
          </fieldset>
          <label className="btn btn-secondary btn-sm cover-field-upload" htmlFor={inputId} aria-hidden
            data-disabled={disabled || busy ? '' : undefined}>
            <Icon name="arrow-up" />{currentMode === 'custom' ? 'Replace image' : 'Upload image'}
          </label>
          <p className="cover-field-hint" id={`${inputId}-hint`}>PNG, JPEG, WebP · 2 MB max</p>
        </div>
      </div>
      {notice && <p className="meta" role="status">{notice}</p>}
      {error && <p className="field-error" role="alert">{error}</p>}
      {error && operation.current && <button type="button" className="btn btn-secondary btn-sm cover-field-retry"
        onClick={() => { if (operation.current) void run(operation.current) }}>Retry</button>}
    </section>
  )
}
