import { ClassificationPreview, type ClassificationFolderChoice } from './classification/ClassificationPreview'
import { useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  isClassifyInboxExposureEnabled,
  isClassificationExposureEnabled,
  isClassificationBatchExposureEnabled,
  productClient,
  ProductApiError,
  type ClassifyInboxItem,
  type ClassifyInboxSuggestion,
  type EditableNodeView,
} from '../api'
import { Breadcrumb } from '../components/Breadcrumb'
import { CollectionDestinationPicker } from '../components/CollectionDestinationPicker'
import { EmptyState, LoadingState } from '../components/EmptyState'
import { FilterRail } from '../components/FilterRail'
import { PageHead } from '../components/PageHead'
import { PageShell } from '../components/PageShell'
import { ProgressBar } from '../components/ProgressBar'
import { RouteState } from '../components/RouteState'
import { useToast } from '../components/AppToast'
import { plural } from '../lib/plural'
import { libraryFeatureUnavailable } from '../lib/libraryCopy'
import { isAbort } from '../lib/libraryTree'
import { useRouteData } from '../lib/useRouteData'
// Route-owned stylesheet (see main.tsx); ships with this chunk.
import '../styles/classify.css'
// Shared library chunk: the manual destination picker's .library-dest-* rows.
import '../styles/library.css'

const UNAVAILABLE_TITLE = 'Classify inbox is not available yet'
const UNAVAILABLE_DESCRIPTION = libraryFeatureUnavailable('classify inbox review')
const NO_ITEMS: ClassifyInboxItem[] = []

/** The active bookmark's collection tree, loaded for the manual folder picker. */
type DestinationTree = { nodeId: string; collectionId: string; collectionTitle: string; rootId: string; nodes: EditableNodeView[] }

function existingSuggestions(item: ClassifyInboxItem): ClassifyInboxSuggestion[] {
  return item.suggestions.filter((suggestion) => suggestion.kind === 'existing')
}

function UnavailableState() {
  return (
    <RouteState
      kind="unavailable"
      icon="folder"
      title={UNAVAILABLE_TITLE}
      description={UNAVAILABLE_DESCRIPTION}
    />
  )
}

export function Classify() {
  const enabled = isClassifyInboxExposureEnabled()
  const batchEnabled = isClassificationBatchExposureEnabled()
  const classificationEnabled = isClassificationExposureEnabled()
  const { success } = useToast()
  const lastActionRef = useRef<'skip' | 'accept' | 'tags' | null>(null)
  const route = useRouteData<ClassifyInboxItem[]>({
    cacheKey: 'classify-inbox',
    enabled,
    load: (signal) => productClient.getMyClassifyInbox({ limit: 20 }, { signal }).then((page) => page.items),
    fallbackError: "Couldn't load your classify inbox. Try again.",
  })
  const items = route.data ?? NO_ITEMS
  const loading = route.status === 'loading'
  const [activeId, setActiveId] = useState('')
  const [chosenByItem, setChosenByItem] = useState<Record<string, string>>({})
  const [manualFolders, setManualFolders] = useState<Record<string, ClassificationFolderChoice | null>>({})
  const [tagsByItem, setTagsByItem] = useState<Record<string, string[]>>({})
  const [needsReview, setNeedsReview] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [acting, setActing] = useState(false)
  const [destinationTree, setDestinationTree] = useState<DestinationTree | null>(null)
  const [loadingDestinations, setLoadingDestinations] = useState(false)

  const active = items.find((row) => row.nodeId === activeId) ?? items[0]
  const suggestions = active ? existingSuggestions(active) : []
  const chosenId = active ? chosenByItem[active.nodeId] : ''
  const pick = (active ? manualFolders[active.nodeId] : null) ?? suggestions.find((suggestion) => suggestion.suggestionId === chosenId) ?? suggestions[0]
  const selectedTags = active ? tagsByItem[active.nodeId] ?? [] : []
  const remaining = items.length
  const progressLabel = useMemo(
    () => `${plural(remaining, 'item')} left`,
    [remaining],
  )
  const error = route.status === 'error' ? route.error : actionError

  // Skip and accept are permanent on the server (there is no revert endpoint),
  // so the row leaves the queue for good and the toast never offers Undo.
  const removeByReceipt = (nodeId: string) => {
    const next = items.filter((row) => row.nodeId !== nodeId)
    route.setData(next)
    setActiveId((currentId) => {
      if (currentId !== nodeId && next.some((row) => row.nodeId === currentId)) return currentId
      return next[0]?.nodeId ?? ''
    })
  }

  const skip = async () => {
    if (!active || acting) return
    lastActionRef.current = 'skip'
    setActing(true)
    setActionError(null)
    try {
      const receipt = await productClient.skipMyClassifyInboxItem(active.nodeId, {
        intentId: productClient.mutationIntentKey('classify-inbox-skip', active.nodeId),
        maxRetries: 0,
      })
      removeByReceipt(receipt.nodeId)
      success('Skipped — it stays in the collection root')
    } catch (err) {
      if (isAbort(err)) return
      setActionError('Could not skip this bookmark. Try again.')
    } finally {
      setActing(false)
    }
  }

  const reportConfirmationError = (err: unknown, fallback: string) => {
    if (isAbort(err)) return
    const conflict = err instanceof ProductApiError && (err.status === 412 || err.code === 'revision_conflict' || err.code === 'invalid_document')
    setNeedsReview(conflict)
    setActionError(conflict ? 'This bookmark or its available tags changed. Refresh and review your choices before confirming again.' : fallback)
  }

  const confirmTags = async () => {
    if (!active || acting || needsReview || !selectedTags.length) return
    lastActionRef.current = 'tags'; setActing(true); setActionError(null)
    const document = { folderId: null, addTags: selectedTags }
    try {
      const result = await productClient.confirmBookmarkClassification(active.collectionId, active.nodeId, document, active.etag, {
        intentId: productClient.mutationIntentKey('classification-confirmation', `${active.nodeId}:${active.etag}:${JSON.stringify(document)}`), maxRetries: 0,
      })
      route.setData(items.map(row => row.nodeId === result.nodeId ? { ...row, etag: result.etag } : row))
      setTagsByItem(previous => ({ ...previous, [active.nodeId]: [] }))
      success('Tags added. The bookmark stays in its current folder.')
    } catch (err) { reportConfirmationError(err, 'Could not add tags. Try again.') }
    finally { setActing(false) }
  }

  const accept = async () => {
    if (!active || !pick || acting || needsReview) return
    lastActionRef.current = 'accept'
    setActing(true)
    setActionError(null)
    const body = { suggestionId: pick.suggestionId, ...(selectedTags.length ? { addTags: selectedTags } : {}) }
    try {
      const receipt = await productClient.acceptMyClassifyInboxItem(
        active.nodeId,
        body,
        active.etag,
        {
          intentId: productClient.mutationIntentKey('classify-inbox-accept', `${active.nodeId}:${active.etag}:${JSON.stringify(body)}`),
          maxRetries: 0,
        },
      )
      const folderId = receipt.decision === 'accepted' ? receipt.folderId : pick.folderId
      removeByReceipt(receipt.nodeId)
      success(`Filed to ${pick.folderTitle}`, {
        action: {
          label: 'View in folder',
          to: `/library/${encodeURIComponent(active.collectionId)}?folder=${encodeURIComponent(folderId)}`,
        },
      })
    } catch (err) {
      reportConfirmationError(err, 'Could not file this bookmark. Try again.')
    } finally {
      setActing(false)
    }
  }

  // Manual destination: any folder in the bookmark's collection. The accept
  // endpoint takes suggestionId === folderId, so a picked folder files the
  // same way a suggestion does.
  const chooseFolder = async () => {
    if (!active || loadingDestinations) return
    const target = active
    setLoadingDestinations(true)
    setActionError(null)
    try {
      const snapshot = await productClient.loadEditorSnapshot(target.collectionId, { maxRetries: 0 })
      setDestinationTree({
        nodeId: target.nodeId,
        collectionId: target.collectionId,
        collectionTitle: target.collectionTitle,
        rootId: snapshot.root.id,
        nodes: snapshot.nodes,
      })
    } catch (err) {
      if (!isAbort(err)) setActionError("Couldn't load this collection's folders. Try again.")
    } finally {
      setLoadingDestinations(false)
    }
  }

  const retryAction = () => {
    if (needsReview) {
      setActionError(null); setManualFolders({}); setTagsByItem({}); setChosenByItem({})
      void route.reload().then(() => setNeedsReview(false))
    } else if (lastActionRef.current === 'tags') void confirmTags()
    else if (lastActionRef.current === 'accept') void accept()
    else void skip()
  }

  const head = (
    <PageHead
      layout="split"
      variant="workbench"
      breadcrumb={
        <Breadcrumb items={[{ label: 'Library', to: '/library' }, { label: 'Classify inbox' }]} />
      }
      title="Classify inbox"
      documentTitle="Classify"
      lede="Review bookmarks that are still sitting in a collection root."
      actions={<>{enabled && items.length > 0 && <span className="meta">{progressLabel}</span>}{batchEnabled && <Link className="btn btn-ghost btn-sm" to="/classify/batch">Batch classification</Link>}</>}
    />
  )

  if (!enabled) {
    return (
      <PageShell variant="grid" className="classify-page" data-testid="classify-inbox-flag-off">
        {head}
        <UnavailableState />
      </PageShell>
    )
  }

  return (
    <PageShell variant="grid" className="classify-page">
      {head}
      {route.status === 'unavailable' ? (
        <UnavailableState />
      ) : route.status === 'auth' ? (
        <RouteState
          kind="auth"
          icon="folder"
          title="Sign in to sort new bookmarks"
          description="You need to be signed in to review your classify inbox."
        />
      ) : error && items.length === 0 ? (
        <RouteState
          kind="error"
          icon="folder"
          title="Couldn't load your classify inbox"
          description={error}
          onRetry={() => {
            setActionError(null)
            void route.reload()
          }}
        />
      ) : loading && items.length === 0 ? (
        <LoadingState label="Loading classify inbox…" />
      ) : items.length === 0 ? (
        <EmptyState
          icon="folder"
          title="Nothing to classify"
          description="Bookmarks that still sit in a collection root will show up here."
          action={
            <>
              <Link to="/library" className="btn btn-primary btn-sm">
                Add a bookmark
              </Link>
              <Link to="/extension" className="btn btn-ghost btn-sm">
                Install extension
              </Link>
            </>
          }
        />
      ) : (
        <>
          {error && <>
            <RouteState
              kind="error"
              icon="folder"
              title={needsReview ? 'Refresh and review this bookmark' : 'Classify inbox action failed'}
              description={error}
              onRetry={needsReview ? undefined : retryAction}
            />
            {needsReview && <button type="button" className="btn btn-secondary btn-sm" onClick={retryAction}>Refresh and review</button>}
          </>}
          <div className="inbox-layout" data-testid="classify-inbox-layout">
            <aside>
              <h3 className="section-label" id="classify-queue-label">Queue</h3>
              <FilterRail
                className="inbox-queue"
                variant="segments"
                labelledBy="classify-queue-label"
                label="Queue"
                testId="classify-queue"
                value={active?.nodeId ?? ''}
                options={items.map((row) => ({
                  value: row.nodeId,
                  label: (
                    <>
                      <strong>{row.title}</strong>
                      <span className="meta">{row.host} · {row.collectionTitle}</span>
                    </>
                  ),
                }))}
                onChange={setActiveId}
              />
            </aside>

            {active && (
              <>
                <div className="panel panel-raised incoming-card incoming-card--suggestions">
                  <header className="incoming-head">
                    <h2 className="display display-sm incoming-title">{active.title}</h2>
                    <p className="meta">{active.host} · {active.collectionTitle}</p>
                  </header>
                  <h3 className="section-label" id="classify-folder-label">Suggestions</h3>
                  {suggestions.length === 0 ? (
                    <p className="meta">No folder suggestion for this bookmark yet.</p>
                  ) : (
                  <FilterRail
                    variant="segments"
                    labelledBy="classify-folder-label"
                    label="Suggestions"
                    value={pick?.suggestionId ?? ''}
                    options={suggestions.map((suggestion) => ({
                      value: suggestion.suggestionId,
                      className: 'suggestion',
                      label: (
                        <>
                          <strong>{suggestion.folderTitle}</strong>
                          <p>{suggestion.reason}</p>
                          <span className="confidence">
                            <ProgressBar
                              className="confidence-track"
                              tone="accent"
                              value={suggestion.score}
                              label="Confidence"
                            />
                            {suggestion.score}% match
                          </span>
                        </>
                      ),
                    }))}
                    onChange={(suggestionId) => {
                      setManualFolders(previous => ({ ...previous, [active.nodeId]: null }))
                      setChosenByItem(prev => ({ ...prev, [active.nodeId]: suggestionId }))
                    }}
                  />
                  )}
                  {!classificationEnabled && (
                    <div className="classify-manual">
                      {manualFolders[active.nodeId] && <p className="meta">Selected: {manualFolders[active.nodeId]!.folderTitle}</p>}
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={acting || loadingDestinations}
                        onClick={() => void chooseFolder()}
                      >
                        {loadingDestinations ? 'Loading folders…' : suggestions.length === 0 && !manualFolders[active.nodeId] ? 'Choose a folder…' : 'Choose another folder…'}
                      </button>
                    </div>
                  )}
                  {classificationEnabled && <ClassificationPreview key={`${active.collectionId}:${active.nodeId}:${active.etag}`}
                    item={active} disabled={acting || needsReview} selectedFolderId={manualFolders[active.nodeId]?.folderId}
                    selectedTags={selectedTags} onTagsChange={tags => setTagsByItem(previous => ({ ...previous, [active.nodeId]: tags }))}
                    onConfirmTags={() => void confirmTags()}
                    onChooseFolder={folder => setManualFolders(previous => ({ ...previous, [active.nodeId]: folder }))} />}
                  <div className="classify-actions">
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled={acting}
                      onClick={() => void skip()}
                    >
                      Skip
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={acting || needsReview || !pick}
                      onClick={() => void accept()}
                    >
                      <span className="classify-file-label">
                        File to {pick?.folderTitle ?? 'folder'}{selectedTags.length ? ` and add ${plural(selectedTags.length, 'tag')}` : ''}
                      </span>
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
          {destinationTree && (
            <CollectionDestinationPicker
              mode="move"
              noun="bookmark"
              count={1}
              current={{
                collection: { id: destinationTree.collectionId, title: destinationTree.collectionTitle },
                rootId: destinationTree.rootId,
                nodes: destinationTree.nodes,
              }}
              currentParentId={destinationTree.rootId}
              movingIds={[destinationTree.nodeId]}
              onPick={(destination) => {
                if (destination.parentTitle !== null && destination.parentId !== destinationTree.rootId) {
                  const folder = { folderId: destination.parentId, folderTitle: destination.parentTitle, suggestionId: destination.parentId }
                  setManualFolders((previous) => ({ ...previous, [destinationTree.nodeId]: folder }))
                }
                setDestinationTree(null)
              }}
              onClose={() => setDestinationTree(null)}
            />
          )}
        </>
      )}
    </PageShell>
  )
}
