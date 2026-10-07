import { useEffect, useRef, useState, type FormEvent } from 'react'
import { isProductApiError, productClient } from '../../api'
import { useAuth } from '../../auth/AuthContext'
import { useToast } from '../AppToast'
import { Icon } from '../Icon'
import { canonicalSiteOrigin } from '../../lib/chrome'

/** Matches UpdateMeRequest.about / ProfileView.about maxLength. */
const ABOUT_MAX = 2000

/**
 * Mirrors HANDLE_CLAIM_MAX in the identity domain. The wire contract still
 * accepts 64 so handles minted under the retired opaque scheme keep resolving;
 * this is the bound the server applies to a handle changing hands.
 */
const HANDLE_CLAIM_MAX = 30

export function ProfileSection({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) {
  const [name, setName] = useState('')
  const [handle, setHandle] = useState('')
  const [about, setAbout] = useState('')
  const [avatarUrl, setAvatarUrl] = useState('')
  const [savingProfile, setSavingProfile] = useState(false)
  const [uploadingAvatar, setUploadingAvatar] = useState(false)
  const [profileDirty, setProfileDirty] = useState(false)
  const hydratedAccountId = useRef<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [profileError, setProfileError] = useState<string | null>(null)
  const { user, bootstrapping, runAuthMutation } = useAuth()
  const { success } = useToast()
  const publicHost = canonicalSiteOrigin().replace(/^https?:\/\//u, '')

  useEffect(() => {
    if (!user) return
    if (profileDirty && hydratedAccountId.current === user.accountId) return
    setName(user.name)
    setHandle(user.handle)
    setAbout(user.about ?? '')
    setAvatarUrl(user.avatarUrl ?? '')
    setProfileDirty(false)
    hydratedAccountId.current = user.accountId
  }, [profileDirty, user])

  useEffect(() => {
    onDirtyChange?.(profileDirty)
  }, [profileDirty, onDirtyChange])

  async function handleAvatarFile(file: File | undefined) {
    if (!file) return
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setProfileError('Choose a PNG, JPEG or WebP image.')
      return
    }
    setUploadingAvatar(true)
    setFieldErrors({})
    setProfileError(null)
    try {
      const updated = await runAuthMutation(() => productClient.uploadAvatar(
        file,
        { intentId: productClient.mutationIntentKey('upload-avatar', productClient.newCommandId()) },
      ))
      setAvatarUrl(updated.profile.avatarUrl ?? '')
      success('Avatar updated')
    } catch (err) {
      if (isProductApiError(err)) {
        const message = err.fieldErrors.length > 0 ? err.fieldErrors[0]!.message : err.recoveryHint
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
        <h3 className="settings-toggle-label">Public profile</h3>
        <p className="meta">
          How you appear to other people on {publicHost}.
        </p>
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
          <span className="field-hint" id="set-handle-hint">
            {publicHost}/u/{handle.trim() || '…'} · this is yours to change whenever you like
          </span>
          {fieldErrors['/handle'] && <span className="field-error" id="set-handle-error" role="alert" data-testid="field-error">{fieldErrors['/handle']}</span>}
        </div>
        <div className="field">
          <label htmlFor="set-about">About</label>
          <textarea
            id="set-about"
            value={about}
            rows={4}
            maxLength={ABOUT_MAX}
            disabled={bootstrapping || !user || savingProfile}
            aria-invalid={!!fieldErrors['/about']}
            aria-describedby={fieldErrors['/about'] ? 'set-about-error' : undefined}
            onChange={(e) => { setAbout(e.target.value); setProfileDirty(true) }}
          />
          {fieldErrors['/about'] && <span className="field-error" id="set-about-error" role="alert" data-testid="field-error">{fieldErrors['/about']}</span>}
        </div>
        <div className="field">
          <label htmlFor="set-avatar-file">Avatar</label>
          <div className="settings-avatar-row">
            <span className="avatar avatar-lg settings-avatar-preview" aria-hidden data-testid="settings-avatar-preview">
              {avatarUrl.trim() ? <img src={avatarUrl.trim()} alt="" /> : <span>{user?.initials ?? ''}</span>}
            </span>
            <div className="settings-avatar-upload">
              <label className="file-drop-card" htmlFor="set-avatar-file">
                <span className="file-drop-card-preview" aria-hidden="true">
                  {avatarUrl.trim() ? <img src={avatarUrl.trim()} alt="" width={20} height={20} /> : <Icon name="upload" />}
                </span>
                <span className="file-drop-card-copy">
                  <strong>Upload avatar</strong>
                  <small>PNG, JPEG or WebP · max 2 MB</small>
                </span>
                <input id="set-avatar-file" type="file" accept="image/png,image/jpeg,image/webp" disabled={bootstrapping || !user || savingProfile || uploadingAvatar} aria-describedby={fieldErrors['/avatarUrl'] ? 'set-avatar-error' : undefined} onChange={(e) => { void handleAvatarFile(e.currentTarget.files?.[0]); e.currentTarget.value = '' }} />
              </label>
              {uploadingAvatar && <span className="meta avatar-upload-status" data-testid="avatar-upload-status">Uploading…</span>}
            </div>
          </div>
          {fieldErrors['/avatarUrl'] && <span className="field-error" id="set-avatar-error" role="alert" data-testid="field-error">{fieldErrors['/avatarUrl']}</span>}
        </div>
        {profileError && <p className="field-error" role="alert">{profileError}</p>}
        <button type="submit" className="btn btn-primary settings-save-btn" disabled={bootstrapping || !user || savingProfile || uploadingAvatar}>
          {savingProfile ? 'Saving…' : 'Save profile'}
        </button>
      </form>
    </section>
  )
}
