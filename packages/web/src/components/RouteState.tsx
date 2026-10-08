import { Link, useLocation } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { loginPath } from '../lib/chrome'
import { libraryFeatureUnavailable } from '../lib/libraryCopy'
import type { RouteFailureKind } from '../lib/classifyRouteError'
import { EmptyState, LoadingState } from './EmptyState'
import { productName } from '../lib/edition'

type RouteStateIcon = 'alert' | 'book' | 'search' | 'collection' | 'link' | 'folder' | 'bell' | 'compass'

type RouteStateProps = {
  kind: RouteFailureKind | 'loading'
  title?: string
  description?: string
  feature?: string
  icon?: RouteStateIcon
  onRetry?: () => void
  className?: string
  titleAs?: 'h1' | 'h3'
  loadingLabel?: string
  returnTo?: string
}

export function RouteState({
  kind,
  title,
  description,
  feature,
  icon = 'folder',
  onRetry,
  className,
  titleAs,
  loadingLabel,
  returnTo,
}: RouteStateProps) {
  const location = useLocation()
  const { sessionState, refreshSession } = useAuth()
  if (kind === 'loading') {
    return <LoadingState label={loadingLabel ?? title ?? 'Loading…'} />
  }

  if (kind === 'auth' && sessionState === 'offline') {
    /* R15-23: the session read failed, not the sign-in. Asking a signed-in
       visitor to sign in during an outage sends them down the wrong path. */
    return (
      <EmptyState
        className={className}
        role="alert"
        icon="alert"
        titleAs={titleAs}
        title={`${productName()} is unavailable right now`}
        description="We can't confirm your session. Retrying automatically; your library is safe."
        action={
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void refreshSession()}>
            Try again
          </button>
        }
      />
    )
  }

  if (kind === 'auth') {
    const loginTo = returnTo
      ? `/login?returnTo=${encodeURIComponent(returnTo)}`
      : loginPath(location.pathname, location.search)
    return (
      <EmptyState
        className={className}
        icon={icon}
        titleAs={titleAs}
        title={title ?? 'Sign in to continue'}
        description={description ?? 'You need to be signed in to open this page.'}
        action={
          <Link to={loginTo} className="btn btn-secondary btn-sm">
            Sign in
          </Link>
        }
      />
    )
  }

  if (kind === 'forbidden') {
    return (
      <EmptyState
        className={className}
        role="alert"
        icon={icon}
        titleAs={titleAs}
        title={title ?? 'You do not have access'}
        description={description ?? 'This page is limited to people the owner has shared it with.'}
      />
    )
  }

  if (kind === 'unavailable') {
    return (
      <EmptyState
        className={className}
        icon={icon}
        titleAs={titleAs}
        title={title ?? 'This feature is not available yet'}
        description={description ?? (feature ? libraryFeatureUnavailable(feature) : undefined)}
      />
    )
  }

  return (
    <EmptyState
      className={className}
      role="alert"
      icon={icon}
      titleAs={titleAs}
      title={title ?? "Couldn't load this page"}
      description={description ?? 'Check your connection and try again.'}
      action={
        onRetry ? (
          <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>
            Try again
          </button>
        ) : undefined
      }
    />
  )
}
