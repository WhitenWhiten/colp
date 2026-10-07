import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  isCollectionHistoryExposureEnabled,
  productClient,
  type CollectionVersion,
} from '../api'
import { useToast } from '../components/AppToast'
import { Breadcrumb } from '../components/Breadcrumb'
import { useConfirm } from '../components/ConfirmModal'
import { EmptyState, LoadingState } from '../components/EmptyState'
import { Icon } from '../components/Icon'
import { PageHead } from '../components/PageHead'
import { PageShell } from '../components/PageShell'
import { RouteState } from '../components/RouteState'
import { StatusBadge, type StatusTone } from '../components/StatusBadge'
import { classifyRouteError } from '../lib/classifyRouteError'
import { formatMediumInstant } from '../lib/formatDate'
import { libraryFeatureUnavailable } from '../lib/libraryCopy'
import { isAbort } from '../lib/libraryTree'
import { plural } from '../lib/plural'
import { useRouteData } from '../lib/useRouteData'
// Shared product-loop stylesheet (see main.tsx); ships with this route chunk.
import '../styles/collection-history.css'

const CHANGE_KIND_TONE: Record<string, StatusTone> = {
  added: 'success',
  removed: 'danger',
  moved: 'neutral',
  renamed: 'neutral',
  retargeted: 'warning',
}

const CHANGE_LABEL: Record<string, string> = {
  added: 'Added',
  removed: 'Removed',
  moved: 'Moved',
  renamed: 'Renamed',
  retargeted: 'Link changed',
}

const VERSION_KIND_LABEL: Record<string, string> = {
  manual: 'Saved by you',
  pre_restore: 'Automatic, before a restore',
  pre_mutation: 'Automatic, before a change',
}

const NO_VERSIONS: CollectionVersion[] = []

type HistoryCollection = {
  collection: {
    title: string
    contentEtag: string
    publicationSlug: string | null
  }
}

type HistoryData = {
  owned: HistoryCollection
  versions: CollectionVersion[]
}

async function readHistoryCollection(
  collectionId: string,
  signal: AbortSignal,
): Promise<HistoryCollection> {
  const page = await productClient.getCollectionEditorPage(
    collectionId,
    { limit: 1 },
    { signal, maxRetries: 0 },
  )
  return {
    collection: {
      title: page.collection.title,
      contentEtag: page.collection.contentEtag,
      publicationSlug: page.collection.publicationSlug,
    },
  }
}

async function loadVersionPage(
  collectionId: string,
  signal: AbortSignal,
): Promise<CollectionVersion[]> {
  const items: CollectionVersion[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  for (;;) {
    const page = await productClient.listCollectionVersions(
      collectionId,
      cursor ? { cursor } : {},
      { signal, maxRetries: 0 },
    )
    items.push(...page.items)
    const next = page.nextCursor
    if (!next || seen.has(next)) return items
    seen.add(next)
    cursor = next
  }
}

export function CollectionHistory() {
  const { id } = useParams()
  const collectionId = id ?? ''
  const enabled = isCollectionHistoryExposureEnabled()
  const route = useRouteData<HistoryData>({
    cacheKey: `collection-history:${collectionId}`,
    enabled: enabled && collectionId !== '',
    load: async (signal) => {
      const owned = await readHistoryCollection(collectionId, signal)
      const versions = await loadVersionPage(collectionId, signal)
      return { owned, versions }
    },
    fallbackError: "Couldn't load collection history. Try again.",
  })
  const owned = route.data?.owned ?? null
  const versions = route.data?.versions ?? NO_VERSIONS
  const reload = route.reload
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<CollectionVersion | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [restoredLabel, setRestoredLabel] = useState<string | null>(null)
  const detailAbortRef = useRef<AbortController | null>(null)
  const confirm = useConfirm()
  const { success } = useToast()

  useEffect(() => () => {
    detailAbortRef.current?.abort()
  }, [])

  // A 401 / 404 raised by a follow-up call is re-classified by the shared
  // loader: reloading the route surfaces the same Sign in / unavailable state.
  const failAction = useCallback((err: unknown, message: string) => {
    if (classifyRouteError(err) === 'error') {
      setActionError(message)
    } else {
      void reload()
    }
  }, [reload])

  const selectVersion = useCallback(async (versionId: string, fromClick = false) => {
    if (!collectionId) return
    setSelectedId(versionId)
    if (fromClick && window.matchMedia('(max-width: 899px)').matches) {
      document.querySelector('.history-detail')?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    }
    setActionError(null)
    detailAbortRef.current?.abort()
    const controller = new AbortController()
    detailAbortRef.current = controller
    setDetailLoading(true)
    try {
      const next = await productClient.getCollectionVersion(collectionId, versionId, {
        signal: controller.signal,
        maxRetries: 0,
      })
      if (controller.signal.aborted) return
      setDetail(next)
    } catch (err) {
      if (isAbort(err) || controller.signal.aborted) return
      setDetail(null)
      failAction(err, "Couldn't load this version. Try again.")
    } finally {
      if (!controller.signal.aborted) setDetailLoading(false)
    }
  }, [collectionId, failAction])

  useEffect(() => {
    const newest = versions[0]
    if (newest && selectedId === null) void selectVersion(newest.versionId)
  }, [versions, selectedId, selectVersion])

  const saveVersion = useCallback(async () => {
    const contentEtag = owned?.collection.contentEtag
    if (!collectionId || !contentEtag) return
    setSaving(true)
    setActionError(null)
    try {
      await productClient.createCollectionVersion(
        collectionId,
        {},
        {
          intentId: productClient.mutationIntentKey('create-collection-version', productClient.newCommandId()),
          ifMatch: contentEtag,
          maxRetries: 0,
        },
      )
      await reload()
      success('Version saved')
    } catch (err) {
      if (isAbort(err)) return
      failAction(err, "Couldn't save the version. Try again.")
    } finally {
      setSaving(false)
    }
  }, [collectionId, failAction, owned, reload, success])

  const restoreVersion = useCallback(async () => {
    const contentEtag = owned?.collection.contentEtag
    const selected = versions.find((item) => item.versionId === selectedId) ?? detail
    if (!collectionId || !contentEtag || !selected) return
    if (selected.changeCounts.removed > 0) return
    const ok = await confirm({
      title: `Restore “${selected.label}”?`,
      body: selected.changeCounts.added > 0 ? `The collection will match this version. ${plural(selected.changeCounts.added, 'item')} added since then will be deleted, and moved or renamed items go back.` : 'The collection will match this version. Moved or renamed items go back.',
      confirmLabel: 'Restore version',
    })
    if (!ok) return
    setRestoring(true)
    setActionError(null)
    try {
      await productClient.restoreCollectionVersion(
        collectionId,
        selected.versionId,
        {},
        {
          intentId: productClient.mutationIntentKey('restore-collection-version', productClient.newCommandId()),
          ifMatch: contentEtag,
          maxRetries: 0,
        },
      )
      setRestoredLabel(selected.label)
      await reload()
      if (selectedId) {
        const next = await productClient.getCollectionVersion(collectionId, selectedId, { maxRetries: 0 })
        setDetail(next)
      }
    } catch (err) {
      if (isAbort(err)) return
      failAction(err, "Couldn't restore this version. Try again.")
    } finally {
      setRestoring(false)
    }
  }, [collectionId, confirm, detail, failAction, owned, reload, selectedId, versions])

  if (!enabled) {
    return (
      <PageShell variant="grid" data-testid="collection-history-flag-off">
        <EmptyState
          icon="folder"
          titleAs="h1"
          title="Collection history is not available yet"
          description={libraryFeatureUnavailable('collection version history')}
        />
      </PageShell>
    )
  }

  const title = owned?.collection.title ?? 'Collection'
  const slug = owned?.collection.publicationSlug
  const loading = route.status === 'loading'
  const error = route.status === 'error' ? route.error : null
  const selected = (detail && detail.versionId === selectedId ? detail : null)
    ?? versions.find((item) => item.versionId === selectedId)
    ?? null
  const removed = selected?.changeCounts.removed ?? 0
  const restoreDisabled = !selected || removed > 0 || restoring || saving || loading
  const changes = detail?.versionId === selectedId ? detail.changes ?? [] : []

  return (
    <PageShell variant="grid" data-testid="collection-history-page">
      <PageHead
        as="header"
        layout="split"
        variant="workbench"
        breadcrumb={
          <Breadcrumb
            items={[
              { label: 'Library', to: '/library' },
              { label: title, to: `/library/${collectionId}` },
              { label: 'History' },
            ]}
          />
        }
        title="Version history"
        documentTitle="History"
        lede="Compare versions of this collection and restore an earlier one."
        actions={
          <>
            {slug ? <Link to={`/c/${slug}`} className="btn btn-ghost btn-sm">View published</Link> : null}
            {route.status === 'ready' && versions.length > 0 ? (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={saving || !owned?.collection.contentEtag}
                onClick={() => void saveVersion()}
              >
                {saving ? 'Saving…' : 'Save version'}
              </button>
            ) : null}
          </>
        }
      />

      {actionError && <p className="field-error" role="alert" data-testid="history-action-error">{actionError}</p>}

      {restoredLabel && (
        <div className="history-restore-banner" role="status">
          <span>Restored {restoredLabel} on this collection.</span>
          <Link to={`/library/${collectionId}?collection=edit`}>Edit collection</Link>
        </div>
      )}

      {route.status === 'auth' ? (
        <RouteState
          kind="auth"
          icon="folder"
          title="Sign in to see this collection's history"
          description="You need to be signed in to view collection history."
        />
      ) : route.status === 'unavailable' ? (
        <RouteState
          kind="unavailable"
          icon="folder"
          title="Collection history is not available yet"
          feature="collection version history"
        />
      ) : error ? (
        <RouteState
          kind="error"
          icon="folder"
          title="Couldn't load collection history"
          description={error}
          onRetry={() => {
            setActionError(null)
            void reload()
          }}
        />
      ) : loading ? (
        <LoadingState label="Loading collection history…" />
      ) : versions.length === 0 ? (
        /* Nothing to compare yet: one centred page-level empty state instead
           of an empty two-column shell with a second empty state beside it. */
        <EmptyState
          data-testid="history-empty-versions"
          icon="folder"
          title="No versions yet"
          description="Save a version to keep a restorable copy of this collection as it is now."
          action={(
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={saving || !owned?.collection.contentEtag}
              onClick={() => void saveVersion()}
            >
              Save first version
            </button>
          )}
        />
      ) : (
        <div className="history-layout">
          <aside className="history-timeline">
            <div
              className="history-version-list"
              data-testid="history-version-list"
              role="group"
              aria-label="Collection versions"
            >
              {versions.map((item) => (
                <button
                  key={item.versionId}
                  type="button"
                  className={item.versionId === selectedId ? 'is-active' : ''}
                  aria-pressed={item.versionId === selectedId}
                  onClick={() => void selectVersion(item.versionId, true)}
                >
                  <span><strong>{item.label}</strong></span>
                  <small>
                    <time dateTime={item.createdAt}>{formatMediumInstant(item.createdAt)}</time>
                  </small>
                </button>
              ))}
            </div>
          </aside>
          <div className="history-detail">
            {!selected ? (
              <EmptyState
                data-testid="history-empty-detail"
                className="empty-state--compact"
                icon="folder"
                title="No version selected"
                description="Select a version to see what changed since then."
              />
            ) : (
              <>
                <div className="history-detail-head">
                  <div>
                    <p className="section-label">Selected version</p>
                    <h2>{selected.label}</h2>
                  </div>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={restoreDisabled}
                    aria-describedby={removed > 0 ? 'history-restore-disabled-reason' : undefined}
                    onClick={() => void restoreVersion()}
                  >
                    Restore
                  </button>
                </div>
                {removed > 0 && (
                  <section id="history-restore-disabled-reason" className="history-integrity">
                    <span aria-hidden><Icon name="alert" /></span>
                    <div>
                      <strong>Restore isn't available for this version</strong>
                      <p>
                        {`${plural(removed, 'bookmark or folder', 'bookmarks or folders')} from this version ${removed === 1 ? 'is' : 'are'} no longer in the collection, and restoring can't bring deleted items back yet.`}
                      </p>
                    </div>
                  </section>
                )}
                <dl className="history-facts">
                  <div><dt>Saved</dt><dd><time dateTime={selected.createdAt}>{formatMediumInstant(selected.createdAt)}</time></dd></div>
                  <div><dt>Type</dt><dd>{VERSION_KIND_LABEL[selected.kind] ?? selected.kind}</dd></div>
                  <div><dt>Bookmarks and folders</dt><dd>{selected.nodeCount}</dd></div>
                  <div><dt>Removed</dt><dd>{removed}</dd></div>
                </dl>
                <section className="history-changes">
                  {detailLoading ? (
                    <LoadingState label="Loading changes…" />
                  ) : changes.length === 0 ? (
                    <p className="meta">This version matches the collection as it is now.</p>
                  ) : changes.map((change) => (
                    <article key={`${change.nodeId}-${change.type}`} className="history-change-row">
                      <StatusBadge tone={CHANGE_KIND_TONE[change.type] ?? 'neutral'}>{CHANGE_LABEL[change.type] ?? change.type}</StatusBadge>
                      <div><strong>{change.title}</strong></div>
                    </article>
                  ))}
                </section>
              </>
            )}
          </div>
        </div>
      )}
    </PageShell>
  )
}
