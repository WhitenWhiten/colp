import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { BrandName } from '../components/Brand'
import { useToast } from '../components/AppToast'
import { Icon } from '../components/Icon'
import { useAuth } from '../auth/AuthContext'
import { authClient } from '../api/authClient'
import { isProductApiError } from '../api/errors'
import { consentScopeMeta, groupScopes } from '../lib/oauthScopes'
import { plural } from '../lib/plural'
import { useDocumentTitle } from '../lib/useDocumentTitle'
import { safeReturnTo } from './safeReturnTo'
import { productName } from '../lib/edition'
import { SETTINGS_PARAM } from '../lib/useSettingsDialog'
import '../styles/auth-pages.css'

export { consentScopeLabel } from '../lib/oauthScopes'

function parseRequestedClaims(raw: string | null): string | Record<string, unknown> | undefined {
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return raw
  }
}

function consentResumePath(search: string): string {
  const next = new URLSearchParams(search)
  next.delete('returnTo')
  const query = next.toString()
  return safeReturnTo(query ? `/consent?${query}` : '/consent')
}

function requestedScopes(scopeParam: string): string[] {
  return scopeParam.split(/\s+/u).map((scope) => scope.trim()).filter(Boolean)
}

function authErrorMessage(err: unknown, fallback: string): string {
  if (isProductApiError(err)) {
    if (err.code === 'rate_limited') {
      return err.retryAfterSeconds != null
        ? `Too many requests. Try again in ${err.retryAfterSeconds}s.`
        : 'Too many requests. Try again shortly.'
    }
    if (err.code === 'transport_error') return 'Network error. Check your connection and try again.'
    return err.recoveryHint || err.message
  }
  return fallback
}

/** Hostname (plus non-default port) from a server-verified http(s) redirect URI. */
export function consentRedirectHost(redirectUri: string): string | null {
  try {
    const url = new URL(redirectUri)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    if (!url.hostname) return null
    return url.host
  } catch {
    return null
  }
}

export function Consent() {
  useDocumentTitle('Authorize application')
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { user, isLoggedIn, bootstrapping } = useAuth()
  const { error: toastError } = useToast()
  // Settings belongs to the page chrome, not the signed OAuth transaction.
  // Exclude it from both metadata loading and consent submission.
  const oauthParams = new URLSearchParams(searchParams)
  oauthParams.delete(SETTINGS_PARAM)
  const queryString = oauthParams.toString()
  const clientId = searchParams.get('client_id') ?? ''
  const scopeParam = searchParams.get('scope') ?? ''
  // Never seed the display name from the query string: an attacker-crafted
  // /consent link could impersonate another client. Hold the prompt until
  // issuer-verified metadata settles, then fall back to client_id.
  // Never display query `redirect_uri` either — only a server-verified,
  // signature-bound URI from the consent-transaction lookup.
  const [clientName, setClientName] = useState('')
  const [redirectUri, setRedirectUri] = useState('')
  const [nameReady, setNameReady] = useState(() => !clientId)
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null)
  const inFlightRef = useRef(false)
  const scopes = useMemo(() => requestedScopes(scopeParam), [scopeParam])
  const resumePath = useMemo(() => consentResumePath(queryString), [queryString])
  const displayName = clientName || clientId || 'this application'
  const redirectHost = useMemo(() => (redirectUri ? consentRedirectHost(redirectUri) : null), [redirectUri])
  const accountLabel = user?.username || user?.email || user?.name || ''

  useEffect(() => {
    if (bootstrapping) return
    if (!isLoggedIn) {
      navigate(`/login?returnTo=${encodeURIComponent(resumePath)}`, { replace: true })
    }
  }, [bootstrapping, isLoggedIn, navigate, resumePath])

  useEffect(() => {
    if (bootstrapping) return
    if (!clientId) {
      setClientName('')
      setRedirectUri('')
      setNameReady(true)
      return
    }
    if (!isLoggedIn) return
    let cancelled = false
    setClientName('')
    setRedirectUri('')
    setNameReady(false)
    void authClient.getOAuthConsentTransaction({ oauthQuery: queryString }).then((transaction) => {
      if (cancelled) return
      const name = transaction.client_name?.trim()
      if (name) setClientName(name)
      const uri = transaction.redirect_uri?.trim()
      if (uri) setRedirectUri(uri)
      setNameReady(true)
    }).catch(() => {
      // Keep the client_id fallback. Consent still posts to BA. Never fall
      // back to the unsigned query redirect_uri.
      if (!cancelled) {
        setRedirectUri('')
        setNameReady(true)
      }
    })
    return () => {
      cancelled = true
    }
  }, [bootstrapping, isLoggedIn, clientId, queryString])

  const decide = async (accept: boolean) => {
    if (inFlightRef.current) return
    inFlightRef.current = true
    setBusy(accept ? 'approve' : 'deny')
    try {
      const claims = parseRequestedClaims(searchParams.get('claims'))
      const result = await authClient.submitOAuthConsent({
        accept,
        ...(scopeParam ? { scope: scopeParam } : {}),
        ...(claims === undefined ? {} : { claims }),
        oauth_query: queryString,
      })
      if (result.redirect && result.url) {
        const loc = (globalThis as { location?: { assign?: (url: string) => void } }).location
        if (loc && typeof loc.assign === 'function') {
          loc.assign(result.url)
          return
        }
      }
    } catch (err) {
      toastError(authErrorMessage(err, 'Could not complete authorization. Try again.'))
    } finally {
      inFlightRef.current = false
      setBusy(null)
    }
  }

  if (bootstrapping || (isLoggedIn && !nameReady)) {
    return (
      <div className="auth-page">
        <div className="auth-card auth-card--consent rise">
          <p className="auth-brand"><BrandName /></p>
          <p className="section-label">Authorization</p>
          <h1>{bootstrapping ? 'Checking your session…' : 'Looking up this application…'}</h1>
        </div>
      </div>
    )
  }

  if (!isLoggedIn) return null

  const groups = groupScopes(scopes)
  const initial = Array.from(displayName.trim())[0]?.toUpperCase() ?? '?'

  return (
    <div className="auth-page">
      <div className="auth-card auth-card--consent rise">
        <p className="auth-brand"><BrandName /></p>
        <div className="consent-head">
          <span className="consent-client-mark" aria-hidden>{initial}</span>
          <div className="consent-head-copy">
            <p className="section-label">Authorization</p>
            <h1>Allow {displayName}?</h1>
          </div>
        </div>
        <p className="sub">
          {displayName} is requesting access to your {productName()} account. It will be able to:
        </p>
        {groups.length > 0 ? (
          <ul className="consent-groups">
            {groups.map((group) => (
              <li key={group.id} className="consent-group" data-group={group.id}>
                <span className="consent-group-icon" aria-hidden><Icon name={group.icon} /></span>
                <span className="consent-group-body">
                  <span className="consent-group-name">{group.name}</span>
                  <span className="consent-group-desc">{group.label}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="sub">No specific scopes were listed in this request.</p>
        )}
        {scopes.length > 0 || redirectUri ? (
          <details className="consent-details">
            <summary>
              <Icon name="chevron-right" />
              {scopes.length > 0 ? `Show all ${plural(scopes.length, 'permission')}` : 'Show details'}
            </summary>
            {scopes.length > 0 ? (
              <ul className="auth-consent-scopes">
                {scopes.map((scope) => {
                  const meta = consentScopeMeta(scope)
                  return (
                    <li key={scope} className="auth-consent-scope">
                      <span className="auth-consent-scope-body">
                        <span className="auth-consent-scope-name">{meta?.name ?? 'Unrecognized permission'}</span>
                        {meta ? <span className="auth-consent-scope-desc">{meta.label}</span> : null}
                      </span>
                      <code className="auth-consent-scope-raw">{scope}</code>
                    </li>
                  )
                })}
              </ul>
            ) : null}
            {redirectUri ? (
              <p className="consent-redirect-uri">
                Redirect address <code>{redirectUri}</code>
              </p>
            ) : null}
          </details>
        ) : null}
        {redirectUri ? (
          <p className="consent-redirect">
            After you approve, an authorization code will be sent to
            {' '}
            <strong>{redirectHost ?? redirectUri}</strong>
            .
          </p>
        ) : null}
        <div className="auth-consent-actions">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy !== null}
            onClick={() => {
              void decide(false)
            }}
          >
            {busy === 'deny' ? 'Denying…' : 'Deny'}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy !== null}
            onClick={() => {
              void decide(true)
            }}
          >
            {busy === 'approve' ? 'Approving…' : 'Approve'}
          </button>
        </div>
        <p className="auth-consent-account">
          {accountLabel ? <>Authorizing as <strong>{accountLabel}</strong>. </> : null}
          Revoke access any time on <Link to="/agents">Agents</Link>.
        </p>
      </div>
    </div>
  )
}
