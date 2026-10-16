import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { isProductApiError, privateSessionIdentity, productClient, subscribeSession, type FolderShareView } from '../../api'
import { useToast } from '../../components/AppToast'
import { CopyField } from '../../components/CopyField'
import { LoadingState } from '../../components/EmptyState'
import { Modal } from '../../components/Modal'

export function FolderShareDialog({ collectionId, nodeId, title, onClose, onChanged }: {
  collectionId: string; nodeId: string; title: string; onClose: () => void; onChanged: () => Promise<void>
}) {
  const identity = useSyncExternalStore(subscribeSession, privateSessionIdentity, privateSessionIdentity)
  const actor = useRef(identity)
  const controller = useRef<AbortController | null>(null)
  const [share, setShare] = useState<FolderShareView | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [busy, setBusy] = useState(false)
  const { success, error } = useToast()
  const current = useCallback(() => actor.current === privateSessionIdentity() && !controller.current?.signal.aborted, [])
  const reload = useCallback(async () => {
    controller.current?.abort(); const active = new AbortController(); controller.current = active
    setState('loading')
    try {
      const response = await productClient.getFolderShare(collectionId, nodeId, { signal: active.signal, maxRetries: 0 })
      if (!current() || active.signal.aborted) return
      setShare(response.share); setState('ready')
    } catch (cause) {
      if (!current() || active.signal.aborted) return
      error(isProductApiError(cause) ? cause.recoveryHint : 'Could not load this folder’s share link. Try again.')
      setState('error')
    }
  }, [collectionId, nodeId, current, error])
  useEffect(() => {
    if (actor.current !== identity) { onClose(); return }
    void reload()
    return () => controller.current?.abort()
  }, [identity, onClose, reload])

  const change = async (action: 'share' | 'stop') => {
    if (busy || !current()) return
    setBusy(true)
    try {
      const options = { intentId: productClient.mutationIntentKey(`folder-share:${collectionId}:${nodeId}`, action), signal: controller.current?.signal }
      const response = action === 'share' ? await productClient.putFolderShare(collectionId, nodeId, options)
        : await productClient.deleteFolderShare(collectionId, nodeId, options)
      if (!current()) return
      setShare(response.share)
      success(action === 'share' ? 'Folder shared by link' : 'Sharing stopped. The link no longer works.')
      await onChanged()
    } catch (cause) {
      if (current()) error(isProductApiError(cause) ? cause.recoveryHint : 'Could not change sharing. Try again.')
    } finally { if (current()) setBusy(false) }
  }
  if (identity !== actor.current) return null
  const url = share ? `${window.location.origin}/c/${encodeURIComponent(share.slug)}` : null
  return <Modal open onClose={() => { if (!busy) onClose() }} title={`Share ${title}`} label="Share folder">
    <div className="edit-form" aria-busy={busy || state === 'loading'}>
      <p className="m-0">Anyone with the link can view this folder.</p>
      {state === 'loading' ? <LoadingState label="Loading share link…" /> : state === 'error'
        ? <button type="button" className="btn btn-secondary" onClick={() => void reload()}>Try again</button>
        : url ? <>
          <CopyField label="Folder link" value={url} onCopied={() => success('Link copied')}
            onCopyFailed={() => error('Couldn’t copy the link. Select and copy it.')} />
          <div className="row-end">
            <a href={url} target="_blank" rel="noreferrer" className="btn btn-secondary btn-sm">Open link</a>
            <button type="button" className="btn btn-danger btn-sm" disabled={busy} onClick={() => void change('stop')}>Stop sharing</button>
          </div>
        </> : <>
          <p className="field-hint m-0">This folder has no share link yet. Your library stays private.</p>
          <div className="row-end"><button type="button" className="btn btn-primary" disabled={busy} onClick={() => void change('share')}>Create link</button></div>
        </>}
    </div>
  </Modal>
}
