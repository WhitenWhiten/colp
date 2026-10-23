import { useEffect, useRef, type RefObject } from 'react'
import { Link } from 'react-router-dom'
import { AvatarImage } from '../AvatarImage'
import { useExitAnimation } from '../../lib/useExitAnimation'

type AccountUser = {
  name: string
  email?: string
  username?: string
  avatarUrl?: string | null
  initials: string
}

type Props = {
  activityAvailable?: boolean
  user: AccountUser
  open: boolean
  /** Parent coordinates mutual exclusion with the other nav menus. */
  onToggle: () => void
  onClose: () => void
  onOpenSettings: () => void
  onSignOut: () => void
  /** Lets the parent return focus here when Esc closes the dropdown (APG
      disclosure contract — the parent owns the global Esc listener). */
  triggerRef?: RefObject<HTMLButtonElement | null>
}

/** Account dropdown in the top bar. Disclosure pattern (aria-expanded, no
   role="menu") — the same contract TopNav's chrome test pins. */
export function AccountMenu({
  activityAvailable = false,
  user,
  open,
  onToggle,
  onClose,
  onOpenSettings,
  onSignOut,
  triggerRef,
}: Props) {
  const accountRef = useRef<HTMLDivElement>(null)
  const { mounted, closing } = useExitAnimation(open)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!accountRef.current?.contains(e.target as Node)) onClose()
    }
    window.addEventListener('pointerdown', onDown)
    return () => window.removeEventListener('pointerdown', onDown)
  }, [open, onClose])

  // Warm the settings dialog chunk while the menu is open.
  useEffect(() => {
    if (!open) return
    void import('../settings/SettingsDialog')
  }, [open])

  return (
    <div className="account-menu" ref={accountRef}>
      <button
        type="button"
        ref={triggerRef}
        className="account-trigger"
        data-testid="account-trigger"
        aria-expanded={open}
        aria-controls="account-dropdown"
        onClick={onToggle}
      >
        <span className="avatar avatar-nav" data-testid="avatar-nav" aria-hidden>
          <AvatarImage url={user.avatarUrl} initials={user.initials} />
        </span>
        <span className="account-trigger-meta">
          <strong>{user.name}</strong>
        </span>
      </button>
      {mounted && (
        <nav
          id="account-dropdown"
          className={`nav-dropdown${closing ? ' is-closing' : ''}`}
          aria-label="Account"
          inert={closing || undefined}
        >
          <div className="account-dropdown-head">
            <span className="avatar avatar-md" data-testid="avatar-md" aria-hidden>
              <AvatarImage url={user.avatarUrl} initials={user.initials} />
            </span>
            <div>
              <strong>{user.name}</strong>
              {/* This server has no public profiles, so the generated
                  @handle means nothing here; the sign-in name does. */}
              <div className="meta handle-text">
                {user.username ? `@${user.username}` : user.email || 'Signed in'}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              onClose()
              onOpenSettings()
            }}
          >
            Settings
          </button>
          {activityAvailable && (
            /* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- native anchor closes this disclosure on Enter or click */
            <Link to="/activity" onClick={onClose}>
              Activity
            </Link>
          )}
          {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- react-router Link renders a native anchor; Enter fires onClick (close dropdown) natively */}
          <Link to="/approvals" onClick={onClose}>
            Approvals
          </Link>
          <div className="ctx-menu-sep" />
          <button
            type="button"
            className="account-logout"
            onClick={() => {
              onSignOut()
            }}
          >
            Sign out
          </button>
        </nav>
      )}
    </div>
  )
}
