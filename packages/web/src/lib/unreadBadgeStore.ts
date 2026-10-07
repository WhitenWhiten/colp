import { useSyncExternalStore } from 'react'

/**
 * R15-27: the merged unread count behind the notification bell (TopNav)
 * and the mobile tab badge (BottomNav). One lazily loaded feed
 * (components/UnreadBadgeFeed) runs the notification hooks and publishes
 * here, so the hooks stay out of the entry chunk and run once, not once
 * per nav. The per-inbox split is kept so the Notifications page can show
 * how the merged number breaks down across its Activity / Community tabs.
 */
export type UnreadBreakdown = { activity: number; community: number }

let breakdown: UnreadBreakdown = { activity: 0, community: 0 }
let unread = 0
const listeners = new Set<() => void>()

export function publishUnreadCounts(next: UnreadBreakdown) {
  if (next.activity === breakdown.activity && next.community === breakdown.community) return
  breakdown = { activity: next.activity, community: next.community }
  unread = next.activity + next.community
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const read = () => unread
const readServer = () => 0
const readBreakdown = () => breakdown
const EMPTY_BREAKDOWN: UnreadBreakdown = { activity: 0, community: 0 }
const readBreakdownServer = () => EMPTY_BREAKDOWN

export function useUnreadCount(): number {
  return useSyncExternalStore(subscribe, read, readServer)
}

export function useUnreadBreakdown(): UnreadBreakdown {
  return useSyncExternalStore(subscribe, readBreakdown, readBreakdownServer)
}
