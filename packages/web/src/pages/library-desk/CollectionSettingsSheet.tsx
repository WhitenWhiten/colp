import { useCallback, useRef } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { isClassificationExposureEnabled, type EditorSnapshot } from '../../api'
import { ClassificationSettingsPanel } from '../classification/ClassificationSettingsPanel'
import '../../styles/classification-settings.css'
import { useAuth } from '../../auth/AuthContext'
import { useToast } from '../../components/AppToast'
import { useConfirm } from '../../components/ConfirmModal'
import { EmptyState, LoadingState } from '../../components/EmptyState'
import { Modal } from '../../components/Modal'
import { RouteState } from '../../components/RouteState'
import { useCollectionEditorSnapshot } from '../collection-editor/data'
import { CollectionMetaForm } from '../collection-editor/inspector'
import { useCollectionEditorMutations } from '../collection-editor/mutations'
import '../../styles/collab.css'

/**
 * Collection title / summary / publication — the piece of CollectionEditor
 * that LibraryDesk could not already do in place. Opens as a sheet so the
 * desk keeps the tree; `/library/:id/edit` redirects here.
 */
export function CollectionSettingsSheet({
  collectionId: collectionIdProp,
  open,
  onClose,
}: {
  collectionId?: string | null
  open: boolean
  onClose: () => void
}) {
  const { id: routeId } = useParams<{ id?: string }>()
  const collectionId = (open ? collectionIdProp ?? routeId : undefined) ?? undefined
  const navigate = useNavigate()
  const { toast, success, error } = useToast()
  const { isLoggedIn, bootstrapping, refreshSession } = useAuth()
  const onSnapshotReadyRef = useRef<(snap: EditorSnapshot, preserveUserIntent: boolean) => void>(() => {})

  const data = useCollectionEditorSnapshot({
    collectionId,
    isLoggedIn,
    bootstrapping,
    navigate,
    onSnapshotReadyRef,
  })
  const mutations = useCollectionEditorMutations({
    collectionId,
    snap: data.snap,
    reload: data.reload,
    setLoad: data.setLoad,
    setBanner: data.setBanner,
    preserveEditDraftRef: data.preserveEditDraftRef,
    navigate,
    toast,
    success,
    error,
    refreshSession,
    bootstrapping,
    isLoggedIn,
  })
  onSnapshotReadyRef.current = mutations.hydrateFromSnapshot

  const current = data.load.status === 'ready' ? data.load.snap.collection : null
  const dirty = current !== null && (
    mutations.title.trim() !== current.title
    || mutations.summary !== (current.summary ?? '')
    || mutations.publicationDirty
  )
  // R14-45: closing with unsaved edits asks first, like the node drawer.
  const confirm = useConfirm()
  const requestClose = useCallback(() => {
    if (!dirty) {
      onClose()
      return
    }
    void confirm({
      title: 'Discard changes?',
      body: 'You have unsaved changes on this page.',
      confirmLabel: 'Discard',
    }).then((ok) => { if (ok) onClose() })
  }, [confirm, dirty, onClose])

  if (!open) return null

  let body
  if (bootstrapping) {
    body = (
      <div data-testid="collection-settings-loading" role="status" aria-live="polite">
        <LoadingState label="Checking session…" />
      </div>
    )
  } else if (!isLoggedIn) {
    const returnTo = collectionId ? `/library/${encodeURIComponent(collectionId)}?collection=edit` : '/library'
    body = (
      <div data-testid="collection-settings-auth-required">
        <RouteState
          kind="auth"
          icon="link"
          title="Sign in to edit this collection"
          description="Your changes are saved to your account."
          returnTo={returnTo}
        />
      </div>
    )
  } else if (
    data.load.status === 'loading'
    || (data.load.status === 'ready' && data.load.snap.collection.id !== collectionId)
  ) {
    body = (
      <div data-testid="collection-settings-loading" role="status" aria-live="polite">
        <LoadingState label="Loading collection…" />
      </div>
    )
  } else if (data.load.status === 'error') {
    body = (
      <div data-testid="collection-settings-error">
        <EmptyState
          role="alert"
          icon="folder"
          title="Couldn't load this collection"
          description={data.load.hint}
          action={
            <>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => void data.reload()}>
                Try again
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => void refreshSession().then(() => data.reload())}
              >
                Refresh session
              </button>
            </>
          }
        />
      </div>
    )
  } else {
    body = (
      <>
        {data.banner && (
          <div className="panel panel-pad mb-4" role="status">
            <p className="m-0">{data.banner.message}</p>
            <button
              type="button"
              className="btn btn-secondary btn-sm mt-2"
              onClick={() => {
                if (data.banner?.action === 'review_drafts') {
                  document.getElementById('ce-title')?.focus()
                  return
                }
                void data.reload()
              }}
            >
              {data.banner.action === 'review_drafts' ? 'Review drafts' : 'Refresh'}
            </button>
          </div>
        )}
        <CollectionMetaForm snap={data.load.snap} mutations={mutations} />
        {isClassificationExposureEnabled() && <ClassificationSettingsPanel key={data.load.snap.collection.id} collectionId={data.load.snap.collection.id} />}
      </>
    )
  }

  return (
    <Modal
      open={open}
      onClose={requestClose}
      label="Edit collection"
      title="Edit collection"
    >
      <div
        data-testid="collection-settings"
        aria-busy={mutations.busy}
      >
        {body}
      </div>
    </Modal>
  )
}
