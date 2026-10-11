import { useEffect, useRef, useState, type FormEvent } from 'react'
import { isProductApiError, productClient } from '../../api'
import { useAuth } from '../../auth/AuthContext'
import { useToast } from '../AppToast'

/**
 * Mirrors HANDLE_CLAIM_MAX in the identity domain. The wire contract still
 * accepts 64 so handles minted under the retired opaque scheme keep resolving;
 * this is the bound the server applies to a handle changing hands.
 */
const HANDLE_CLAIM_MAX = 30

export function ProfileSection({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) {
  const [name, setName] = useState('')
  const [handle, setHandle] = useState('')
  // There are no public profile pages, so the About text is not edited
  // here; it is sent back unchanged so saving never clears it.
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
          const message = err.code === 'handle_taken'
            ? 'That handle is already taken.'
            : err.code === 'csrf_failed'
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
        <p className="meta">Your name and handle on this server.</p>
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
        <div className="field">
          <label htmlFor="set-handle">Handle</label>
          <input id="set-handle" value={handle} maxLength={HANDLE_CLAIM_MAX} disabled={bootstrapping || !user || savingProfile} aria-invalid={!!fieldErrors['/handle']} aria-describedby={fieldErrors['/handle'] ? 'set-handle-hint set-handle-error' : 'set-handle-hint'} onChange={(e) => { setHandle(e.target.value); setProfileDirty(true) }} />
          <span className="field-hint" id="set-handle-hint">Shown in your account menu. Change it whenever you like.</span>
          {fieldErrors['/handle'] && <span className="field-error" id="set-handle-error" role="alert" data-testid="field-error">{fieldErrors['/handle']}</span>}
        </div>
        {profileError && <p className="field-error" role="alert">{profileError}</p>}
        <button type="submit" className="btn btn-primary settings-save-btn" disabled={bootstrapping || !user || savingProfile}>
          {savingProfile ? 'Saving…' : 'Save profile'}
        </button>
      </form>
    </section>
  )
}
