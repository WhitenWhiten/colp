import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  isAiOrganizeExposureEnabled,
  isProductApiError,
  productClient,
  type OrganizePlan,
  type OrganizePlanAction,
  type OwnedCollectionListItem,
} from '../api'
import { Breadcrumb } from '../components/Breadcrumb'
import { useToast } from '../components/AppToast'
import { useConfirm } from '../components/ConfirmModal'
import { EmptyState, LoadingState } from '../components/EmptyState'
import { FilterRail } from '../components/FilterRail'
import { SelectMenu } from '../components/SelectMenu'
import { Icon } from '../components/Icon'
import { PageHead } from '../components/PageHead'
import { PageSection, PageShell } from '../components/PageShell'
import { RouteState } from '../components/RouteState'
import { classifyRouteError } from '../lib/classifyRouteError'
import { plural } from '../lib/plural'
import { libraryFeatureUnavailable } from '../lib/libraryCopy'
import { isAbort } from '../lib/libraryTree'

function isUnavailable(error: unknown): boolean {
  return isProductApiError(error) && (error.status === 404 || error.code === 'resource_not_found')
}

function targetTitle(action: OrganizePlanAction): string {
  return action.target.title
}

export function AiOrganize() {
  const enabled = isAiOrganizeExposureEnabled()
  const navigate = useNavigate()
  const { success } = useToast()
  const confirm = useConfirm()
  const [collections, setCollections] = useState<OwnedCollectionListItem[]>([])
  const [collectionId, setCollectionId] = useState<string | null>(null)
  const [plan, setPlan] = useState<OrganizePlan | null>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [loading, setLoading] = useState(enabled)
  const [applying, setApplying] = useState(false)
  const [unavailable, setUnavailable] = useState(false)
  const [needsAuth, setNeedsAuth] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [applyError, setApplyError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const createPlan = useCallback(async (id: string, signal: AbortSignal) => {
    setError(null)
    setApplyError(null)
    setUnavailable(false)
    setNeedsAuth(false)
    setPlan(null)
    setSelectedIds([])
    try {
      const next = await productClient.createCollectionOrganizePlan(
        id,
        {},
        {
          intentId: productClient.mutationIntentKey('create-organize-plan', productClient.newCommandId()),
          maxRetries: 0,
          signal,
        },
      )
      if (signal.aborted) return
      setPlan(next)
      setSelectedIds(next.actions.map((action) => action.id))
    } catch (err) {
      if (isAbort(err) || signal.aborted) return
      setPlan(null)
      setSelectedIds([])
      const kind = classifyRouteError(err)
      if (kind === 'unavailable' || isUnavailable(err)) {
        setUnavailable(true)
        return
      }
      if (kind === 'auth') {
        setNeedsAuth(true)
        return
      }
      setError("Couldn't load an organize plan. Try again.")
    }
  }, [])

  const load = useCallback(async () => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setLoading(true)
    setError(null)
    setUnavailable(false)
    setNeedsAuth(false)
    setPlan(null)
    setSelectedIds([])
    try {
      const page = await productClient.getOwnedCollectionsPage(
        {},
        { signal: controller.signal, maxRetries: 0 },
      )
      if (controller.signal.aborted) return
      setCollections(page.items)
      if (page.items.length === 1) {
        const id = page.items[0]!.collection.id
        setCollectionId(id)
        await createPlan(id, controller.signal)
      } else {
        setCollectionId(null)
      }
    } catch (err) {
      if (isAbort(err) || controller.signal.aborted) return
      setCollections([])
      setPlan(null)
      setSelectedIds([])
      const kind = classifyRouteError(err)
      if (kind === 'unavailable' || isUnavailable(err)) {
        setUnavailable(true)
      } else if (kind === 'auth') {
        setNeedsAuth(true)
      } else {
        setError("Couldn't load an organize plan. Try again.")
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }, [createPlan])

  useEffect(() => {
    if (!enabled) return
    void load()
    return () => {
      abortRef.current?.abort()
    }
  }, [enabled, load])

  const pickCollection = useCallback(async (id: string) => {
    setCollectionId(id)
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setLoading(true)
    try {
      await createPlan(id, controller.signal)
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }, [createPlan])

  const applySelected = useCallback(async () => {
    if (!collectionId || !plan || selectedIds.length === 0) return
    const ok = await confirm({
      title: 'Apply organize suggestions?',
      body: `Apply ${plural(selectedIds.length, 'action')} to this collection?`,
      confirmLabel: 'Apply',
    })
    if (!ok) return
    setApplying(true)
    setApplyError(null)
    try {
      await productClient.applyCollectionOrganizePlan(
        collectionId,
        plan.planId,
        { actionIds: selectedIds },
        {
          intentId: productClient.mutationIntentKey('apply-organize-plan', productClient.newCommandId()),
          ifMatch: plan.etag,
          maxRetries: 0,
        },
      )
      const organizedCount = plan.actions
        .filter((action) => selectedIds.includes(action.id))
        .reduce((total, action) => total + (Number.isFinite(action.count) ? action.count : 0), 0)
      success(organizedCount > 0
        ? `Organized ${plural(organizedCount, 'bookmark')}`
        : 'Organize plan applied')
      navigate(`/library/${collectionId}`)
    } catch (err) {
      if (isAbort(err)) return
      const kind = classifyRouteError(err)
      if (kind === 'unavailable' || isUnavailable(err)) {
        setUnavailable(true)
      } else if (kind === 'auth') {
        setNeedsAuth(true)
      } else {
        setApplyError('Could not apply the organize plan. Try again.')
      }
    } finally {
      setApplying(false)
    }
  }, [collectionId, confirm, navigate, plan, selectedIds, success])

  const retry = useCallback(() => {
    if (collectionId) {
      void pickCollection(collectionId)
    } else {
      void load()
    }
  }, [collectionId, load, pickCollection])

  const toggleAction = useCallback((id: string) => {
    setApplyError(null)
    setSelectedIds((current) => (
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    ))
  }, [])

  if (!enabled) {
    return (
      <PageShell variant="grid" data-testid="ai-organize-flag-off">
        <EmptyState
          icon="folder"
          titleAs="h1"
          title="AI organize is not available yet"
          description={libraryFeatureUnavailable('AI organize')}
        />
      </PageShell>
    )
  }

  const actions = plan?.actions ?? []
  const applyDisabled = selectedIds.length === 0 || applying || loading || !plan

  return (
    <PageShell variant="grid" sections>
      <PageSection>
        <PageHead
          variant="workbench"
          breadcrumb={
            <Breadcrumb items={[{ label: 'Library', to: '/library' }, { label: 'AI organize' }]} />
          }
          title="Organize messy folders"
          documentTitle="AI organize"
          lede="Review a proposed restructure of your collections. Nothing moves until you apply."
        />
      </PageSection>

      <PageSection>
        {collections.length > 1 && (
          <SelectMenu
            className="ai-collection-pick"
            label="Collection to organize"
            prefix="Collection:"
            testId="ai-collection-pick"
            value={collectionId ?? ''}
            options={[
              ...(collectionId ? [] : [{ value: '', label: 'Choose…' }]),
              ...collections.map((item) => ({ value: item.collection.id, label: item.collection.title })),
            ]}
            onChange={(id) => { if (id) void pickCollection(id) }}
          />
        )}
        {needsAuth ? (
          <RouteState
            kind="auth"
            icon="folder"
            title="Sign in to organize your folders"
            description="You need to be signed in to organize collections you own."
          />
        ) : unavailable ? (
          <RouteState
            kind="unavailable"
            icon="folder"
            title="AI organize is not available yet"
            feature="AI organize"
          />
        ) : error ? (
          <RouteState
            kind="error"
            icon="folder"
            title="Couldn't load an organize plan"
            description={error}
            onRetry={retry}
          />
        ) : loading && actions.length === 0 ? (
          <LoadingState label="Loading organize plan…" />
        ) : collections.length === 0 ? (
          <EmptyState
            icon="collection"
            title="No collections yet"
            description="Create a collection in your library before organizing it."
            action={
              <Link to="/library" className="btn btn-secondary btn-sm">
                Open library
              </Link>
            }
          />
        ) : collections.length > 1 && !collectionId ? (
          <EmptyState
            icon="collection"
            title="Select a collection"
            description="Choose which collection to organize from the buttons above."
          />
        ) : actions.length === 0 ? (
          <EmptyState
            icon="folder"
            title="No organize suggestions"
            description="This collection is already well organized."
          />
        ) : (
          <div className="ai-plan-list" data-testid="ai-plan-list">
            {actions.map((action) => {
              const selected = selectedIds.includes(action.id)
              return (
                <button
                  type="button"
                  key={action.id}
                  className="ai-plan-row"
                  data-testid="ai-plan-row"
                  role="checkbox"
                  aria-checked={selected}
                  onClick={() => toggleAction(action.id)}
                >
                  <span className="ai-plan-check" aria-hidden>{selected ? <Icon name="check" /> : null}</span>
                  <div className="ai-plan-body">
                    <strong>
                      {action.sourceFolderTitle}
                      <Icon name="arrow-right" className="ai-plan-arrow" />
                      {targetTitle(action)}
                    </strong>
                    <p>{plural(action.count, 'item')} · {action.reason}</p>
                  </div>
                </button>
              )
            })}
          </div>
        )}
        {!needsAuth && !unavailable && !error && collectionId !== null && (
          <div className="row ai-plan-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={applyDisabled}
              onClick={() => void applySelected()}
            >
              Apply selected
            </button>
            <Link to="/classify" className="btn btn-secondary">
              Classify one link
            </Link>
            {applyError && (
              <p className="field-error ai-plan-error" role="alert">
                {applyError}
              </p>
            )}
          </div>
        )}
      </PageSection>
    </PageShell>
  )
}
