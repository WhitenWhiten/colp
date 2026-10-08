import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { productClient, isProductApiError } from '../../api'
import type { SubscriptionExitPreview } from '../../api/product-client-subscription-exits'
import { privateSessionIdentity, subscribeSession } from '../../api/sessionStore'
import type { BookmarkSubscriptionSource } from '../../lib/bookmarkSubscriptionBridge'
import { Icon } from '../Icon'
import { Modal } from '../Modal'

const ORIGIN = { mapping: "Set by this browser's own setting", global: 'Set by your account preference', authority: 'Set by the source’s access policy' } as const

export function SourceExitDialog({ source, unfollow, onClose, onCommitted }: {
  source: BookmarkSubscriptionSource; unfollow: boolean; onClose: () => void; onCommitted?: () => Promise<void>
}) {
  const identity = useSyncExternalStore(subscribeSession, privateSessionIdentity, privateSessionIdentity)
  const { sourceType, sourceId } = source
  const scope = identity + ':' + sourceType + ':' + sourceId
  const [view, setView] = useState<{ scope: string; preview?: SubscriptionExitPreview; error?: string; empty?: boolean; done?: boolean }>({ scope })
  const [attempt, setAttempt] = useState(0), [busy, setBusy] = useState(false), [stale, setStale] = useState(false)
  const command = useRef(crypto.randomUUID()), controller = useRef<AbortController | null>(null)
  useEffect(() => {
    const abort = new AbortController(); controller.current = abort; setView({ scope }); setBusy(false); setStale(false); command.current = crypto.randomUUID()
    const load = async () => {
      const source = { sourceType, sourceId }
      const existing = unfollow ? null : await productClient.findBookmarkSubscription(source, abort.signal)
      if (!unfollow && !existing) { if (!abort.signal.aborted) setView({ scope, empty: true }); return }
      const preview = await productClient.previewBookmarkSubscriptionExit(source, existing?.subscriptionId ?? null, { intentId: 'subscription-preview:' + crypto.randomUUID(), maxRetries: 0, signal: abort.signal })
      if (!abort.signal.aborted) setView({ scope, preview })
    }
    void load().catch(error => { if (!abort.signal.aborted) setView({ scope, error: isProductApiError(error) ? error.recoveryHint : "Couldn't load the affected browsers. Try again before confirming." }) })
    return () => abort.abort()
  }, [scope, sourceType, sourceId, unfollow, attempt])
  const current = view.scope === scope ? view : { scope }
  const confirm = async () => {
    if (busy || !current.preview || stale) return
    if (Date.parse(current.preview.expiresAt) <= Date.now()) { setStale(true); setView({ ...current, error: 'This preview expired. Refresh it to see the current browsers before confirming.' }); return }
    const abort = controller.current
    setBusy(true)
    try {
      await productClient.confirmBookmarkSubscriptionExit(source, current.preview.previewId, unfollow, { intentId: 'subscription-exit:' + command.current, maxRetries: 0, signal: abort?.signal })
      if (abort?.signal.aborted || privateSessionIdentity() !== identity) return
      setView({ ...current, done: true, error: undefined })
      void onCommitted?.().catch(() => undefined)
    } catch (error) {
      if (abort?.signal.aborted) return
      const changed = isProductApiError(error) && (error.status === 412 || error.code === 'precondition_failed' || error.code === 'snapshot_expired')
      setStale(changed)
      setView({ ...current, error: changed ? 'The affected browsers or their settings changed. Refresh the preview before confirming.' : 'The result is not confirmed. Retry the same action to check its receipt.' })
    } finally { if (!abort?.signal.aborted) setBusy(false) }
  }
  const noun = sourceType === 'collection' ? 'collection' : 'digest'
  const title = unfollow ? 'Unfollow ' + noun : 'Unsubscribe on all browsers'
  // Callers mount inside masthead action rows; portaling keeps .page-head p
  // and phone .social-actions .btn rules off the dialog body.
  return createPortal(<Modal open label={title} title={title} onClose={onClose} tone="danger">
    {current.done ? <p className="subscribe-setup-lede" role="status">{unfollow ? 'You no longer follow this ' + noun + '. ' : 'Unsubscribed. '}Each browser applies its change when it next connects, so local bookmarks may not have changed yet.</p> : <>
      {!current.empty && <p className="subscribe-setup-lede">{unfollow ? 'This stops following the ' + noun + ' and ends its bookmark sync in the browsers below.' : 'This ends this ' + noun + '’s bookmark sync in every browser below.'} The {noun} itself isn’t changed.</p>}
      {!current.preview && !current.error && !current.empty && <p className="subscription-exit-status" role="status">Loading affected browsers…</p>}
      {current.empty && <p className="subscribe-setup-lede" role="status">This account isn’t subscribed to this {noun} in any browser.</p>}
      {current.preview && <>
        {current.preview.targets.length
          ? <ul className="subscription-exit-targets" aria-label="Affected browsers">{current.preview.targets.map(target => <li key={target.mappingId} className="subscription-exit-target">
              <Icon name="browser" />
              <div className="subscription-exit-target-body"><strong>{target.profileLabel}</strong><span>{ORIGIN[target.policyOrigin]}</span></div>
              <span className={'badge ' + (target.effectiveAction === 'keep' ? 'badge--neutral' : 'badge--danger')}>{target.effectiveAction === 'keep' ? 'Keep as ordinary bookmarks' : 'Remove synced bookmarks'}</span>
            </li>)}</ul>
          : <p className="subscription-exit-status">No browsers are affected.</p>}
        <p className="subscription-exit-note">Each browser confirms its own change; offline browsers finish when they reconnect. Bookmarks you added yourself are always kept.</p>
      </>}
      {current.error && <p className="field-error subscribe-setup-alert" role="alert"><Icon name="alert" />{current.error}</p>}
    </>}
    <div className="row row-wrap subscribe-setup-actions">
      <button type="button" className="btn btn-secondary" onClick={onClose}>{current.done ? 'Done' : 'Cancel'}</button>
      {!current.done && current.error && (!current.preview || stale) && <button type="button" className="btn btn-secondary" onClick={() => setAttempt(value => value + 1)}>Refresh preview</button>}
      {!current.done && current.preview && !stale && <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void confirm()}>{busy ? 'Confirming…' : current.error ? 'Retry same action' : unfollow ? 'Confirm unfollow' : 'Confirm unsubscribe'}</button>}
    </div>
  </Modal>, document.body)
}
