import { useEffect } from 'react'
import { publishUnreadCounts } from '../lib/unreadBadgeStore'
import { useCommunityNotificationCenter } from '../lib/useCommunityNotificationCenter'
import { useNotificationCenter } from '../lib/useNotificationCenter'

/**
 * Loaded lazily by Layout for signed-in visitors with a notification surface
 * (R15-27). One bell means "anything new to read": the activity and
 * community unread streams are merged, and both navs read the sum.
 */
export function UnreadBadgeFeed({ activity, community }: { activity: boolean; community: boolean }) {
  const notifications = useNotificationCenter({ enabled: activity, limit: 1 })
  const communityNotifications = useCommunityNotificationCenter({ enabled: community, limit: 1 })
  const activityUnread = activity ? notifications.unreadCount : 0
  const communityUnread = community ? communityNotifications.unreadCount : 0

  useEffect(() => {
    publishUnreadCounts({ activity: activityUnread, community: communityUnread })
  }, [activityUnread, communityUnread])
  useEffect(() => () => publishUnreadCounts({ activity: 0, community: 0 }), [])
  return null
}
