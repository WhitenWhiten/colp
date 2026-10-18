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
import { isAbort, rootTitle } from '../lib/libraryTree'
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

/** An unlabelled save comes back named "Snapshot <UTC timestamp>". */
const SERVER_DEFAULT_LABEL = /^Snapshot \d{4}-\d{2}-\d{2}T[\d:.]+Z$/u

/** The versions the server saves before a rule moves bookmarks, in the words
    the Automations pages use. A Map, so an owner's own label is never read as
    an object key. */
const SERVER_LABELS = new Map([
  ['Before deterministic automation placement', 'Before a rule filed a bookmark'],
  ['Before explicit run-once placement', 'Before Run once'],
])

/** The list already shows when a version was saved, in local time, so an
    unlabelled save reads as "Snapshot" instead of repeating a UTC stamp. */
function versionLabel(version: Pick<CollectionVersion, 'label'>): string {
  if (SERVER_DEFAULT_LABEL.test(version.label)) return 'Snapshot'
  return SERVER_LABELS.get(version.label) ?? version.label
}

/** A version named in a sentence: its label, or its time when it has none. */
function versionReference(version: Pick<CollectionVersion, 'label' | 'createdAt'>): string {
  return SERVER_DEFAULT_LABEL.test(version.label)
    ? `the snapshot from ${formatMediumInstant(version.createdAt)}`
    : `“${versionLabel(version)}”`
}

type HistoryCollection = {
  collection: {
    title: string
    library?: boolean
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
      library: page.collection.library,
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
  const library = owned?.collection.library === true
  const versions = route.data?.versions ?? NO_VERSIONS
  const reload = route.reload
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<CollectionVersion | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const detailAbortRef = useRef<AbortController | null>(null)
  const confirm = useConfirm()
  const { success, error: toastError } = useToast()

  useEffect(() => () => {
    detailAbortRef.current?.abort()
  }, [])

  // A 401 / 404 raised by a follow-up call is re-classified by the shared
  // loader: reloading the route surfaces the same Sign in / unavailable state.
  const failAction = useCallback((err: unknown, message: string) => {
    if (classifyRouteError(err) === 'error') {
      toastError(message)
    } else {
      void reload()
    }
  }, [reload, toastError])

  const selectVersion = useCallback(async (versionId: string, fromClick = false) => {
    if (!collectionId) return
    setSelectedId(versionId)
    if (fromClick && window.matchMedia('(max-width: 899px)').matches) {
      document.querySelector('.history-detail')?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    }
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
      title: `Restore ${versionReference(selected)}?`,
      body: `${library ? 'Your library' : 'The collection'} will match this version. ${selected.changeCounts.added > 0 ? `${plural(selected.changeCounts.added, 'item')} added since then will be deleted, and moved` : 'Moved'} or renamed items go back.`,
      confirmLabel: 'Restore version',
    })
    if (!ok) return
    setRestoring(true)
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
      // The library has no collection settings; its folders are what changed.
      success(`Restored ${versionReference(selected)} on ${library ? 'your library' : 'this collection'}.`, {
        action: library
          ? { label: 'Open library', to: `/library/${collectionId}` }
          : { label: 'Edit collection', to: `/library/${collectionId}?collection=edit` },
      })
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
  }, [collectionId, confirm, detail, failAction, library, owned, reload, selectedId, success, versions])

  if (!enabled) {
    return (
      <PageShell variant="grid" data-testid="collection-history-flag-off">
        <EmptyState
          icon="refresh"
          titleAs="h1"
          title="Collection history is not available yet"
          description={libraryFeatureUnavailable('collection version history')}
        />
      </PageShell>
    )
  }

  const title = owned ? rootTitle(owned.collection) : 'Collection'
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
            // The library's root already is the Library: name it once.
            items={[
              ...(library ? [] : [{ label: 'Library', to: '/library' }]),
              { label: title, to: `/library/${collectionId}` },
              { label: 'History' },
            ]}
          />
        }
        title="Version history"
        documentTitle="History"
        lede={`Compare versions of ${library ? 'your library' : 'this collection'} and restore an earlier one.`}
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

      {route.status === 'auth' ? (
        <RouteState
          kind="auth"
          icon="refresh"
          title="Sign in to see this collection's history"
          description="You need to be signed in to view collection history."
        />
      ) : route.status === 'unavailable' ? (
        <RouteState
          kind="unavailable"
          icon="refresh"
          title="Collection history is not available yet"
          feature="collection version history"
        />
      ) : error ? (
        <RouteState
          kind="error"
          icon="alert"
          title="Couldn't load collection history"
          description={error}
          onRetry={() => {
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
          icon="refresh"
          title="No versions yet"
          description={`Save a version to keep a restorable copy of ${library ? 'your library' : 'this collection'} as it is now.`}
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
                  <span><strong>{versionLabel(item)}</strong></span>
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
                icon="refresh"
                title="No version selected"
                description="Select a version to see what changed since then."
              />
            ) : (
              <>
                <div className="history-detail-head">
                  <div>
                    <p className="section-label">Selected version</p>
                    <h2>{versionLabel(selected)}</h2>
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
                        {`${plural(removed, 'bookmark or folder', 'bookmarks or folders')} from this version ${removed === 1 ? 'is' : 'are'} no longer in ${library ? 'your library' : 'the collection'}, and restoring can't bring deleted items back yet.`}
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
                    <p className="meta">{`This version matches ${library ? 'your library' : 'the collection'} as it is now.`}</p>
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
