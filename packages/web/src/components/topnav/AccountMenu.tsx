import { useEffect, useRef, type RefObject } from 'react'
import { Link } from 'react-router-dom'
import { AvatarImage } from '../AvatarImage'
import { isSelfHostedPathEnabled } from '../../lib/edition'
import { useExitAnimation } from '../../lib/useExitAnimation'

type AccountUser = {
  name: string
  handle: string
  avatarUrl?: string | null
  initials: string
}

type Props = {
  user: AccountUser
  /** Unread badge count; null when the notification surface is flag-gated off. */
  unreadCount: number | null
  showWriteApprovals: boolean
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
  user,
  unreadCount,
  showWriteApprovals,
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
          <span className="meta">@{user.handle}</span>
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
              <div className="meta handle-text">@{user.handle}</div>
            </div>
          </div>
          {isSelfHostedPathEnabled(`/u/${user.handle}`) && (
            // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- react-router Link renders a native anchor; Enter fires onClick (close dropdown) natively
            <Link to={`/u/${user.handle}`} onClick={onClose}>
              Profile
            </Link>
          )}
          {isSelfHostedPathEnabled('/creator') && (
            // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- react-router Link renders a native anchor; Enter fires onClick (close dropdown) natively
            <Link to="/creator" onClick={onClose}>
              Publishing insights
            </Link>
          )}
          {isSelfHostedPathEnabled('/credits') && (
            // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- react-router Link renders a native anchor; Enter fires onClick (close dropdown) natively
            <Link to="/credits" onClick={onClose}>
              Credits and ledger
            </Link>
          )}
          <button
            type="button"
            onClick={() => {
              onClose()
              onOpenSettings()
            }}
          >
            Settings
          </button>
          {isSelfHostedPathEnabled('/notifications') && (
            // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- react-router Link renders a native anchor; Enter fires onClick (close dropdown) natively
            <Link to="/notifications" onClick={onClose}>
              Notifications{unreadCount ? ` (${unreadCount})` : ''}
            </Link>
          )}
          {showWriteApprovals && (
            // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- react-router Link renders a native anchor; Enter fires onClick (close dropdown) natively
            <Link to="/approvals" onClick={onClose}>
              Write approvals
            </Link>
          )}
          <div className="ctx-menu-sep" />
          <button
            type="button"
            className="account-logout"
            onClick={() => {
              onSignOut()
            }}
          >
            Log out
          </button>
        </nav>
      )}
    </div>
  )
}
