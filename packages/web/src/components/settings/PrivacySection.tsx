import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { isLive, isProductApiError, productClient } from '../../api'
import { useAuth } from '../../auth/AuthContext'
import { useToast } from '../AppToast'

function splitList(value: string): string[] {
  return value.split(/[\n,]/u).map((item) => item.trim()).filter((item) => item.length > 0)
}

export function PrivacySection() {
  const { isLoggedIn, user } = useAuth()
  const { success, error } = useToast()
  const enabled = isLive('contentGovernance')
  const accountId = user?.accountId
  const [etag, setEtag] = useState('"1"')
  const [owners, setOwners] = useState('')
  const [tags, setTags] = useState('')
  const [keywords, setKeywords] = useState('')
  const [languages, setLanguages] = useState('')
  const [busy, setBusy] = useState(false)
  const [available, setAvailable] = useState(enabled)

  useEffect(() => {
    // Drafts, etag, and availability belong to the account they were loaded for.
    // Clearing them before the fetch starts means a slow, aborted, or failed
    // load for a new account can never leave the previous account's filters on
    // screen (or submittable under the new one).
    setOwners('')
    setTags('')
    setKeywords('')
    setLanguages('')
    setEtag('"1"')
    setAvailable(enabled)
    if (!enabled || !isLoggedIn || !accountId) return
    const controller = new AbortController()
    productClient.getMyCatalogPreferences({ signal: controller.signal, maxRetries: 0 })
      .then((prefs) => {
        if (controller.signal.aborted) return
        setOwners(prefs.hiddenOwnerAccountIds.join('\n'))
        setTags(prefs.hiddenTags.join('\n'))
        setKeywords(prefs.hiddenTitleKeywords.join('\n'))
        setLanguages(prefs.preferredLanguages.join('\n'))
        setEtag(`"${prefs.revision}"`)
        setAvailable(true)
      })
      .catch((err) => {
        if (!controller.signal.aborted && isProductApiError(err) && err.status === 404) {
          setAvailable(false)
        }
      })
    return () => controller.abort()
  }, [enabled, isLoggedIn, accountId])

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!available || busy) return
    setBusy(true)
    try {
      const next = await productClient.updateMyCatalogPreferences({
        hiddenOwnerAccountIds: splitList(owners),
        hiddenTags: splitList(tags),
        hiddenTitleKeywords: splitList(keywords),
        preferredLanguages: splitList(languages),
      }, etag, { intentId: productClient.mutationIntentKey('catalog-preferences', productClient.newCommandId()), maxRetries: 0 })
      setEtag(`"${next.revision}"`)
      success('Catalog filters saved')
    } catch (err) {
      error(isProductApiError(err) ? err.recoveryHint : 'Catalog filters could not be saved')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <h3 className="settings-toggle-label">Privacy</h3>
        <p className="meta">
          What is public today, and what stays private.
        </p>
      </div>
      <dl className="settings-facts">
        <div>
          <dt>New collections start private</dt>
          <dd>
            There is no account-wide visibility default. Each collection is created private;
            you can publish it later from the collection editor.
          </dd>
        </div>
        <div>
          <dt>What your public profile shows</dt>
          <dd>
            Anyone can see your public collections, recent changes to them (Activity), who you
            follow and who follows you. Private collections never appear there.{' '}
            <Link to="/privacy">Privacy</Link>
          </dd>
        </div>
      </dl>
      {available && isLoggedIn ? (
        <form className="edit-form" onSubmit={(event) => void save(event)} data-testid="catalog-preferences-form">
          <p className="meta">Personal Explore filters stay on this account across devices. They never change anyone else’s permissions.</p>
          <div className="field">
            <label htmlFor="pref-owners">Hidden owner account IDs</label>
            <textarea id="pref-owners" value={owners} onChange={(event) => setOwners(event.target.value)} rows={3} disabled={busy} />
          </div>
          <div className="field">
            <label htmlFor="pref-tags">Hidden tags</label>
            <textarea id="pref-tags" value={tags} onChange={(event) => setTags(event.target.value)} rows={2} disabled={busy} />
          </div>
          <div className="field">
            <label htmlFor="pref-keywords">Hidden title keywords</label>
            <textarea id="pref-keywords" value={keywords} onChange={(event) => setKeywords(event.target.value)} rows={2} disabled={busy} />
          </div>
          <div className="field">
            <label htmlFor="pref-languages">Preferred languages</label>
            <textarea id="pref-languages" value={languages} onChange={(event) => setLanguages(event.target.value)} rows={2} disabled={busy} />
            <span className="field-hint">Empty means any language. A non-empty list hides items with unknown language.</span>
          </div>
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>Save filters</button>
        </form>
      ) : null}
    </section>
  )
}
