import { Link } from 'react-router-dom'
import { isFollowExposureEnabled } from '../api'
import { useAuth } from '../auth/AuthContext'
import { useFollowWorkflow } from '../lib/useFollowWorkflow'
import { FollowWorkflowButton } from './FollowWorkflowButton'

export function FollowButton({ targetProfileId, className, signInPrompt }: {
  targetProfileId: string | null | undefined
  className?: string
  signInPrompt?: boolean
}) {
  const { user, isLoggedIn, bootstrapping } = useAuth()
  const exposed = isFollowExposureEnabled()
  const enabled = exposed && isLoggedIn && !bootstrapping
    && !!targetProfileId && user?.profileId !== targetProfileId
  const workflow = useFollowWorkflow({
    actorProfileId: enabled ? user?.profileId ?? null : null,
    targetProfileId: enabled ? targetProfileId ?? null : null,
    enabled,
  })

  if (signInPrompt && exposed && !bootstrapping && !isLoggedIn && targetProfileId) {
    // Same-origin path only, matching the safeReturnTo convention on /login.
    const returnTo = `${window.location.pathname}${window.location.search}`
    return (
      <Link
        to={`/login?returnTo=${encodeURIComponent(returnTo)}`}
        className={`btn btn-secondary follow-btn${className ? ` ${className}` : ''}`}
        data-testid="profile-follow-signin"
      >
        Sign in to follow
      </Link>
    )
  }

  if (!enabled) return null

  return <FollowWorkflowButton workflow={workflow} className={className} />
}
