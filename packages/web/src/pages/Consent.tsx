import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { BrandName } from '../components/Brand'
import { useToast } from '../components/AppToast'
import { Icon } from '../components/Icon'
import { useAuth } from '../auth/AuthContext'
import { authClient } from '../api/authClient'
import { isProductApiError } from '../api/errors'
import { consentScopeMeta } from '../lib/oauthScopes'
import { useDocumentTitle } from '../lib/useDocumentTitle'
import { safeReturnTo } from './safeReturnTo'
import { productName } from '../lib/edition'
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
  const queryString = searchParams.toString()
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
  const accountLabel = user?.email ?? user?.name ?? ''

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
        <div className="auth-card rise">
          <p className="auth-brand"><BrandName /></p>
          <p className="section-label">Authorization</p>
          <h1>{bootstrapping ? 'Checking your session…' : 'Looking up this application…'}</h1>
        </div>
      </div>
    )
  }

  if (!isLoggedIn) return null

  return (
    <div className="auth-page">
      <div className="auth-card rise">
        <p className="auth-brand"><BrandName /></p>
        <p className="section-label">Authorization</p>
        <h1>Allow {displayName}?</h1>
        <p className="sub">
          {displayName} is requesting access to your {productName()} account with these permissions:
        </p>
        {scopes.length > 0 ? (
          <ul className="auth-consent-scopes">
            {scopes.map((scope) => {
              const meta = consentScopeMeta(scope)
              return (
                <li key={scope} className="auth-consent-scope">
                  <span className="auth-consent-scope-icon">
                    <Icon name={meta?.icon ?? 'info'} />
                  </span>
                  <span className="auth-consent-scope-body">
                    {meta ? (
                      <>
                        <span className="auth-consent-scope-name">{meta.name}</span>
                        <span className="auth-consent-scope-desc">{meta.label}</span>
                        <code className="auth-consent-scope-raw">{scope}</code>
                      </>
                    ) : (
                      <code className="auth-consent-scope-raw auth-consent-scope-raw--solo">{scope}</code>
                    )}
                  </span>
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="sub">No specific scopes were listed in this request.</p>
        )}
        {redirectUri ? (
          <p className="sub auth-consent-redirect">
            {redirectHost
              ? (
                <>
                  After you approve, an authorization code will be sent to <strong>{redirectHost}</strong>
                  {' '}
                  (
                  <code>{redirectUri}</code>
                  ).
                </>
              )
              : (
                <>
                  After you approve, an authorization code will be sent to
                  {' '}
                  <code>{redirectUri}</code>
                  .
                </>
              )}
          </p>
        ) : null}
        {accountLabel ? (
          <p className="auth-consent-account">
            Authorizing as <strong>{accountLabel}</strong>
          </p>
        ) : null}
        <div className="auth-consent-actions">
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
        </div>
      </div>
    </div>
  )
}
