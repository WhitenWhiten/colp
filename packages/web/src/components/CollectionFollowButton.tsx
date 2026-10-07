import { useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { isCollectionFollowExposureEnabled } from '../api'
import { useAuth } from '../auth/AuthContext'
import { useCollectionFollowWorkflow } from '../lib/useCollectionFollowWorkflow'
import { SubscriptionFollowButton } from './bookmark-subscriptions/SubscriptionFollowButton'

export type CollectionFollowAuthority = {
  following: boolean
  followerCount: number
}

export function CollectionFollowButton({ collectionId, ownerHandle, className, onState }: {
  collectionId: string | null | undefined
  ownerHandle?: string | null
  className?: string
  onState?: (state: CollectionFollowAuthority | null) => void
}) {
  const { user, isLoggedIn, bootstrapping } = useAuth()
  const exposed = isCollectionFollowExposureEnabled()
  const canCompareOwner = Boolean(ownerHandle && user?.handle)
  const isOwner = canCompareOwner && ownerHandle === user?.handle
  const canRead = exposed && isLoggedIn && !bootstrapping && !!collectionId
  const canToggle = canRead && !isOwner
  const workflow = useCollectionFollowWorkflow({
    actorProfileId: canRead ? user?.profileId ?? null : null,
    collectionId: canRead ? collectionId ?? null : null,
    enabled: canRead,
  })
  const onStateRef = useRef(onState)
  onStateRef.current = onState

  useEffect(() => {
    if (workflow.status === 'unavailable') {
      onStateRef.current?.(null)
      return
    }
    if (workflow.followerCount != null && workflow.status !== 'loading' && workflow.status !== 'pending') {
      onStateRef.current?.({ following: workflow.following, followerCount: workflow.followerCount })
    }
  }, [workflow.followerCount, workflow.following, workflow.status])

  if (exposed && !bootstrapping && !isLoggedIn && collectionId) {
    // Same-origin path only, matching the safeReturnTo convention on /login.
    const returnTo = `${window.location.pathname}${window.location.search}`
    return (
      <Link
        to={`/login?returnTo=${encodeURIComponent(returnTo)}`}
        className={`btn btn-secondary follow-btn${className ? ` ${className}` : ''}`}
        data-testid="collection-follow-signin"
      >
        Sign in to follow
      </Link>
    )
  }

  if (!canToggle || workflow.status === 'unavailable') return null

  return <SubscriptionFollowButton source={{ sourceType: 'collection', sourceId: collectionId! }} workflow={workflow} className={className} testId="collection-follow" />
}
