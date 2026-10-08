import { useParams } from 'react-router-dom'
import { ABSENCE_CORNERS, AbsenceStage } from '../components/AbsenceStage'
import { EmptyState } from '../components/EmptyState'
import { RouteLoading } from '../components/RouteLoading'
import { isFollowExposureEnabled } from '../api'
import { useAuth } from '../auth/AuthContext'
import { useDocumentTitle } from '../lib/useDocumentTitle'
import { usePageMeta } from '../lib/usePageMeta'
import { normalizePageMetaText } from '../lib/pageMetaText'
import { useProfileData } from './profile/useProfileData'
import { ProfileReadyView } from './profile/view'
// Route-owned stylesheet (see main.tsx); ships with this chunk.
import '../styles/not-found.css'
import '../styles/profile.css'

export function Profile() {
  const { handle = '' } = useParams()
  const { isLoggedIn, bootstrapping } = useAuth()
  const followExposed = isFollowExposureEnabled()
  const canReadFollowGraph = followExposed && isLoggedIn && !bootstrapping
  const data = useProfileData(handle, canReadFollowGraph)
  const { state, retry } = data

  const documentTitle =
    state.status === 'ready'
      ? (state.value.profile.displayName.trim() || `@${state.value.profile.handle}`)
      : state.status === 'not-found'
        ? 'Profile unavailable'
        : state.status === 'error'
          ? 'Profile error'
          : 'Profile'
  useDocumentTitle(documentTitle)
  const readyPage = state.status === 'ready' ? state.value : null
  const normalizedBio = normalizePageMetaText(readyPage?.profile.about ?? '')
  const profileDescription = readyPage
    ? normalizedBio || (readyPage.page.hasMore
      ? 'Public collections on Know-N'
      : `${readyPage.collections.length} public ${readyPage.collections.length === 1 ? 'collection' : 'collections'} on Know-N`)
    : undefined
  usePageMeta(
    // R15-22: a transient error (429, 503) leaves the head alone; only an
    // unavailable or missing page is noindexed.
    state.status === 'loading' || state.status === 'error'
      ? {}
      : readyPage
        ? {
            description: profileDescription,
            canonicalPath: `/u/${encodeURIComponent(readyPage.profile.handle)}`,
          }
        : { canonicalPath: null, robots: 'noindex' },
    `${documentTitle} — Know-N`,
  )

  if (state.status === 'loading') {
    return <RouteLoading label="Loading profile…" />
  }

  if (state.status === 'not-found') {
    return (
      <AbsenceStage
        title="Profile unavailable"
        description="This profile does not exist or is not publicly available."
        corners={ABSENCE_CORNERS.profile}
        exits={[{ to: '/', label: 'Back home' }, { to: '/explore', label: 'Explore' }]}
      />
    )
  }

  if (state.status === 'error') {
    return (
      <div className="profile-page profile-public-state">
        <EmptyState
          role="alert"
          titleAs="h1"
          icon="alert"
          title="Couldn't load this profile"
          description="Check your connection and try again."
          action={<button type="button" className="btn btn-secondary btn-sm" onClick={retry}>Try again</button>}
        />
      </div>
    )
  }

  return (
    <ProfileReadyView
      handle={handle}
      page={state.value}
      isLoggedIn={isLoggedIn}
      canReadFollowGraph={canReadFollowGraph}
      data={data}
    />
  )
}
