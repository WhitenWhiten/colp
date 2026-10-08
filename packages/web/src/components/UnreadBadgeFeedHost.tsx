import { Suspense } from 'react'
import { isCommunityExposureEnabled, isNotificationExposureEnabled } from '../api'
import { useAuth } from '../auth/AuthContext'
import { lazyWithRetry } from '../lib/lazyWithRetry'

const UnreadBadgeFeed = lazyWithRetry('UnreadBadgeFeed', async () => (await import('./UnreadBadgeFeed')).UnreadBadgeFeed)

/** Mounts the unread feed once, only for a signed-in visitor (R15-27). */
export function UnreadBadgeFeedHost() {
  const { isLoggedIn, user } = useAuth()
  const activity = isLoggedIn && isNotificationExposureEnabled()
  const community = isLoggedIn && isCommunityExposureEnabled()
  if (!activity && !community) return null
  return (
    <Suspense fallback={null}>
      {/* Keyed by account so a sign-in switch starts from zero. */}
      <UnreadBadgeFeed key={user?.accountId ?? ''} activity={activity} community={community} />
    </Suspense>
  )
}
