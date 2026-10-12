import { useEffect, useRef, useState, type FormEvent } from 'react'
import { isProductApiError, productClient } from '../../api'
import { useAuth } from '../../auth/AuthContext'
import { useToast } from '../AppToast'

export function ProfileSection({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) {
  const [name, setName] = useState('')
  // There are no public profile pages, so the generated handle and the About
  // text are not edited here; both are sent back unchanged so saving never
  // changes them. The sign-in username is what identifies the owner.
  const [handle, setHandle] = useState('')
  const [about, setAbout] = useState('')
  const [savingProfile, setSavingProfile] = useState(false)
  const [profileDirty, setProfileDirty] = useState(false)
  const hydratedAccountId = useRef<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [profileError, setProfileError] = useState<string | null>(null)
  const { user, bootstrapping, runAuthMutation } = useAuth()
  const { success } = useToast()

  useEffect(() => {
    if (!user) return
    if (profileDirty && hydratedAccountId.current === user.accountId) return
    setName(user.name)
    setHandle(user.handle)
    setAbout(user.about ?? '')
    setProfileDirty(false)
    hydratedAccountId.current = user.accountId
  }, [profileDirty, user])

  useEffect(() => {
    onDirtyChange?.(profileDirty)
  }, [profileDirty, onDirtyChange])

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSavingProfile(true)
    setFieldErrors({})
    setProfileError(null)
    try {
      await runAuthMutation(() => productClient.updateMe(
        { handle, displayName: name, about },
        { intentId: productClient.mutationIntentKey('update-me', productClient.newCommandId()) },
      ))
      setProfileDirty(false)
      success('Profile saved')
    } catch (err) {
      if (isProductApiError(err)) {
        const fields = Object.fromEntries(err.fieldErrors.map((item) => [item.path, item.message]))
        setFieldErrors(fields)
        if (err.fieldErrors.length > 0) {
          setProfileError(null)
        } else {
          const message = err.code === 'csrf_failed'
            ? 'Session security token expired. Try again.'
            : err.recoveryHint
          setProfileError(message)
        }
      } else {
        setProfileError('Profile could not be saved. Try again.')
      }
    } finally {
      setSavingProfile(false)
    }
  }

  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <h3 className="settings-toggle-label">Profile</h3>
        <p className="meta">Your name in the account menu and on collections you share.</p>
      </div>
      <form
        className="stack settings-form gap-4"
        onSubmit={saveProfile}
      >
        <div className="field">
          <label htmlFor="set-name">Display name</label>
          <input id="set-name" value={name} disabled={bootstrapping || !user || savingProfile} aria-invalid={!!fieldErrors['/displayName']} aria-describedby={fieldErrors['/displayName'] ? 'set-name-error' : undefined} onChange={(e) => { setName(e.target.value); setProfileDirty(true) }} />
          {fieldErrors['/displayName'] && <span className="field-error" id="set-name-error" role="alert" data-testid="field-error">{fieldErrors['/displayName']}</span>}
        </div>
        {user?.username && (
          <div className="field">
            <label htmlFor="set-username">Username</label>
            <input id="set-username" value={user.username} readOnly aria-describedby="set-username-hint" />
            <span className="field-hint" id="set-username-hint">You sign in with it, here and in the browser extension.</span>
          </div>
        )}
        {profileError && <p className="field-error" role="alert">{profileError}</p>}
        <button type="submit" className="btn btn-primary settings-save-btn" disabled={bootstrapping || !user || savingProfile}>
          {savingProfile ? 'Saving…' : 'Save profile'}
        </button>
      </form>
    </section>
  )
}
