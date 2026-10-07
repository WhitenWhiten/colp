import { useCallback, useState } from 'react'
import { AvatarImage } from '../../components/AvatarImage'
import { ClampedText } from '../../components/ClampedText'
import { PageHead } from '../../components/PageHead'
import { ReportButton } from '../../components/ReportContentDialog'
import { SocialActions } from '../../components/SocialActions'
import { TabList } from '../../components/TabList'
import { FollowButton } from '../../components/FollowButton'
import { useToast } from '../../components/AppToast'
import { copyTextToClipboard } from '../../lib/clipboard'
import { useSettingsDialog } from '../../lib/useSettingsDialog'
import { useAuth } from '../../auth/AuthContext'
import type { PublicProfilePage } from '../../api'
import { JournalCollectionList, ProfileCollectionGrid } from './CollectionGrid'
import {
  collectionCountLabel,
  formatProfileDate,
  loadProfileMode,
  profileInitials,
} from './helpers'
import { JournalSidebar } from './JournalSidebar'
import { JournalToolbar, ProfileFollowStats } from './JournalToolbar'
import { ActivityPanel, FollowGraphPanel } from './panels'
import type { ProfileMode, ProfileTab } from './types'
import type { ProfilePageData } from './useProfileData'

export function ProfileReadyView({
  handle,
  page,
  isLoggedIn,
  canReadFollowGraph,
  data,
}: {
  handle: string
  page: PublicProfilePage
  isLoggedIn: boolean
  canReadFollowGraph: boolean
  data: ProfilePageData
}) {
  const [mode, setMode] = useState<ProfileMode>(loadProfileMode)
  const { toast, error } = useToast()
  const { profile, collections } = page
  const { user } = useAuth()
  const { open: openSettings } = useSettingsDialog()
  // The owner edits their profile; following or reporting yourself is noise.
  const isOwner = Boolean(user && (
    (profile.profileId && user.profileId === profile.profileId)
    || user.handle.toLowerCase() === profile.handle.toLowerCase()
  ))
  const editProfile = isOwner ? (
    <button type="button" className="btn btn-secondary btn-sm" onClick={() => openSettings('profile')}>Edit profile</button>
  ) : null
  const heading = profile.displayName.trim() || `@${profile.handle}`
  const initials = profileInitials(profile.displayName, profile.handle)
  const collectionCount = collectionCountLabel(collections.length, page.page.hasMore)
  // R9-31 parity with the collection masthead: no about → no bio node at
  // all. A bare '-' used to stand in for missing content on both displays.
  const about = profile.about?.trim() ? profile.about : ''

  const changeMode = useCallback((next: ProfileMode) => {
    setMode(next)
    try {
      window.localStorage.setItem('known.profileMode', next)
    } catch {
      /* ignore */
    }
  }, [])

  const shareProfile = useCallback(async () => {
    const url = window.location.href
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Know-N profile', url })
        return
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return
      }
    }
    try {
      await copyTextToClipboard(url)
      toast('Profile link copied')
    } catch {
      error("Couldn't copy the profile link")
    }
  }, [toast, error])

  const viewAllFollowing = useCallback(() => {
    changeMode('profile')
    data.setTab('following')
  }, [changeMode, data])

  return (
    <div className={`profile-page profile-page--${mode}`} data-testid="public-profile-page">
      <div className="profile-inner">
        <div className="profile-modebar rise">
          <span className="profile-modebar-label">Display</span>
          {/* R10-20: view modes are tabs (tablist), filters are rails
              (radiogroup) — see PRODUCT.md "Switch semantics". */}
          <TabList<ProfileMode>
            className="view-switch"
            label="Profile display mode"
            value={mode}
            options={[
              { id: 'profile', label: 'Profile' },
              { id: 'journal', label: 'Journal' },
            ]}
            tabIdFor={(id) => `profile-mode-tab-${id}`}
            panelIdFor={(id) => `profile-mode-panel-${id}`}
            onChange={changeMode}
          />
        </div>

        {mode === 'profile' ? (
          <div id="profile-mode-panel-profile" role="tabpanel" aria-labelledby="profile-mode-tab-profile">
            {/* The hero is the same editorial + social masthead the collection
                and digest pages render: avatar | copy | social cluster, with
                the stat row spanning below between fading hairlines. */}
            <PageHead
              as="header"
              layout="masthead"
              className="profile-hero page-head--editorial page-head--social rise"
              data-testid="profile-hero"
              documentTitle={heading}
              avatar={
                <span className="profile-public-avatar" aria-hidden="true" data-testid="profile-avatar">
                  {/* R9-31: shared AvatarImage owns the failure fallback (it
                      resets when the url/handle changes) — no local state. */}
                  <AvatarImage
                    url={profile.avatarUrl}
                    initials={initials}
                    fallbackClassName="profile-public-avatar-fallback"
                  />
                </span>
              }
              title={heading}
              afterTitle={profile.displayName.trim() ? <span className="handle-text profile-handle">@{profile.handle}</span> : null}
              actions={
                <SocialActions
                  className="profile-actions"
                  follow={editProfile ?? <FollowButton targetProfileId={profile.profileId} signInPrompt />}
                  links={
                    <>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => void shareProfile()}>Share</button>
                      {/* A public profile id is the account id the report API takes. */}
                      {profile.profileId && !isOwner ? (
                        <ReportButton
                          target={{ kind: 'account', id: profile.profileId }}
                          label="this profile"
                          testId="report-profile"
                        />
                      ) : null}
                    </>
                  }
                />
              }
              stats={
                <ProfileFollowStats
                  collectionCount={collectionCount}
                  followers={data.followers}
                  following={data.following}
                  onFollowers={() => data.setTab('followers')}
                  onFollowing={() => data.setTab('following')}
                />
              }
            >
              {about && (
                <ClampedText
                  text={about}
                  className="lede profile-bio"
                  wrapperClassName="profile-bio-wrap"
                  toggleClassName="profile-bio-toggle"
                  textProps={{ 'data-profile-field': 'bio' }}
                />
              )}
            </PageHead>

            <TabList<ProfileTab>
              label="Profile sections"
              className="tab-rail"
              value={data.tab}
              options={[
                { id: 'collections', label: 'Collections' },
                { id: 'activity', label: 'Activity' },
                { id: 'following', label: 'Following' },
                { id: 'followers', label: 'Followers' },
              ]}
              tabIdFor={(id) => `profile-tab-${id}`}
              panelIdFor={(id) => `profile-panel-${id}`}
              onChange={data.setTab}
            />

            {data.tab === 'collections' && (
              <div id="profile-panel-collections" role="tabpanel" aria-labelledby="profile-tab-collections">
                <ProfileCollectionGrid
                  collections={collections}
                  heading={heading}
                  pagination={data.pagination}
                  page={page.page}
                  onRegisterLink={(id, node) => {
                    if (node) data.collectionLinks.current.set(id, node)
                    else data.collectionLinks.current.delete(id)
                  }}
                  onLoadMore={() => void data.loadMore()}
                />
              </div>
            )}
            {data.tab === 'activity' && (
              <div id="profile-panel-activity" role="tabpanel" aria-labelledby="profile-tab-activity">
                <ActivityPanel
                  list={data.activity}
                  onRetry={data.retryActivity}
                  onLoadMore={() => void data.loadMoreActivity()}
                />
              </div>
            )}
            {data.tab === 'following' && (
              <div id="profile-panel-following" role="tabpanel" aria-labelledby="profile-tab-following">
                <FollowGraphPanel
                  kind="following"
                  list={data.following}
                  canRead={canReadFollowGraph}
                  isLoggedIn={isLoggedIn}
                  onRetry={data.retryFollowLists}
                  onLoadMore={() => void data.loadMoreFollowList('following')}
                />
              </div>
            )}
            {data.tab === 'followers' && (
              <div id="profile-panel-followers" role="tabpanel" aria-labelledby="profile-tab-followers">
                <FollowGraphPanel
                  kind="followers"
                  list={data.followers}
                  canRead={canReadFollowGraph}
                  isLoggedIn={isLoggedIn}
                  onRetry={data.retryFollowLists}
                  onLoadMore={() => void data.loadMoreFollowList('followers')}
                />
              </div>
            )}
          </div>
        ) : (
          <div className="journal-profile" id="profile-mode-panel-journal" role="tabpanel" aria-labelledby="profile-mode-tab-journal" data-testid="journal-profile">
            <header className="journal-masthead rise">
              <div className="journal-masthead-rule">
                <span>Public collections and notes</span>
                <span>{collections[0] ? `Updated ${formatProfileDate(collections[0].updatedAt)}` : 'Nothing published yet'}</span>
              </div>
              {/* The nameplate is the one place the journal shows the bio: it
                  reads as the standfirst under the name, so the sidebar keeps
                  to what the nameplate does not already say. */}
              <PageHead
                layout="masthead"
                className="journal-intro"
                documentTitle={heading}
                eyebrow={<>@{profile.handle} / Know-N journal</>}
                title={heading}
                actions={
                  <span className="journal-monogram" aria-hidden="true" data-testid="journal-monogram">
                    <AvatarImage url={profile.avatarUrl} initials={initials} />
                  </span>
                }
                stats={
                  <JournalToolbar
                    collectionCount={collectionCount}
                    followers={data.followers}
                    following={data.following}
                    profileId={profile.profileId}
                    ownerAction={editProfile}
                    onShare={() => void shareProfile()}
                  />
                }
              >
                {about && <p className="journal-bio" data-profile-field="bio" dir="auto">{about}</p>}
              </PageHead>
            </header>
            <div className="journal-layout">
              <JournalCollectionList collections={collections} collectionCount={collectionCount} />
              <JournalSidebar
                collections={collections}
                hasMore={page.page.hasMore}
                following={data.following}
                canReadFollowGraph={canReadFollowGraph}
                isLoggedIn={isLoggedIn}
                onViewAllFollowing={viewAllFollowing}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
