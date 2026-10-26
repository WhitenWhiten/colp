import { useEffect, useId, useRef, useState } from 'react'
import { isProductApiError, productClient, type CoverMode, type CoverPreferenceView } from '../api'
import { previewCover } from '../lib/linkPreview'

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
export function CoverImageControl({ collectionId, nodeId, kind, mode, revision, image, disabled, onSaved }: {
  collectionId: string
  nodeId: string
  kind: 'bookmark' | 'folder'
  mode: CoverMode
  revision: string
  image: unknown
  disabled: boolean
  onSaved: () => Promise<void>
}) {
  const inputId = useId()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [saved, setSaved] = useState<CoverPreferenceView | null>(null)
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const operation = useRef<Operation | null>(null)
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
      setNotice('Cover updated')
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
        setError(isProductApiError(cause) ? cause.recoveryHint : 'Could not update this cover. Try again.')
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
    <section className="field cover-image-control" aria-labelledby={`${inputId}-label`} aria-busy={busy}>
      <label id={`${inputId}-label`} htmlFor={`${inputId}-mode`}>Gallery cover</label>
      {cover && currentMode !== 'none' && cover.url !== failedUrl && (
        <img className="cover-image-preview" src={cover.url} width={cover.width} height={cover.height}
          alt="Current gallery cover" referrerPolicy="no-referrer" onError={() => setFailedUrl(cover.url)} />
      )}
      <select id={`${inputId}-mode`} value={currentMode} disabled={disabled || busy}
        onChange={event => choose(event.target.value as CoverMode)}>
        <option value="auto">{kind === 'folder' ? 'Automatic mosaic' : 'Website image'}</option>
        <option value="custom" disabled>Custom image</option>
        <option value="none">No cover</option>
      </select>
      <label htmlFor={inputId}>Upload cover</label>
      <input id={inputId} type="file" accept={ACCEPT} disabled={disabled || busy}
        aria-describedby={`${inputId}-hint`} onChange={event => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) choose('custom', file)
        }} />
      <p className="field-hint" id={`${inputId}-hint`}>PNG, JPEG or WebP, up to 2 MiB. Changes save immediately.</p>
      {notice && <p className="field-hint" role="status">{notice}</p>}
      {error && <p className="field-error" role="alert">{error}</p>}
      {error && operation.current && <button type="button" className="btn btn-ghost btn-sm" disabled={disabled || busy}
        onClick={() => { if (operation.current) void run(operation.current) }}>Retry cover update</button>}
    </section>
  )
}
