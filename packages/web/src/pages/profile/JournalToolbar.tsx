import type { ReactNode } from 'react'
import { FollowButton } from '../../components/FollowButton'
import { followCountLabel } from './helpers'
import type { FollowListState } from './types'

function collectionsNoun(count: string): string {
  return count === '1' ? 'collection' : 'collections'
}

/* Hero stat row: the shared .stat-row anatomy the collection masthead uses,
   with the follower / following counts doubling as jumps to their tabs. */
export function ProfileFollowStats({
  collectionCount,
  followers,
  following,
  onFollowers,
  onFollowing,
}: {
  collectionCount: string | null
  followers: FollowListState
  following: FollowListState
  onFollowers: () => void
  onFollowing: () => void
}) {
  const followerLabel = followCountLabel(followers)
  const followingLabel = followCountLabel(following)
  return (
    <ul className="stat-row profile-stats" aria-label="Profile statistics">
      {collectionCount != null && (
        <li><strong>{collectionCount}</strong> public {collectionsNoun(collectionCount)}</li>
      )}
      {followerLabel != null && (
        <li>
          <button
            type="button"
            className="profile-stat-btn"
            aria-controls="profile-followers-panel"
            onClick={() => {
              onFollowers()
              requestAnimationFrame(() => document.getElementById('profile-followers-panel')?.focus())
            }}
          >
            <strong data-profile-field="followers">{followerLabel}</strong> {followerLabel === '1' ? 'follower' : 'followers'}
          </button>
        </li>
      )}
      {followingLabel != null && (
        <li>
          <button
            type="button"
            className="profile-stat-btn"
            aria-controls="profile-following-panel"
            onClick={() => {
              onFollowing()
              requestAnimationFrame(() => document.getElementById('profile-following-panel')?.focus())
            }}
          >
            <strong data-profile-field="following">{followingLabel}</strong> following
          </button>
        </li>
      )}
    </ul>
  )
}

/* Journal nameplate strip: the same stat anatomy in the journal's voice,
   with the follow + share cluster on the trailing edge. */
export function JournalToolbar({
  collectionCount,
  followers,
  following,
  profileId,
  ownerAction,
  onShare,
}: {
  collectionCount: string | null
  followers: FollowListState
  following: FollowListState
  profileId: string | null | undefined
  /** Replaces Follow when the viewer owns this profile. */
  ownerAction?: ReactNode
  onShare: () => void
}) {
  const readers = followCountLabel(followers)
  const followingCount = followCountLabel(following)
  return (
    <div className="journal-toolbar">
      <ul className="stat-row journal-stats" aria-label="Profile statistics">
        {collectionCount != null && (
          <li><strong>{collectionCount}</strong> {collectionsNoun(collectionCount)}</li>
        )}
        {readers != null && (
          <li><strong data-profile-field="journal-readers">{readers}</strong> {readers === '1' ? 'reader' : 'readers'}</li>
        )}
        {followingCount != null && (
          <li><strong data-profile-field="journal-following">{followingCount}</strong> following</li>
        )}
      </ul>
      <div className="journal-actions">
        {ownerAction ?? <FollowButton targetProfileId={profileId} signInPrompt />}
        <button type="button" className="btn btn-ghost btn-sm" onClick={onShare}>Share</button>
      </div>
    </div>
  )
}
