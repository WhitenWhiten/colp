import { Link, useLocation } from 'react-router-dom'
import { BrandName } from './Brand'
import { useAuth } from '../auth/AuthContext'
import { loginPath } from '../lib/chrome'
import { isSelfHostedEdition, isSelfHostedPathEnabled } from '../lib/edition'
import { useSettingsDialog } from '../lib/useSettingsDialog'

const guestProduct = [
  { to: '/explore', label: 'Explore' },
  { to: '/search', label: 'Search' },
]

const guestAccount = [
  { to: '/login', label: 'Log in' },
  { to: '/register', label: 'Get started' },
]

const guestTools = [
  { to: '/extension', label: 'Extension' },
  { to: '/developers', label: 'Developers' },
  { to: '/mcp', label: 'MCP' },
  { to: '/share', label: 'Share' },
  { to: '/onboarding', label: 'Start a collection' },
]

const guestLegal = [
  { to: '/about', label: 'About' },
  { to: '/contact', label: 'Contact' },
  { to: '/privacy', label: 'Privacy' },
]

function FooterNav({
  label,
  heading,
  links,
}: {
  label: string
  heading: string
  links: Array<{ to: string; label: string }>
}) {
  return (
    <nav aria-label={label}>
      <p className="site-footer-heading" data-testid="site-footer-heading">{heading}</p>
      {links.map((l) => (
        <Link key={l.to} to={l.to}>
          {l.label}
        </Link>
      ))}
    </nav>
  )
}

function enabledLinks(links: Array<{ to: string; label: string }>) {
  return links
    .filter((link) => isSelfHostedPathEnabled(link.to))
    .map((link) => (isSelfHostedEdition() && link.to === '/mcp' ? { to: '/agents', label: 'Agents' } : link))
}

export function Footer() {
  const { isLoggedIn, user } = useAuth()
  const { open: openSettings } = useSettingsDialog()
  const location = useLocation()
  const tagline = isSelfHostedEdition()
    ? 'Bookmarks on this server.'
    : 'Online bookmarks for public knowledge paths.'
  const poweredBy = isSelfHostedEdition()
    ? <span className="site-footer-powered">powered by Know-N</span>
    : null

  if (isLoggedIn) {
    return (
      <footer className="site-footer site-footer--app">
        <div className="site-footer-inner site-footer-inner--app">
          <p className="site-footer-brand">
            <strong><BrandName /></strong>
            <span>{tagline}</span>
            {poweredBy}
          </p>
          <nav aria-label="Footer">
            <button type="button" onClick={() => openSettings('profile')}>
              Settings
            </button>
            {user && isSelfHostedPathEnabled(`/u/${user.handle}`) ? <Link to={`/u/${user.handle}`}>Profile</Link> : null}
            <Link to="/about">About</Link>
            <Link to="/contact">Contact</Link>
            {isSelfHostedPathEnabled('/developers') ? <Link to="/developers">Developers</Link> : null}
            {isSelfHostedEdition() ? <Link to="/agents">Agents</Link> : <Link to="/mcp">MCP</Link>}
            <Link to="/privacy">Privacy</Link>
          </nav>
        </div>
      </footer>
    )
  }

  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <div className="site-footer-brand">
          <strong><BrandName /></strong>
          <span>{tagline}</span>
          {poweredBy}
        </div>
        <FooterNav label="Footer product" heading="Product" links={enabledLinks(guestProduct)} />
        <FooterNav
          label="Footer account"
          heading="Account"
          links={guestAccount.map((link) =>
            link.to === '/login'
              ? { ...link, to: loginPath(location.pathname, location.search) }
              : link,
          )}
        />
        <FooterNav label="Footer tools" heading="Tools" links={enabledLinks(guestTools)} />
        <FooterNav label="Legal" heading="Legal" links={guestLegal} />
      </div>
    </footer>
  )
}
