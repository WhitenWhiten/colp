import { useEffect, useRef, useState } from 'react'
import { BookmarkPreferencesSection } from './BookmarkPreferencesSection'
import { Link } from 'react-router-dom'
import { isLive, isNotificationExposureEnabled } from '../../api'
import { useAuth } from '../../auth/AuthContext'
import { AuthStatusRegion } from '../auth/AuthStatusRegion'
import { EmailChangeSection } from '../auth/EmailChangeSection'
import { EmailVerificationSection } from '../auth/EmailVerificationSection'
import { PasswordChangeSection } from '../auth/PasswordChangeSection'
import { ProviderLinkSection } from '../auth/ProviderLinkSection'
import { MfaSection } from '../auth/MfaSection'
import { SessionSection } from '../auth/SessionSection'
import { AccountDeleteSection } from '../auth/AccountDeleteSection'
import { Icon } from '../Icon'
import { Modal } from '../Modal'
import { useConfirm } from '../ConfirmModal'
import { useNotificationCenter } from '../../lib/useNotificationCenter'
import { isSelfHostedEdition, isSelfHostedPathEnabled } from '../../lib/edition'
import { useSettingsDialog, type SettingsSection } from '../../lib/useSettingsDialog'
import { FaviconSection } from './FaviconSection'
import { NotificationsSection } from './NotificationsSection'
import { PrivacySection } from './PrivacySection'
import { ProfileSection } from './ProfileSection'

const sectionLabels: Record<SettingsSection, string> = {
  profile: 'Profile',
  bookmarks: 'Bookmarks',
  privacy: 'Privacy',
  favicon: 'Favicon',
  notifications: 'Notifications',
  security: 'Security',
}

const GO_TO_LINKS = [
  { to: '/creator', label: 'Publishing insights' },
  { to: '/credits', label: 'Credits and ledger' },
  { to: '/extension', label: 'Browser extension' },
  { to: '/export', label: 'Export library' },
] as const

export function SettingsDialog() {
  const { isOpen, section, close, open, sections } = useSettingsDialog()
  const { user } = useAuth()
  const notifications = useNotificationCenter({
    enabled: Boolean(user) && isNotificationExposureEnabled(),
    includePreference: true,
  })
  const mfaLive = isLive('mfa')
  // This server sends no email and has no sign-in providers (D28), so only
  // password, sessions, and account deletion apply.
  const selfHosted = isSelfHostedEdition()
  const goToLinks = GO_TO_LINKS.filter((link) => isSelfHostedPathEnabled(link.to))
  const navRef = useRef<HTMLElement | null>(null)
  // R14-45: profile edits survive a section switch or dialog close until
  // the user confirms the discard.
  const dirtyRef = useRef(false)
  const confirm = useConfirm()
  const guard = () => confirm({
    title: 'Discard changes?',
    body: 'You have unsaved changes on this page.',
    confirmLabel: 'Discard',
  })
  const guardedClose = () => {
    if (!dirtyRef.current) { close(); return }
    void guard().then((ok) => {
      if (ok) { dirtyRef.current = false; close() }
    })
  }

  // Phones lay the nav out as one scrolling strip: fade whichever edge still
  // hides tabs so a clipped "Notifications" reads as "scroll for more".
  const [fade, setFade] = useState({ start: false, end: false })
  useEffect(() => {
    const nav = navRef.current
    if (!nav || !isOpen) return
    const measure = () => {
      const max = nav.scrollWidth - nav.clientWidth
      const next = { start: max > 1 && nav.scrollLeft > 1, end: max > 1 && nav.scrollLeft < max - 1 }
      setFade((current) => (current.start === next.start && current.end === next.end ? current : next))
    }
    measure()
    nav.addEventListener('scroll', measure, { passive: true })
    window.addEventListener('resize', measure)
    return () => {
      nav.removeEventListener('scroll', measure)
      window.removeEventListener('resize', measure)
    }
  }, [isOpen])

  // Phones lay the nav out as one scrolling strip (studio.css) and the focus
  // trap focuses the current item with preventScroll, so bring it into view.
  useEffect(() => {
    const nav = navRef.current
    const current = nav?.querySelector<HTMLElement>('[aria-current="true"]')
    if (!nav || !current || nav.scrollWidth <= nav.clientWidth) return
    const navBox = nav.getBoundingClientRect()
    const box = current.getBoundingClientRect()
    if (box.left >= navBox.left && box.right <= navBox.right) return
    nav.scrollLeft += (box.left + box.right - navBox.left - navBox.right) / 2
  }, [isOpen, section])

  return (
    <Modal
      open={isOpen}
      onClose={guardedClose}
      label="Settings"
      chrome="bare"
      overlayClassName="modal-overlay"
      initialFocus='[data-settings-nav] [aria-current="true"]'
    >
      <div className="settings-dialog">
        {/* Phones only (studio.css): the full-screen sheet's title bar. */}
        <h2 className="settings-dialog-title">Settings</h2>
        <button
          type="button"
          className="modal-close settings-dialog-close"
          aria-label="Close settings"
          onClick={guardedClose}
        >
          <Icon name="cross" />
        </button>
        <aside
          ref={navRef}
          className="settings-nav"
          data-settings-nav
          data-fade-start={fade.start || undefined}
          data-fade-end={fade.end || undefined}
        >
          {sections.map((id) => (
            <button
              key={id}
              type="button"
              className="tree-item"
              aria-current={section === id ? 'true' : undefined}
              onClick={() => { if (!dirtyRef.current) { open(id); return } void guard().then((ok) => { if (ok) { dirtyRef.current = false; open(id) } }) }}
            >
              {sectionLabels[id]}
            </button>
          ))}
          {/* Page links, not settings: a separate "Go to" group with an
              outward arrow. No close-on-click — the dialog's open state lives
              in the ?settings= URL param, so navigating away closes it. */}
          <div className="settings-nav-goto" role="group" aria-labelledby="settings-nav-goto-label">
            <p className="section-label settings-nav-goto-label" id="settings-nav-goto-label">Go to</p>
            {goToLinks.map((link) => (
              <Link key={link.to} to={link.to} className="tree-item settings-nav-goto-link">
                <span>{link.label}</span>
                <Icon name="arrow-up-right" />
              </Link>
            ))}
          </div>
        </aside>
        <div className="settings-dialog-body">
          <AuthStatusRegion />
          {section === 'profile' && <ProfileSection onDirtyChange={(value) => { dirtyRef.current = value }} />}
          {section === 'bookmarks' && <BookmarkPreferencesSection />}
          {section === 'privacy' && <PrivacySection />}
          {section === 'favicon' && <FaviconSection />}
          {section === 'notifications' && <NotificationsSection notifications={notifications} />}
          {section === 'security' && (
            <div className="stack gap-1" data-testid="settings-security">
              <div className="settings-section-head">
                <h3 className="settings-toggle-label">Account security</h3>
                <p className="meta">
                  {selfHosted
                    ? 'Password, sessions, and account deletion.'
                    : <>Password, email verification, change email, sign-in providers{mfaLive ? ', two-factor authentication,' : ','} and sessions.</>}
                </p>
              </div>
              <hr className="divider" />
              <div className="security-sections" data-testid="security-sections">
                {!selfHosted && <EmailVerificationSection />}
                {!selfHosted && <EmailChangeSection />}
                <PasswordChangeSection />
                {mfaLive && <MfaSection />}
                {!selfHosted && <ProviderLinkSection />}
                <SessionSection />
                <AccountDeleteSection />
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}
