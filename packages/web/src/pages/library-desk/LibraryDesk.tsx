import { useEffect, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useToast } from '../../components/AppToast'
import { useCancelConfirm } from '../../components/ConfirmModal'
import { EmptyState, LoadingState } from '../../components/EmptyState'
import { PageShell } from '../../components/PageShell'
import { RouteLoading } from '../../components/RouteLoading'
import { RouteState } from '../../components/RouteState'
import { useAuth } from '../../auth/AuthContext'
import {
  isCollectionFollowExposureEnabled,
  isLive,
  isProductApiError,
  isReportsExposureEnabled,
} from '../../api'
import { persistDeskCache, useLibraryDeskData } from './data'
import { useLibraryLayerReorder } from './layerReorder'
import { useLibraryDeskMutations } from './mutations'
import { useLibraryDeskOrder } from './ordering'
import { useLibraryDeskSelection } from './selection'
import { CollectionSettingsSheet } from './CollectionSettingsSheet'
import { LibraryDeskView } from './view'
import { NodeEditDrawer } from './NodeEditDrawer'
import { useDocumentTitle } from '../../lib/useDocumentTitle'
import { useFollowedCollections } from '../../lib/useFollowedCollections'
import { useFollowedReports } from '../../lib/useFollowedReports'
import { useMyCollaborationInvites } from '../../lib/useMyCollaborationInvites'
import { useMyReports } from '../../lib/useMyReports'
import { useOwnedCollections } from '../../lib/useOwnedCollections'
import { useSharedCollections } from '../../lib/useSharedCollections'

type LibraryDeskProps = {
  readingPane?: ReactNode
  readingEnabled?: boolean
}

export function LibraryDesk({ readingPane = null, readingEnabled = true }: LibraryDeskProps) {
  const { id: collectionId, slug: routeFollowedSlug } = useParams<{ id?: string; slug?: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const folderId = searchParams.get('folder')
  const nodeParam = searchParams.get('node')
  const editCollection = searchParams.get('collection') === 'edit'
  const reading = readingPane != null
  const navigate = useNavigate()
  const { toast, success, error } = useToast()
  const { isLoggedIn, bootstrapping, refreshSession, sessionState } = useAuth()
  const collections = useOwnedCollections()
  const shared = useSharedCollections()
  const invites = useMyCollaborationInvites()
  const collectionFollowExposed = isCollectionFollowExposureEnabled() && isLoggedIn
  const followed = useFollowedCollections(collectionFollowExposed)
  const reportsExposed = isReportsExposureEnabled() && isLoggedIn
  const digests = useFollowedReports(reportsExposed)
  const myDigests = useMyReports(reportsExposed)
  const collaboratorsLive = isLive('collaborators')
  const showInviteNav = collaboratorsLive && (
    invites.items.length > 0
    || (invites.state === 'error' && !/verified email is required/i.test(invites.message))
  )

  const data = useLibraryDeskData({
    collectionId,
    routeFollowedSlug,
    folderId,
    reading,
    isLoggedIn,
    bootstrapping,
    collections,
    shared,
    followed,
  })
  const order = useLibraryDeskOrder({
    error,
    isLoggedIn,
    bootstrapping,
    ownedSidebarItems: data.ownedSidebarItems,
    sharedSidebarItems: data.sharedSidebarItems,
    followedItems: followed.items,
    setExpanded: data.setExpanded,
  })
  const selection = useLibraryDeskSelection({ toast })
  const cancelConfirm = useCancelConfirm()
  const [editingNodeId, setEditingNodeId] = useState<string | null>(nodeParam)
  const [settingsOpen, setSettingsOpen] = useState(editCollection)
  const layerReorder = useLibraryLayerReorder({
    snap: data.snap,
    collectionId: data.selectedFollowedSlug ? null : data.selectedId,
    parentId: data.selectedFolder?.id ?? data.snap?.root.id ?? null,
    loadTree: data.loadTree,
    success,
    error,
    notice: toast,
  })

  useEffect(() => {
    if (nodeParam) setEditingNodeId(nodeParam)
  }, [nodeParam])

  useEffect(() => {
    if (editCollection) setSettingsOpen(true)
  }, [editCollection])

  const dropSearchParam = (key: string) => {
    setSearchParams((prev) => {
      if (!prev.has(key)) return prev
      const next = new URLSearchParams(prev)
      next.delete(key)
      return next
    }, { replace: true })
  }
  const mutations = useLibraryDeskMutations({
    snap: data.snap,
    parentId: data.selectedFolder?.id ?? data.snap?.root.id ?? '',
    loadTree: data.loadTree,
    treesRef: data.treesRef,
    navigate,
    toast,
    success,
    error,
    refreshSession,
    exitSelectMode: selection.exitSelectMode,
    setBulk: selection.setBulk,
  })

  const heading = reading
    ? 'Reading'
    : data.selectedFolder?.title ?? data.collection?.title ?? 'Library'
  useDocumentTitle(heading)

  const resetCompose = mutations.resetCompose
  const resetSelection = selection.resetSelection
  useEffect(() => {
    resetCompose()
    resetSelection()
    // A desk navigation leaves the drawer's subject behind.
    setEditingNodeId(null)
    // The shared confirm lives under Layout; dismiss it with the page
    // context so a delete prompt cannot outlive the collection it named.
    return () => { cancelConfirm() }
  }, [data.selectedId, folderId, reading, resetCompose, resetSelection, cancelConfirm])

  useEffect(() => {
    persistDeskCache(data.trees, data.expanded, order.collapsedSections, data.userCollapsed)
  }, [order.collapsedSections, data.expanded, data.trees, data.userCollapsed])

  const onAcceptInvite = async (inviteId: string, collectionIdToOpen: string) => {
    try {
      const result = await invites.accept(inviteId)
      await shared.reload()
      navigate(`/library/${encodeURIComponent(result.collectionId || collectionIdToOpen)}`)
    } catch (err) {
      if (isProductApiError(err) && err.isAuthRequired) {
        toast('Sign in required')
        navigate(`/login?returnTo=${encodeURIComponent('/library')}`)
      } else if (isProductApiError(err) && err.isCsrfFailed) {
        await refreshSession()
        toast('Your session was refreshed. Try again.')
      } else {
        error(isProductApiError(err) ? err.recoveryHint : 'Could not accept this invitation')
      }
    }
  }

  const onDeclineInvite = async (inviteId: string) => {
    try {
      await invites.decline(inviteId)
    } catch (err) {
      error(isProductApiError(err) ? err.recoveryHint : 'Could not decline this invitation')
    }
  }

  if (bootstrapping) {
    return <RouteLoading label="Checking your session…" data-testid="library-workspace" />
  }

  if (sessionState === 'verification-required') {
    const returnTo = routeFollowedSlug
      ? `/library/following/${routeFollowedSlug}`
      : collectionId ? `/library/${collectionId}` : '/library'
    return (
      <PageShell variant="bare" data-testid="library-workspace">
        <EmptyState
          icon="folder"
          title="Verify your email to open your library"
          description="Your collections stay private until this address is verified."
          action={<Link to={`/verify-email?returnTo=${encodeURIComponent(returnTo)}`} className="btn btn-primary btn-sm">Verify email</Link>}
        />
      </PageShell>
    )
  }

  if (!isLoggedIn) {
    const returnTo = routeFollowedSlug
      ? `/library/following/${routeFollowedSlug}`
      : collectionId ? `/library/${collectionId}` : '/library'
    return (
      <PageShell variant="bare" data-testid="library-workspace">
        <RouteState
          kind="auth"
          icon="folder"
          title="Sign in to open your library"
          description="Your collections and bookmarks are private to your account."
          returnTo={returnTo}
        />
      </PageShell>
    )
  }

  return (
    <>
      <LibraryDeskView
        reading={reading}
        readingPane={readingPane}
        readingEnabled={readingEnabled}
        folderId={folderId}
        collaboratorsLive={collaboratorsLive}
        collectionFollowExposed={collectionFollowExposed}
        reportsExposed={reportsExposed}
        showInviteNav={showInviteNav}
        collections={collections}
        shared={shared}
        followed={followed}
        digests={digests}
        myDigests={myDigests}
        invites={invites}
        data={data}
        order={order}
        selection={selection}
        layerReorder={layerReorder}
        mutations={mutations}
        onAcceptInvite={onAcceptInvite}
        onDeclineInvite={onDeclineInvite}
        onEditNode={setEditingNodeId}
        onEditCollection={() => setSettingsOpen(true)}
      />
      <CollectionSettingsSheet
        collectionId={data.selectedId}
        open={settingsOpen}
        onClose={() => {
          setSettingsOpen(false)
          dropSearchParam('collection')
        }}
      />
      <NodeEditDrawer
        snap={data.snap}
        nodeId={editingNodeId}
        onClose={() => {
          setEditingNodeId(null)
          dropSearchParam('node')
        }}
        loadTree={data.loadTree}
        navigate={navigate}
        toast={toast}
        success={success}
        error={error}
        refreshSession={refreshSession}
      />
    </>
  )
}
