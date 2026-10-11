import { Link, useLocation } from 'react-router-dom'
import { BrandName } from './Brand'
import { useAuth } from '../auth/AuthContext'
import { loginPath } from '../lib/chrome'
import { useSettingsDialog } from '../lib/useSettingsDialog'

export function Footer() {
  const { isLoggedIn } = useAuth()
  const { open: openSettings } = useSettingsDialog()
  const location = useLocation()

  return (
    <footer className="site-footer site-footer--app">
      <div className="site-footer-inner site-footer-inner--app">
        <p className="site-footer-brand">
          <strong><BrandName /></strong>
          <span>Bookmarks on this server.</span>
          <span className="site-footer-powered">powered by Know-N</span>
        </p>
        <nav aria-label="Footer">
          {isLoggedIn ? (
            <>
              <button type="button" onClick={() => openSettings('profile')}>
                Settings
              </button>
              <Link to="/about">About</Link>
              <Link to="/agents">Agents</Link>
            </>
          ) : (
            // A visitor on someone's server (a shared collection link) can only sign in.
            <>
              <Link to={loginPath(location.pathname, location.search)}>Sign in</Link>
              <Link to="/about">About</Link>
            </>
          )}
        </nav>
      </div>
    </footer>
  )
}
