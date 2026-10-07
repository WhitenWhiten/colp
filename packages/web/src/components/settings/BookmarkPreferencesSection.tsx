import { useEffect, useRef, useState } from 'react'
import type { BookmarkPreferencesPatch } from '@known/product-v1-client'
import { productClient, ProductApiError } from '../../api'
import { useAuth } from '../../auth/AuthContext'
import { getApiBaseUrl } from '../../api/config'
import { RouteState } from '../RouteState'

type Remote = Awaited<ReturnType<typeof productClient.getBookmarkPreferences>>
type Pending = { patch: BookmarkPreferencesPatch; etag: string; intentId: string }
type Cache = { current: Remote; pending?: Pending; conflict?: Remote }
const labels: Record<keyof BookmarkPreferencesPatch, string> = {
  bookmarkInsertPosition: 'Save position', foldersFirst: 'Folders first', captureMode: 'Capture mode',
  resultPanelAutoDismissMs: 'Result panel duration', learnFromCorrections: 'Use my classification corrections',
  resumeClassificationWhenOnline: 'Resume classification when online', aiTagMode: 'Tags from AI',
  subscriptionOnUnfollow: 'After unfollowing', subscriptionOnUnsubscribe: 'After unsubscribing',
  subscriptionDefaultCheckIntervalMinutes: 'Default check interval', subscriptionDefaultDigestMode: 'Default Digest content', subscriptionDefaultEditionLimit: 'Default recent issue count',
}

function formatPreference(field: keyof BookmarkPreferencesPatch, value: unknown): string {
  if (field === 'subscriptionDefaultCheckIntervalMinutes' && value === null) return 'Manual'
  if (value === undefined || value === null || value === '') return 'Not set'
  if (typeof value === 'boolean') return value ? 'On' : 'Off'
  if (field === 'captureMode') return value === 'automatic' ? 'Automatic' : 'Manual'
  if (field === 'bookmarkInsertPosition') return value === 'top' ? 'Top' : 'Bottom'
  if (field === 'aiTagMode') return value === 'off' ? 'Off' : value === 'add' ? 'Add' : 'Suggest'
  if (field === 'resultPanelAutoDismissMs') return value ? `${Number(value) / 1000} seconds` : 'Close manually'
  if (field === 'subscriptionOnUnfollow' || field === 'subscriptionOnUnsubscribe') return value === 'remove' ? 'Remove managed content' : 'Keep ordinary bookmarks'
  if (field === 'subscriptionDefaultCheckIntervalMinutes') return value === 60 ? '1 hour' : `${value} minutes`
  if (field === 'subscriptionDefaultDigestMode') return value === 'recent' ? 'Recent issues (maximum 20)' : 'Latest readable issue'
  return String(value)
}

export function BookmarkPreferencesSection() {
  const { user } = useAuth()
  // Remounting fences old responses and hides the previous account's cached values immediately.
  return user ? <AccountBookmarkPreferences key={user.accountId} accountId={user.accountId} /> : <RouteState kind="auth" title="Sign in to manage bookmark settings" titleAs="h3" />
}

function AccountBookmarkPreferences({ accountId }: { accountId: string }) {
  const key = JSON.stringify(['known.bookmark-preferences.v1', getApiBaseUrl() || location.origin, accountId])
  const [cache, setCache] = useState<Cache | null>(null)
  const [message, setMessage] = useState<{ kind: 'info' | 'error'; text: string } | null>(
    { kind: 'info', text: 'Loading preferences…' },
  )
  const [busy, setBusy] = useState(false)
  const lifecycle = useRef<AbortController | null>(null)
  const cacheRef = useRef<Cache | null>(null)
  const inFlight = useRef(false)

  function persist(next: Cache) {
    localStorage.setItem(key, JSON.stringify(next))
    cacheRef.current = next; setCache(next)
  }
  async function flush(pending: Pending, base: Cache, signal?: AbortSignal) {
    try {
      const current = await productClient.updateBookmarkPreferences(pending.patch, pending.etag, { intentId: pending.intentId, signal })
      if (signal?.aborted) return
      persist({ current }); setMessage({ kind: 'info', text: 'Saved to your account.' })
    } catch (error) {
      if (signal?.aborted) return
      if (error instanceof ProductApiError && error.status === 412) {
        try {
          const conflict = await productClient.getBookmarkPreferences({ signal, maxRetries: 0 })
          if (signal?.aborted) return
          persist({ ...base, pending, conflict }); setMessage({ kind: 'error', text: 'Another device changed these preferences. Review both values.' })
        } catch { if (!signal?.aborted) setMessage({ kind: 'error', text: 'Saved on this browser. Reconnect to review the account conflict.' }) }
      } else setMessage({ kind: 'error', text: 'Saved on this browser. It will sync when you reconnect or reopen these settings.' })
    }
  }
  useEffect(() => {
    const abort = new AbortController(); lifecycle.current = abort; inFlight.current = false
    async function refresh() {
      if (inFlight.current) return
      inFlight.current = true; setBusy(true)
      try {
        const stored = localStorage.getItem(key)
        const value = stored ? JSON.parse(stored) as Cache : null
        if (value?.current?.preferences && value.current.etag) {
          cacheRef.current = value; setCache(value)
          if (value.conflict) { setMessage({ kind: 'error', text: 'Review the account conflict.' }); return }
          if (value.pending) { await flush(value.pending, value, abort.signal); return }
        }
        const current = await productClient.getBookmarkPreferences({ signal: abort.signal, maxRetries: 0 })
        if (!abort.signal.aborted) { persist({ current }); setMessage(null) }
      } catch { if (!abort.signal.aborted) setMessage({ kind: 'error', text: 'Could not refresh preferences. Cached values may be out of date.' }) }
      finally { if (!abort.signal.aborted) { inFlight.current = false; setBusy(false) } }
    }
    void refresh()
    window.addEventListener('online', refresh)
    return () => { abort.abort(); window.removeEventListener('online', refresh) }
    // Account/origin identity defines this lifecycle; pending state lives in cacheRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  async function save(patch: BookmarkPreferencesPatch, base = cacheRef.current) {
    if (!base?.current.etag || inFlight.current) return
    inFlight.current = true; setBusy(true)
    const pending = { patch, etag: base.current.etag, intentId: crypto.randomUUID() }
    const next = { current: base.current, pending }
    try {
      persist(next); setMessage({ kind: 'info', text: 'Saved on this browser. Syncing…' })
      await flush(pending, next, lifecycle.current?.signal)
    } catch { setMessage({ kind: 'error', text: 'Not saved. Browser storage is unavailable; your account settings have not changed.' }) }
    finally { inFlight.current = false; if (!lifecycle.current?.signal.aborted) setBusy(false) }
  }
  const value = cache ? { ...cache.current.preferences, ...cache.pending?.patch } : null
  const disabled = busy || Boolean(cache?.conflict) || Boolean(cache?.pending)
  return <section className="stack gap-1" aria-label="Bookmark preferences">
    <div className="settings-section-head"><h3 className="settings-toggle-label">Bookmarks</h3><p className="meta">Account preferences sync to supported devices. The browser extension captures pages only when you click it. Configure browser folders and classification spending authorization in the extension.</p></div>
    {value && <>
      <div className="field"><label htmlFor="pref-capture-mode">Capture mode</label><select id="pref-capture-mode" value={value.captureMode ?? 'manual'} disabled={disabled} onChange={event => void save({ captureMode: event.target.value as 'manual' | 'automatic' })}>
        <option value="manual">Manual</option><option value="automatic">Automatic (requires extension authorization)</option>
      </select></div>
      <div className="field"><label htmlFor="pref-save-position">Save position</label><select id="pref-save-position" value={value.bookmarkInsertPosition} disabled={disabled} onChange={event => void save({ bookmarkInsertPosition: event.target.value as 'top' | 'bottom' })}>
        <option value="top">Top</option><option value="bottom">Bottom</option>
      </select></div>
      <div className="field"><label htmlFor="pref-panel-duration">Result panel duration</label><select id="pref-panel-duration" value={value.resultPanelAutoDismissMs ?? 3000} disabled={disabled} onChange={event => void save({ resultPanelAutoDismissMs: Number(event.target.value) })}>
        {[3000, 5000, 10000, 30000, 0].map(ms => <option key={ms} value={ms}>{ms ? `${ms / 1000} seconds` : 'Close manually'}</option>)}
      </select></div>
      <div className="option-group">
        <label className="option-row"><input type="checkbox" checked={value.foldersFirst} disabled={disabled} onChange={event => void save({ foldersFirst: event.target.checked })} /><span>Folders first</span></label>
        <label className="option-row"><input type="checkbox" checked={value.learnFromCorrections ?? true} disabled={disabled} onChange={event => void save({ learnFromCorrections: event.target.checked })} /><span>Use my classification corrections</span></label>
        <label className="option-row"><input type="checkbox" checked={value.resumeClassificationWhenOnline ?? true} disabled={disabled} onChange={event => void save({ resumeClassificationWhenOnline: event.target.checked })} /><span>Resume authorized, unstarted classification when online</span></label>
      </div>
      <fieldset className="settings-fieldset" disabled={disabled}>
        <legend className="section-label">Browser subscriptions</legend>
        <p className="meta">Exit defaults apply to mappings that still inherit each policy. Content defaults only affect new mappings.</p>
        {(['subscriptionOnUnfollow', 'subscriptionOnUnsubscribe'] as const).map(name => <div className="field" key={name}><label htmlFor={`pref-${name}`}>{labels[name]}</label><select id={`pref-${name}`} value={value[name] ?? ''} disabled={disabled || value[name] === undefined} onChange={event => void save({ [name]: event.target.value as 'keep' | 'remove' })}>
          <option value="" disabled>Server does not support this setting</option><option value="keep">Keep ordinary bookmarks</option><option value="remove">Remove managed content</option>
        </select></div>)}
        <div className="field"><label htmlFor="pref-sub-interval">Default check interval</label><select id="pref-sub-interval" value={value.subscriptionDefaultCheckIntervalMinutes === null ? 'manual' : value.subscriptionDefaultCheckIntervalMinutes ?? ''} disabled={disabled || value.subscriptionDefaultCheckIntervalMinutes === undefined} onChange={event => void save({ subscriptionDefaultCheckIntervalMinutes: event.target.value === 'manual' ? null : Number(event.target.value) as 5 | 15 | 60 })}>
          <option value="" disabled>Server does not support this setting</option><option value="5">5 minutes</option><option value="15">15 minutes</option><option value="60">1 hour</option><option value="manual">Manual</option>
        </select></div>
        <div className="field"><label htmlFor="pref-sub-digest">Default Digest content</label><select id="pref-sub-digest" value={value.subscriptionDefaultDigestMode ?? ''} disabled={disabled || value.subscriptionDefaultDigestMode === undefined} onChange={event => void save({ subscriptionDefaultDigestMode: event.target.value as 'latest' | 'recent' })}>
          <option value="" disabled>Server does not support this setting</option><option value="latest">Latest readable issue</option><option value="recent">Recent issues (maximum 20)</option>
        </select></div>
        {value.subscriptionDefaultDigestMode === 'recent' && <div className="field"><label htmlFor="pref-sub-recent-limit">Number of recent issues</label><input id="pref-sub-recent-limit" type="number" min={1} max={20} step={1} defaultValue={value.subscriptionDefaultEditionLimit} disabled={disabled || value.subscriptionDefaultEditionLimit === undefined} onBlur={event => { const count = Number(event.target.value); const valid = Number.isInteger(count) && count >= 1 && count <= 20; event.target.setAttribute('aria-invalid', String(!valid)); if (valid && count !== value.subscriptionDefaultEditionLimit) void save({ subscriptionDefaultEditionLimit: count }); else if (!valid) setMessage({ kind: 'error', text: 'Choose a whole number from 1 to 20.' }) }} /></div>}
        <p className="meta">Choose mount and preservation folders in the extension. Native folder IDs stay in that browser.</p>
      </fieldset>
    </>}
    {message !== null && (
      <p
        className={message.kind === 'error' ? 'field-error' : 'meta'}
        role={message.kind === 'error' ? 'alert' : 'status'}
      >
        {message.text}
      </p>
    )}
    {cache?.conflict && <>
      <table><caption>Conflicting preferences</caption><thead><tr><th>Preference</th><th>This browser</th><th>Account</th></tr></thead><tbody>
        {Object.entries(cache.pending?.patch ?? {}).map(([field, local]) => { const key = field as keyof BookmarkPreferencesPatch; return <tr key={field}><th>{labels[key]}</th><td>{formatPreference(key, local)}</td><td>{formatPreference(key, cache.conflict!.preferences[key])}</td></tr> })}
      </tbody></table>
      <button className="btn btn-secondary" disabled={busy} onClick={() => { try { persist({ current: cache.conflict! }); setMessage({ kind: 'info', text: 'Account settings adopted.' }) } catch { setMessage({ kind: 'error', text: 'Could not save this choice.' }) } }}>Use account settings</button>
      <button className="btn btn-secondary" disabled={busy} onClick={() => void save(cache.pending!.patch, { current: cache.conflict! })}>Update account with this browser’s changes</button>
    </>}
  </section>
}
