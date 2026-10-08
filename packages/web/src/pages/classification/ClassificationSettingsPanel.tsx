import { useEffect, useRef, useState } from 'react'
import { productClient, ProductApiError, type ClassificationSettings, type ClassificationSettingsPatch } from '../../api'
import { isAbort } from '../../lib/libraryTree'
import { useToast } from '../../components/AppToast'

export function ClassificationSettingsPanel({ collectionId }: { collectionId: string }) {
  const { success } = useToast()
  const [current, setCurrent] = useState<{ settings: ClassificationSettings; etag: string | null } | null>(null)
  const [mode, setMode] = useState<'off' | 'suggest'>('off')
  const [limit, setLimit] = useState(3)
  const [hidden, setHidden] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'info' | 'error'; text: string } | null>(null)
  const [conflict, setConflict] = useState(false)
  const [generation, setGeneration] = useState(0)
  const lifecycle = useRef<AbortController | null>(null)
  useEffect(() => {
    const abort = new AbortController(); lifecycle.current = abort
    void productClient.getClassificationSettings(collectionId, { signal: abort.signal, maxRetries: 0 }).then(result => {
      if (abort.signal.aborted) return
      setCurrent(result); setMode(result.settings.autoTagMode); setLimit(result.settings.maxAutoTags); setConflict(false); setMessage(null)
    }).catch(error => {
      if (isAbort(error) || abort.signal.aborted) return
      if (error instanceof ProductApiError && error.status === 404) setHidden(true)
      else setMessage({ kind: 'error', text: "Couldn't load classification settings." })
    })
    return () => abort.abort()
  }, [collectionId, generation])
  async function save() {
    if (!current?.etag || busy || conflict) return
    const patch: ClassificationSettingsPatch = { autoTagMode: mode, maxAutoTags: limit, executionMode: 'server_managed', providerProfileId: null }
    setBusy(true); setMessage(null)
    const abort = lifecycle.current
    try {
      const result = await productClient.updateClassificationSettings(collectionId, patch, current.etag, {
        intentId: productClient.mutationIntentKey('classification-settings', `${collectionId}:${current.etag}:${JSON.stringify(patch)}`),
        maxRetries: 0, signal: abort?.signal,
      })
      if (!abort?.signal.aborted) { setCurrent(result); success('Classification settings saved') }
    } catch (error) {
      if (isAbort(error) || abort?.signal.aborted) return
      const changed = error instanceof ProductApiError && (error.status === 412 || error.code === 'revision_conflict')
      setConflict(changed)
      setMessage({
        kind: 'error',
        text: changed
          ? 'Settings changed elsewhere. Refresh and review before saving again.'
          : 'Could not save classification settings. Retry this choice or refresh.',
      })
    } finally { if (!abort?.signal.aborted) setBusy(false) }
  }
  if (hidden) return null
  return <section className="classification-settings" aria-label="Classification settings">
    <h3>Bookmark classification</h3>
    <p className="meta">Suggestions use folders and tags already in this collection. Every change needs your confirmation.</p>
    {current && <>
      <div className="field">
      <label htmlFor="classification-tag-mode">Tag suggestions</label>
      <select id="classification-tag-mode" value={mode} disabled={busy || conflict} onChange={event => setMode(event.target.value as 'off' | 'suggest')}>
        <option value="off">Off</option><option value="suggest">Suggest existing tags</option>
      </select>
      </div>
      <div className="field">
      <label htmlFor="classification-tag-limit">Maximum suggested additions</label>
      <select id="classification-tag-limit" value={limit} disabled={busy || conflict} onChange={event => setLimit(Number(event.target.value))}>
        {[0, 1, 2, 3].map(value => <option key={value} value={value}>{value}</option>)}
      </select>
      </div>
      <button type="button" className="btn btn-secondary btn-sm" disabled={busy || conflict || !current.etag} onClick={() => void save()}>
        {busy ? 'Saving…' : 'Save classification settings'}
      </button>
    </>}
    {!current && message === null && <p className="meta" role="status">Loading classification settings…</p>}
    {message !== null && (
      <p className={message.kind === 'error' ? 'field-error' : 'meta'} role={message.kind === 'error' ? 'alert' : 'status'}>
        {message.text}
      </p>
    )}
    {message !== null && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setGeneration(value => value + 1)}>Refresh classification settings</button>}
  </section>
}
