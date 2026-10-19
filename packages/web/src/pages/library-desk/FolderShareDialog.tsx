import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { isProductApiError, privateSessionIdentity, productClient, subscribeSession, type FolderShareState } from '../../api'
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
  const pendingIntent = useRef<{ action: 'share' | 'stop'; id: string } | null>(null)
  const [sharing, setSharing] = useState<FolderShareState>({ share: null, unavailableReason: null })
  const { share, unavailableReason } = sharing
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
      // A successful read resolves any earlier ambiguous write. The next action is new.
      pendingIntent.current = null
      setSharing(response); setState('ready')
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
      if (pendingIntent.current?.action !== action) pendingIntent.current = { action,
        id: productClient.mutationIntentKey(`folder-share:${collectionId}:${nodeId}:${action}`, productClient.newCommandId()) }
      const options = { intentId: pendingIntent.current.id, signal: controller.current?.signal, maxRetries: 0 }
      const response = action === 'share' ? await productClient.putFolderShare(collectionId, nodeId, options)
        : await productClient.deleteFolderShare(collectionId, nodeId, options)
      if (!current()) return
      pendingIntent.current = null
      setSharing(response)
      success(action === 'share'
        ? response.unavailableReason ? 'The share link is currently unavailable.' : 'Folder shared by link'
        : 'Sharing stopped. The link no longer works.')
      await onChanged()
    } catch (cause) {
      if (current()) error(isProductApiError(cause) ? cause.recoveryHint : 'Could not change sharing. Try again.')
    } finally { if (current()) setBusy(false) }
  }
  if (identity !== actor.current) return null
  const url = share ? `${window.location.origin}/c/${encodeURIComponent(share.slug)}` : null
  const close = () => { if (!busy) onClose() }
  return <Modal open onClose={close} title={`Share ${title}`} label="Share folder">
    <div className="edit-form" aria-busy={busy || state === 'loading'}>
      <p className="m-0">{unavailableReason === 'folder_restricted'
        ? 'This folder or one of its parents is private or protected. The link is unavailable until its visibility changes.'
        : unavailableReason === 'publication_restricted' ? 'Public access to this library is restricted. This link is unavailable.'
        : url ? 'Anyone with the link can view this folder and the folders inside it. The rest of your library stays private.'
        : 'Create a link that lets anyone view this folder and the folders inside it. The rest of your library stays private.'}</p>
      {state === 'loading' ? <LoadingState label="Loading share link…" /> : state === 'error'
        ? <div className="row-end edit-form-actions"><button type="button" className="btn btn-secondary" onClick={() => void reload()}>Try again</button></div>
        : url ? <>
          {!unavailableReason && <CopyField label="Folder link" value={url} onCopied={() => success('Link copied')}
            onCopyFailed={() => error('Couldn’t copy the link. Select and copy it.')} />}
          <div className="row-end edit-form-actions">
            {/* Revoking is one click away but not the row's loudest action. */}
            <button type="button" className="btn btn-danger-ghost folder-share-stop" disabled={busy} onClick={() => void change('stop')}>Stop sharing</button>
            {!unavailableReason && <a href={url} target="_blank" rel="noreferrer" className="btn btn-secondary">Open link</a>}
            <button type="button" className="btn btn-primary" disabled={busy} onClick={close}>Done</button>
          </div>
        </> : <div className="row-end edit-form-actions">
          <button type="button" className="btn btn-primary" disabled={busy || Boolean(unavailableReason)} onClick={() => void change('share')}>Create link</button>
        </div>}
    </div>
  </Modal>
}
