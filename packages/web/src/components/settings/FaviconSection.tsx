import { useCallback, useEffect, useRef, useState } from 'react'
import {
  isProductApiError,
  productClient,
  type FaviconIconPolicy,
} from '../../api'
import { LoadingState } from '../../components/EmptyState'
import { Icon } from '../../components/Icon'

type FaviconPolicyState =
  | { kind: 'loading' }
  | { kind: 'ready'; policy: FaviconIconPolicy & { etag: string } }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string }

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/**
 * Settings → Favicon: the account-wide icon source policy. FO-03 makes every
 * setting real: the new-bookmark default (capture/online/none), the online
 * provider template, fillMissing and forceAllOnline. A policy change that
 * activates a batch behavior returns a durable jobId tracked by the Settings
 * progress strip (with failed-item retries); the online providerTemplate
 * alone never enables online, and no-op patches keep the same revision.
 */
export function FaviconSection({ onDirtyChange, onJobStarted }: {
  onDirtyChange?: (dirty: boolean) => void
  onJobStarted?: (jobId: string) => void
} = {}) {
  const [state, setState] = useState<FaviconPolicyState>({ kind: 'loading' })
  const [busy, setBusy] = useState(false)
  const lifecycle = useRef<AbortController | null>(null)
  const [providerDraft, setProviderDraft] = useState<string>('')
  const [dirtyProvider, setDirtyProvider] = useState(false)
  const dirtyProviderRef = useRef(false)
  dirtyProviderRef.current = dirtyProvider
  useEffect(() => {
    onDirtyChange?.(dirtyProvider)
    return () => onDirtyChange?.(false)
  }, [dirtyProvider, onDirtyChange])
  const [notice, setNotice] = useState<{ kind: 'info' | 'error'; text: string } | null>(null)

  const load = useCallback(async (signal?: AbortSignal, resetProvider = false) => {
    try {
      const policy = await productClient.getMyFaviconPolicy({ signal, maxRetries: 0 })
      // The controller is what normally prevents a stale apply; checking the
      // signal keeps it true for callers that pass none.
      if (signal?.aborted) return
      setState({ kind: 'ready', policy })
      if (!dirtyProviderRef.current || resetProvider) {
        setProviderDraft(policy.providerTemplate)
        setDirtyProvider(false)
      }
    } catch (error) {
      if (isAbort(error)) return
      if (isProductApiError(error) && error.status === 404) {
        setState({ kind: 'unavailable' })
        return
      }
      setState({
        kind: 'error',
        message: isProductApiError(error) ? error.recoveryHint : "Couldn't load favicon settings.",
      })
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    lifecycle.current = controller
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  const save = async (patch: Record<string, unknown>) => {
    const signal = lifecycle.current?.signal
    if (state.kind !== 'ready' || busy || !signal || signal.aborted) return
    setBusy(true)
    setNotice(null)
    try {
      const result = await productClient.updateMyFaviconPolicy(patch, state.policy.etag, {
        intentId: productClient.mutationIntentKey('favicon-policy:me', productClient.newCommandId()),
        signal,
        maxRetries: 0,
      })
      if (signal.aborted) return
      await load(signal, 'providerTemplate' in patch)
      if (result.jobId !== null) onJobStarted?.(result.jobId)
      if (result.jobId !== null) setNotice({ kind: 'info', text: 'A batch icon job was started for this change.' })
    } catch (error) {
      if (isAbort(error) || signal.aborted) return
      if (isProductApiError(error) && error.isPreconditionFailed) {
        await load(signal)
        setNotice({ kind: 'info', text: 'Favicon settings changed elsewhere — view refreshed, choose again.' })
      } else {
        setNotice({
          kind: 'error',
          text: isProductApiError(error) ? error.recoveryHint : 'The favicon settings could not be saved.',
        })
      }
    } finally {
      if (!signal.aborted) setBusy(false)
    }
  }

  const choose = (newDefault: FaviconIconPolicy['newDefault']) => {
    if (state.kind !== 'ready' || state.policy.newDefault === newDefault) return
    void save({ newDefault })
  }

  const toggleFill = (value: boolean) => {
    if (state.kind !== 'ready' || state.policy.fillMissing === value) return
    void save({ fillMissing: value })
  }

  const toggleForce = (value: boolean) => {
    if (state.kind !== 'ready' || state.policy.forceAllOnline === value) return
    void save({ forceAllOnline: value })
  }

  const submitProvider = () => {
    if (state.kind !== 'ready' || !dirtyProvider) return
    void save({ providerTemplate: providerDraft })
  }

  const current = state.kind === 'ready' ? state.policy : null

  return (
    <section className="settings-section" data-testid="settings-favicon">
      <div className="settings-section-head">
        <h2 className="settings-section-title">Favicon</h2>
        <p className="meta">
          Default icon behavior when no custom image is set.
        </p>
      </div>
      {state.kind === 'loading' && <LoadingState label="Loading icon settings…" />}
      {state.kind === 'unavailable' && (
        <p className="meta" data-testid="favicon-policy-unavailable">
          Favicon settings are disabled on this server.
        </p>
      )}
      {state.kind === 'error' && (
        <p className="field-error" role="alert">{state.message}</p>
      )}
      {state.kind === 'ready' && (
        <>
          <fieldset className="option-group" disabled={busy}>
            <legend>Default for new bookmarks</legend>
            <label className="option-row">
              <input
                type="radio"
                name="favicon-default"
                value="capture"
                checked={current?.newDefault === 'capture'}
                onChange={() => void choose('capture')}
              />
              <span>
                Capture automatically
                <span className="meta">Use the site or extension icon.</span>
              </span>
            </label>
            <label className="option-row">
              <input
                type="radio"
                name="favicon-default"
                value="online"
                checked={current?.newDefault === 'online'}
                onChange={() => void choose('online')}
              />
              <span>
                Fetch online
                <span className="meta">Use the online icon provider for new bookmarks.</span>
              </span>
            </label>
            <label className="option-row">
              <input
                type="radio"
                name="favicon-default"
                value="none"
                checked={current?.newDefault === 'none'}
                onChange={() => void choose('none')}
              />
              <span>
                No icon
                <span className="meta">Show initials unless an image is uploaded.</span>
              </span>
            </label>
          </fieldset>

          {/* Each applies when switched, like the switches in Bookmarks. */}
          <div className="settings-rows">
            <div className="toggle-row">
              <div>
                <strong id="favicon-fill-missing-label">Fill missing icons</strong>
                <span className="meta" id="favicon-fill-missing-hint">
                  Fetch provider icons for bookmarks without one.
                </span>
              </div>
              <button
                type="button"
                role="switch"
                className="toggle"
                data-testid="favicon-fill-missing"
                aria-checked={current?.fillMissing === true}
                aria-labelledby="favicon-fill-missing-label"
                aria-describedby="favicon-fill-missing-hint"
                disabled={busy}
                onClick={() => toggleFill(current?.fillMissing !== true)}
              />
            </div>
            <div className="toggle-row">
              <div>
                <strong id="favicon-force-online-label">Force all icons online</strong>
                <span className="meta" id="favicon-force-online-hint">
                  Override uploaded icons with provider icons. Turn off to restore them.
                </span>
              </div>
              <button
                type="button"
                role="switch"
                className="toggle"
                data-testid="favicon-force-online"
                aria-checked={current?.forceAllOnline === true}
                aria-labelledby="favicon-force-online-label"
                aria-describedby="favicon-force-online-hint"
                disabled={busy}
                onClick={() => toggleForce(current?.forceAllOnline !== true)}
              />
            </div>
          </div>

          <details className="settings-disclosure">
            <summary>
              <Icon name="chevron-right" />
              <span>Online provider template</span>
            </summary>
            <div className="field">
              <label htmlFor="favicon-provider-template">Provider URL template</label>
              <div className="row favicon-provider-row">
                <input
                  id="favicon-provider-template"
                  data-testid="favicon-provider-template"
                  value={providerDraft}
                  onChange={(event) => { setProviderDraft(event.target.value); setDirtyProvider(true) }}
                />
                <button
                  type="button"
                  className="btn btn-secondary"
                  data-testid="favicon-provider-save"
                  disabled={busy || !dirtyProvider}
                  onClick={() => void submitProvider()}
                >
                  Save provider
                </button>
              </div>
              <span className="field-hint">
                Include {'{hostname}'} once for the site host. Saving does not turn on Fetch online.
              </span>
            </div>
          </details>

          {notice !== null && (
            <p
              className={notice.kind === 'error' ? 'field-error' : 'meta'}
              role={notice.kind === 'error' ? 'alert' : 'status'}
              data-testid="favicon-policy-notice"
            >
              {notice.text}
            </p>
          )}
        </>
      )}
    </section>
  )
}
