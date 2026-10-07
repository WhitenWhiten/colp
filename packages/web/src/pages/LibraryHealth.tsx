import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ProductApiError,
  isLinkHealthExposureEnabled,
  productClient,
  type LinkHealthItem,
  type LinkHealthPage,
  type LinkHealthStatus,
} from '../api'
import { Breadcrumb } from '../components/Breadcrumb'
import { useToast } from '../components/AppToast'
import { EmptyState, LoadingState } from '../components/EmptyState'
import { FilterRail } from '../components/FilterRail'
import { SelectMenu } from '../components/SelectMenu'
import { LoadMoreButton } from '../components/LoadMoreButton'
import { PageHead } from '../components/PageHead'
import { PageShell } from '../components/PageShell'
import { DataTable, DataTableCell, DataTableRow } from '../components/DataTable'
import { ProgressBar } from '../components/ProgressBar'
import { RouteState } from '../components/RouteState'
import { plural } from '../lib/plural'
import { libraryFeatureUnavailable } from '../lib/libraryCopy'
import { classifyRouteError } from '../lib/classifyRouteError'
import { isAbort } from '../lib/libraryTree'
import { useRouteData } from '../lib/useRouteData'
import { classifyLinkHealthDisplay } from './library-health/classify'
import { HealthRow } from './library-health/HealthRow'
// Shared product-loop stylesheet (see main.tsx); ships with this route chunk.
import '../styles/library-health.css'

const filters = ['all', 'broken', 'redirect', 'duplicate', 'healthy', 'pending'] as const
type HealthFilter = (typeof filters)[number]
type HealthScope = 'owned' | 'shared' | 'all'

const scopeButtons: { value: HealthScope; label: string }[] = [
  { value: 'owned', label: 'Owned' },
  { value: 'shared', label: 'Shared with me' },
  { value: 'all', label: 'All' },
]

function filterLabel(value: HealthFilter): string {
  if (value === 'all') return 'All'
  if (value === 'broken') return 'Broken'
  if (value === 'redirect') return 'Redirects'
  if (value === 'duplicate') return 'Duplicates'
  if (value === 'healthy') return 'Healthy'
  return 'Not checked yet'
}

function queryFor(filter: HealthFilter, scope: HealthScope) {
  const query: {
    limit: 50
    duplicate?: true
    status?: Exclude<HealthFilter, 'all' | 'duplicate'>
    scope?: 'shared' | 'all'
  } = { limit: 50 }
  if (filter === 'duplicate') query.duplicate = true
  else if (filter !== 'all') query.status = filter
  if (scope === 'shared' || scope === 'all') query.scope = scope
  return query
}

function editorCollectionIds(items: LinkHealthItem[]): string[] {
  const ids = new Set<string>()
  for (const item of items) {
    if (item.membership === 'editor') ids.add(item.collectionId)
  }
  return [...ids]
}

export function LibraryHealth() {
  const enabled = isLinkHealthExposureEnabled()
  const { toast, error: toastError } = useToast()
  const [filter, setFilter] = useState<HealthFilter>('all')
  const [scope, setScope] = useState<HealthScope>('owned')
  const [checking, setChecking] = useState(false)
  const [busyNodeId, setBusyNodeId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  const [loadingMore, setLoadingMore] = useState(false)
  const route = useRouteData<LinkHealthPage>({
    cacheKey: `link-health:v2:${filter}:${scope}`,
    enabled,
    load: (signal) => productClient.getMyLinkHealth(queryFor(filter, scope), { signal }).then((page) => page),
    fallbackError: "Couldn't load link health. Try again.",
  })
  const items = useMemo(() => route.data?.items ?? [], [route.data])
  const nextCursor = route.data?.nextCursor ?? null
  const loading = route.status === 'loading'

  const checkAll = useCallback(async () => {
    const collectionIds = editorCollectionIds(items)
    if (scope === 'shared' && collectionIds.length === 0) {
      toast('Only editors can recheck shared collections')
      return
    }
    setChecking(true)
    setError(null)
    try {
      let queued = 0
      if (scope === 'owned' || scope === 'all') {
        const receipt = await productClient.enqueueMyLinkHealthChecks(
          {},
          {
            intentId: productClient.mutationIntentKey('link-health-checks', productClient.newCommandId()),
            maxRetries: 0,
          },
        )
        queued += receipt.queued
      }
      if (scope === 'shared' || scope === 'all') {
        for (const collectionId of collectionIds) {
          const receipt = await productClient.enqueueMyLinkHealthChecks(
            { collectionId },
            {
              intentId: productClient.mutationIntentKey('link-health-checks', collectionId),
              maxRetries: 0,
            },
          )
          queued += receipt.queued
        }
      }
      toast(`Checking ${plural(queued, 'link')}. Reload this page in a few minutes to see results.`)
      await route.reload()
    } catch (err) {
      if (isAbort(err)) return
      if (classifyRouteError(err) === 'error') {
        setError("Couldn't start the link check. Try again.")
      }
    } finally {
      setChecking(false)
    }
  }, [items, route, scope, toast])

  const markDuplicate = useCallback(async (item: LinkHealthItem) => {
    if (!item.duplicateOfNodeId) return
    setBusyNodeId(item.nodeId)
    setRowErrors((current) => { const next = { ...current }; delete next[item.nodeId]; return next })
    try {
      await productClient.createRelation(item.collectionId, {
        fromNodeId: item.nodeId,
        toNodeId: item.duplicateOfNodeId,
        type: 'duplicate_of',
        visibility: 'private',
      }, {
        intentId: productClient.mutationIntentKey('link-health-duplicate-review', item.nodeId),
        maxRetries: 0,
      })
      await route.reload()
    } catch (err) {
      if (isAbort(err)) return
      if (err instanceof ProductApiError && err.code === 'mutation_conflict') {
        await route.reload()
        return
      }
      if (classifyRouteError(err) === 'error') {
        setRowErrors((current) => ({ ...current, [item.nodeId]: "Couldn't mark this as a duplicate. Try again." }))
      }
    } finally {
      setBusyNodeId(null)
    }
  }, [route])

  const undoDuplicate = useCallback(async (item: LinkHealthItem) => {
    if (!item.duplicateRelationId || !item.duplicateRelationEtag) return
    setBusyNodeId(item.nodeId)
    setRowErrors((current) => { const next = { ...current }; delete next[item.nodeId]; return next })
    try {
      await productClient.deleteRelation(
        item.collectionId,
        item.duplicateRelationId,
        item.duplicateRelationEtag,
        {
          intentId: productClient.mutationIntentKey('link-health-duplicate-undo', item.nodeId),
          maxRetries: 0,
        },
      )
      await route.reload()
    } catch (err) {
      if (isAbort(err)) return
      if (err instanceof ProductApiError && err.isPreconditionFailed) {
        productClient.abandonRelationIntent(
          productClient.mutationIntentKey('link-health-duplicate-undo', item.nodeId),
        )
        await route.reload()
        setRowErrors((current) => ({ ...current, [item.nodeId]: 'This review changed. Refresh, then undo again.' }))
        return
      }
      if (classifyRouteError(err) === 'error') {
        setRowErrors((current) => ({ ...current, [item.nodeId]: "Couldn't undo. Try again." }))
      }
    } finally {
      setBusyNodeId(null)
    }
  }, [route])

  const retryCheck = useCallback(async (item: LinkHealthItem) => {
    setBusyNodeId(item.nodeId)
    setRowErrors((current) => { const next = { ...current }; delete next[item.nodeId]; return next })
    try {
      await productClient.enqueueMyLinkHealthChecks(
        { collectionId: item.collectionId, nodeIds: [item.nodeId] },
        {
          intentId: productClient.mutationIntentKey('link-health-retry', item.nodeId),
          maxRetries: 0,
        },
      )
      await route.reload()
    } catch (err) {
      if (isAbort(err)) return
      if (classifyRouteError(err) === 'error') {
        setRowErrors((current) => ({ ...current, [item.nodeId]: "Couldn't start the check. Try again." }))
      }
    } finally {
      setBusyNodeId(null)
    }
  }, [route])

  /* The cursor already encodes the filter and scope, so a continuation sends
     only the cursor. A page that lands after the view changed belongs to the
     old view: switching the filter or scope aborts it. */
  const loadMoreAbortRef = useRef<AbortController | null>(null)
  useEffect(() => () => loadMoreAbortRef.current?.abort(), [filter, scope])

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return
    const controller = new AbortController()
    loadMoreAbortRef.current = controller
    setLoadingMore(true)
    try {
      const page = await productClient.getMyLinkHealth({ cursor: nextCursor }, { signal: controller.signal })
      if (controller.signal.aborted) return
      const seen = new Set(items.map((item) => item.nodeId))
      route.setData({
        items: [...items, ...page.items.filter((item) => !seen.has(item.nodeId))],
        nextCursor: page.nextCursor,
      })
    } catch (err) {
      if (!isAbort(err) && !controller.signal.aborted) toastError('Couldn’t load more links. Try again')
    } finally {
      if (loadMoreAbortRef.current === controller) loadMoreAbortRef.current = null
      setLoadingMore(false)
    }
  }, [items, loadingMore, nextCursor, route, toastError])

  const healthyCount = items.filter((item) => item.status === 'healthy').length
  const issueCount = items.length - healthyCount
  const healthyPct = items.length === 0 ? 0 : (healthyCount / items.length) * 100
  const collectionCount = useMemo(
    () => new Set(items.map((item) => item.collectionId)).size,
    [items],
  )
  const duplicateCount = items.filter((item) => item.duplicateOfNodeId != null).length
  const brokenCount = items.filter((item) => classifyLinkHealthDisplay(item).kind === 'broken').length
  const checkFailedCount = items.filter((item) => {
    const kind = classifyLinkHealthDisplay(item).kind
    return kind === 'check_failed' || kind === 'remote_error'
  }).length
  const statusCount = (status: LinkHealthStatus) => items.filter((item) => item.status === status).length
  const listComplete = nextCursor === null
  const partialHealthyLabel = `${healthyCount} of the first ${items.length} links are healthy`

  if (!enabled) {
    return (
      <PageShell variant="grid" className="health-page" data-testid="link-health-flag-off">
        <EmptyState
          icon="link"
          title="Link health is not available yet"
          description={libraryFeatureUnavailable('Link health')}
        />
      </PageShell>
    )
  }

  return (
    <PageShell variant="grid" className="health-page">
      <PageHead
        as="header"
        layout="split"
        variant="workbench"
        breadcrumb={
          <Breadcrumb items={[{ label: 'Library', to: '/library' }, { label: 'Link health' }]} />
        }
        title="Link health"
        documentTitle="Link health"
        lede="Find unavailable sources, redirects, and duplicates before readers reach them."
        actions={
          <>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={checking || loading}
              onClick={() => void checkAll()}
            >
              {checking ? 'Checking…' : 'Check all links'}
            </button>
          </>
        }
      />

      {route.status === 'auth' && items.length === 0 ? (
        <RouteState
          className="health-empty"
          kind="auth"
          icon="link"
          title="Sign in to check your links"
          description="You need to be signed in to review link health."
        />
      ) : route.status === 'unavailable' && items.length === 0 ? (
        <RouteState
          className="health-empty"
          kind="unavailable"
          icon="link"
          title="Link health is not available yet"
          feature="bookmark link health"
        />
      ) : route.status === 'error' && items.length === 0 ? (
        <RouteState
          className="health-empty"
          kind="error"
          icon="link"
          title="Couldn't load link health"
          description={route.error ?? undefined}
          onRetry={() => void route.reload()}
        />
      ) : loading && items.length === 0 ? (
        <LoadingState label="Loading link health…" />
      ) : (
        <>
          {error && (
            <EmptyState
              className="health-empty"
              role="alert"
              icon="link"
              title="Couldn't start the link check"
              description={error}
              action={
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => void checkAll()}>
                  Try again
                </button>
              }
            />
          )}
          {filter === 'all' ? (
            <section className="health-overview">
              <div>
                <strong>
                  {listComplete
                    ? <>{healthyCount} of {plural(items.length, 'link is', 'links are')} healthy</>
                    : partialHealthyLabel}
                </strong>
                <span>
                  {issueCount === 0
                    ? 'Nothing on this page needs review'
                    : `${plural(issueCount, 'item needs', 'items need')} review${
                      collectionCount > 0
                        ? ` across ${plural(collectionCount, 'collection')}`
                        : ''
                    }`}
                </span>
              </div>
              <ProgressBar
                value={healthyPct}
                label={listComplete
                  ? `${healthyCount} of ${plural(items.length, 'link')} on this page are healthy`
                  : partialHealthyLabel}
              />
              {listComplete ? (
                <dl>
                  <div><dt>Broken</dt><dd>{brokenCount}</dd></div>
                  <div><dt>Could not check</dt><dd>{checkFailedCount}</dd></div>
                  <div><dt>Redirects</dt><dd>{statusCount('redirect')}</dd></div>
                  <div><dt>Duplicates</dt><dd>{duplicateCount}</dd></div>
                  <div><dt>Not checked yet</dt><dd>{statusCount('pending')}</dd></div>
                </dl>
              ) : null}
            </section>
          ) : null}

          <section className="health-directory">
            <div className="health-toolbar">
              <SelectMenu
                label="Filter link health"
                prefix="Issue:"
                testId="health-issue-filter"
                value={filter}
                options={filters.map((item) => ({
                  value: item,
                  // The loaded count rides on the chosen issue once the list is complete.
                  label: item === filter && nextCursor === null
                    ? `${filterLabel(item)} (${items.length})`
                    : filterLabel(item),
                }))}
                onChange={setFilter}
              />
              <FilterRail
                variant="segments"
                className="view-switch"
                label="Link health scope"
                value={scope}
                options={scopeButtons.map((item) => ({ value: item.value, label: item.label }))}
                onChange={setScope}
              />
            </div>

            <DataTable
              className="health-table"
              label="Library link health"
              columns={[
                { key: 'resource', label: 'Bookmark' },
                { key: 'issue', label: 'Issue' },
                { key: 'checked', label: 'Last checked' },
                { key: 'action', label: 'Action' },
              ]}
            >
              {items.map((item) => (
                <HealthRow
                  key={item.nodeId}
                  item={item}
                  scope={scope}
                  busy={checking || busyNodeId === item.nodeId}
                  rowError={rowErrors[item.nodeId]}
                  onMark={(target) => void markDuplicate(target)}
                  onUndo={(target) => void undoDuplicate(target)}
                  onRetryCheck={(target) => void retryCheck(target)}
                />
              ))}
              {items.length === 0 && (
                <DataTableRow>
                  <DataTableCell full>
                    <EmptyState
                      className="health-empty"
                      icon="link"
                      title="No items in this state"
                      description="Choose another filter or run a fresh health check."
                    />
                  </DataTableCell>
                </DataTableRow>
              )}
            </DataTable>
            {nextCursor ? (
              <div className="empty-state-actions">
                <LoadMoreButton
                  onClick={() => void loadMore()}
                  loading={loadingMore}
                  status={loadingMore ? 'Loading more links…' : undefined}
                />
              </div>
            ) : null}
          </section>
        </>
      )}
    </PageShell>
  )
}
