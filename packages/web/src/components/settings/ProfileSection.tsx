import { useEffect, useRef, useState, type FormEvent } from 'react'
import { isProductApiError, productClient } from '../../api'
import { useAuth } from '../../auth/AuthContext'
import { useToast } from '../AppToast'
import { AvatarImage } from '../AvatarImage'
import { Icon } from '../Icon'

/** Mirrors AVATAR_ALLOWED_CONTENT_TYPES and AVATAR_MAX_BYTES on the server. */
const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp']
const AVATAR_MAX_BYTES = 2 * 1024 * 1024

export function ProfileSection({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) {
  const [name, setName] = useState('')
  // There are no public profile pages, so the generated handle and the About
  // text are not edited here; both are sent back unchanged so saving never
  // changes them. The sign-in username is what identifies the owner.
  const [handle, setHandle] = useState('')
  const [about, setAbout] = useState('')
  const [savingProfile, setSavingProfile] = useState(false)
  const [uploadingAvatar, setUploadingAvatar] = useState(false)
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

  async function handleAvatarFile(file: File | undefined) {
    if (!file) return
    setFieldErrors({})
    if (!AVATAR_TYPES.includes(file.type)) {
      setProfileError('Choose a PNG, JPEG or WebP image.')
      return
    }
    if (file.size > AVATAR_MAX_BYTES) {
      setProfileError('Choose an image of 2 MB or less.')
      return
    }
    setUploadingAvatar(true)
    setProfileError(null)
    try {
      await runAuthMutation(() => productClient.uploadAvatar(
        file,
        { intentId: productClient.mutationIntentKey('upload-avatar', productClient.newCommandId()) },
      ))
      success('Avatar updated')
    } catch (err) {
      if (isProductApiError(err)) {
        // The server says why uploads are off here (no HTTPS, no storage);
        // the generic hint would only suggest retrying.
        const message = err.fieldErrors.length > 0
          ? err.fieldErrors[0]!.message
          : err.code === 'feature_temporarily_unavailable' && err.retryAfterSeconds == null
            ? err.message
            : err.recoveryHint
        setProfileError(message)
      } else {
        setProfileError('Avatar could not be uploaded. Try again.')
      }
    } finally {
      setUploadingAvatar(false)
    }
  }

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
        <p className="meta">Your picture and name in the account menu and on collections you share.</p>
      </div>
      <form
        className="stack settings-form gap-4"
        onSubmit={saveProfile}
      >
        <div className="field">
          <label htmlFor="set-avatar-file">Avatar</label>
          <div className="settings-avatar-row">
            <span className="avatar avatar-lg settings-avatar-preview" aria-hidden data-testid="settings-avatar-preview">
              <AvatarImage url={user?.avatarUrl} initials={user?.initials ?? ''} />
            </span>
            <div className="settings-avatar-upload">
              <label className="file-drop-card" htmlFor="set-avatar-file">
                <span className="file-drop-card-preview" aria-hidden="true">
                  <Icon name="person" />
                </span>
                <span className="file-drop-card-copy">
                  <strong>{user?.avatarUrl ? 'Change avatar' : 'Upload avatar'}</strong>
                  <small>PNG, JPEG or WebP · max 2 MB</small>
                </span>
                <input id="set-avatar-file" type="file" accept={AVATAR_TYPES.join(',')} disabled={bootstrapping || !user || savingProfile || uploadingAvatar} onChange={(e) => { void handleAvatarFile(e.currentTarget.files?.[0]); e.currentTarget.value = '' }} />
              </label>
              {uploadingAvatar && <span className="meta avatar-upload-status" data-testid="avatar-upload-status">Uploading…</span>}
            </div>
          </div>
        </div>
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
        <button type="submit" className="btn btn-primary settings-save-btn" disabled={bootstrapping || !user || savingProfile || uploadingAvatar}>
          {savingProfile ? 'Saving…' : 'Save profile'}
        </button>
      </form>
    </section>
  )
}
