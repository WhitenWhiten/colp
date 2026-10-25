import { useEffect, useRef, useState } from 'react'
import type { BookmarkPreferencesPatch } from '@known/product-v1-client'
import { productClient, ProductApiError } from '../../api'
import { useAuth } from '../../auth/AuthContext'
import { getApiBaseUrl } from '../../api/config'
import { FilterRail } from '../FilterRail'
import { RouteState } from '../RouteState'
import { SelectMenu } from '../SelectMenu'

type Remote = Awaited<ReturnType<typeof productClient.getBookmarkPreferences>>
type Pending = { patch: BookmarkPreferencesPatch; etag: string; intentId: string }
type Cache = { current: Remote; pending?: Pending; conflict?: Remote }
/* The words are the extension's (Options › Saving): one preference record,
   one name for each setting wherever it is changed. */
const labels: Record<keyof BookmarkPreferencesPatch, string> = {
  bookmarkInsertPosition: 'New bookmarks go', foldersFirst: 'Show folders before bookmarks', captureMode: 'Toolbar button',
  resultPanelAutoDismissMs: 'Close the result panel', learnFromCorrections: 'Use my classification corrections',
  resumeClassificationWhenOnline: 'Resume classification when online', aiTagMode: 'Tags from AI',
  subscriptionOnUnfollow: 'After unfollowing', subscriptionOnUnsubscribe: 'After unsubscribing',
  subscriptionDefaultCheckIntervalMinutes: 'Default check interval', subscriptionDefaultDigestMode: 'Default Digest content', subscriptionDefaultEditionLimit: 'Default recent issue count',
}

const PANEL_DURATIONS = [3000, 5000, 10000, 30000, 0] as const

function formatPreference(field: keyof BookmarkPreferencesPatch, value: unknown): string {
  if (field === 'subscriptionDefaultCheckIntervalMinutes' && value === null) return 'Manual'
  if (value === undefined || value === null || value === '') return 'Not set'
  if (typeof value === 'boolean') return value ? 'On' : 'Off'
  if (field === 'captureMode') return value === 'automatic' ? 'Automatic' : 'Manual'
  if (field === 'bookmarkInsertPosition') return value === 'top' ? 'Top of folder' : 'Bottom of folder'
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
  return <section className="settings-section" aria-label="Bookmark preferences">
    <div className="settings-section-head"><h3 className="settings-toggle-label">Bookmarks</h3><p className="meta">These sync to the browser extension.</p></div>
    {value && <div className="settings-rows">
      <div className="toggle-row">
        <div><strong id="pref-capture-mode">Toolbar button</strong><span className="meta">Manual opens the save form first. Automatic saves in one click, once you confirm it in the extension.</span></div>
        <FilterRail<'manual' | 'automatic'> variant="segments" className="view-switch" selection="manual" label="Toolbar button" labelledBy="pref-capture-mode"
          value={value.captureMode ?? 'manual'} onChange={mode => void save({ captureMode: mode })}
          options={[{ value: 'manual', label: 'Manual', disabled }, { value: 'automatic', label: 'Automatic', disabled }]} />
      </div>
      <div className="toggle-row">
        <div><strong id="pref-save-position">New bookmarks go</strong></div>
        <FilterRail<'top' | 'bottom'> variant="segments" className="view-switch" selection="manual" label="New bookmarks go" labelledBy="pref-save-position"
          value={value.bookmarkInsertPosition} onChange={position => void save({ bookmarkInsertPosition: position })}
          options={[{ value: 'top', label: 'Top of folder', disabled }, { value: 'bottom', label: 'Bottom of folder', disabled }]} />
      </div>
      <div className="toggle-row">
        <div><strong>Close the result panel</strong><span className="meta">Automatic mode only.</span></div>
        <SelectMenu label="Close the result panel" disabled={disabled} value={String(value.resultPanelAutoDismissMs ?? 3000)}
          options={PANEL_DURATIONS.map(ms => ({ value: String(ms), label: ms ? `${ms / 1000} seconds` : 'Close manually' }))}
          onChange={ms => void save({ resultPanelAutoDismissMs: Number(ms) })} />
      </div>
      <div className="toggle-row">
        <div><strong id="pref-folders-first">Show folders before bookmarks</strong><span className="meta" id="pref-folders-first-hint">Also reorders your browser bookmarks, keeping the order within each group.</span></div>
        <button type="button" role="switch" className="toggle" aria-checked={value.foldersFirst} aria-labelledby="pref-folders-first"
          aria-describedby="pref-folders-first-hint" disabled={disabled} onClick={() => void save({ foldersFirst: !value.foldersFirst })} />
      </div>
    </div>}
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
