import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import {
  ProductApiError,
  isWriteApprovalsExposureEnabled,
  productClient,
  recoveryStrategyFor,
  type WriteApprovalDecision,
  type WriteApprovalView,
} from '../../api'
import { useAuth } from '../../auth/AuthContext'
import { useToast } from '../../components/AppToast'
import { readRouteCache, writeRouteCache } from '../../lib/routeCache'
import { LOGIN_REASON_APPROVAL_REQUIRED } from '../loginReason'
import { idleDraft, isDecisionAllowed, type DecisionDraft } from './types'

// Mirrors the Product API `planId` path contract enforced by
// Known-Backend/src/routes/mcp-write-approval-routes.ts and its OpenAPI schema.
const PLAN_ID_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/u

/* List ↔ detail hops remount this hook (separate route elements). The route
   cache paints the rows the user just saw instead of replaying "Loading write
   approvals…"; the network revalidates behind them. */
const APPROVALS_CACHE_KEY = 'write-approvals'

function isExplicitAuthenticationFailure(error: unknown): boolean {
  return error instanceof ProductApiError
    && error.status === 401
    && error.isAuthRequired
}

export function useWriteApprovals() {
  const enabled = isWriteApprovalsExposureEnabled()
  const { planId: routePlanId } = useParams<{ planId?: string }>()
  const detailMode = routePlanId !== undefined
  const planId = detailMode && PLAN_ID_PATTERN.test(routePlanId) ? routePlanId : null
  const invalidPlanId = detailMode && planId === null
  const { isLoggedIn, bootstrapping } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const returnTo = `${location.pathname}${location.search}${location.hash}`
  const restoredApprovals = readRouteCache<WriteApprovalView[]>(APPROVALS_CACHE_KEY)
  const [approvals, setApprovals] = useState<WriteApprovalView[]>(() => {
    if (restoredApprovals === undefined) return []
    if (!planId) return restoredApprovals
    const cached = restoredApprovals.find((item) => item.planId === planId)
    return cached ? [cached] : []
  })
  const [loading, setLoading] = useState(approvals.length === 0)
  const [refreshing, setRefreshing] = useState(false)
  const [missingDetail, setMissingDetail] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loadErrorKind, setLoadErrorKind] = useState<'auth' | 'csrf' | 'unavailable' | 'other' | null>(null)
  const [drafts, setDrafts] = useState<Record<string, DecisionDraft>>({})
  /* Operation previews carry opaque collection/node ids; resolving them to
     owned-collection titles keeps the card human-readable (R10-19). Ids
     that do not resolve still render — as quiet .meta code, not chrome. */
  const [collectionTitles, setCollectionTitles] = useState<ReadonlyMap<string, string>>(new Map())
  const mounted = useRef(true)
  const approvalsRef = useRef(approvals)
  approvalsRef.current = approvals
  const authRedirected = useRef(false)
  const { success } = useToast()

  const redirectToLogin = useCallback(() => {
    if (authRedirected.current) return
    authRedirected.current = true
    const params = new URLSearchParams({
      returnTo,
      reason: LOGIN_REASON_APPROVAL_REQUIRED,
    })
    navigate(`/login?${params.toString()}`, { replace: true })
  }, [navigate, returnTo])

  const updateDraft = useCallback((id: string, draft: DecisionDraft) => {
    setDrafts((current) => ({ ...current, [id]: draft }))
  }, [])

  const load = useCallback(async (kind: 'initial' | 'refresh', signal?: AbortSignal) => {
    if (!enabled || bootstrapping || !isLoggedIn || invalidPlanId) {
      if (mounted.current) {
        setLoading(false)
        setRefreshing(false)
        setLoadError(null)
        setLoadErrorKind(null)
      }
      return
    }
    // A remount with cached rows revalidates behind them instead of
    // replaying the loading state over content that is already on screen.
    if (kind === 'initial' && approvalsRef.current.length === 0) setLoading(true)
    else setRefreshing(true)
    setLoadError(null)
    setLoadErrorKind(null)
    setMissingDetail(false)
    try {
      const items = planId
        ? [await productClient.getWriteApproval(planId, { signal, maxRetries: 0 })]
        : (await productClient.getWriteApprovalPage(
            { limit: 100 },
            { signal, maxRetries: 0 },
          )).items
      if (signal?.aborted || !mounted.current) return
      setApprovals(planId ? items.filter((item) => item.planId === planId) : items)
      if (!planId) writeRouteCache(APPROVALS_CACHE_KEY, items)
      if (planId && items[0]?.planId !== planId) {
        setLoadError('The requested approval returned an unexpected plan. Try opening the link again.')
        setLoadErrorKind('other')
      }
    } catch (error) {
      // See src/pages/sync/data.ts: the success path guards on the signal, so the
      // catch must too, or a rejected request from the superseded mount pass
      // still drives setLoadError / setMissingDetail / redirectToLogin.
      if (signal?.aborted) return
      if (error instanceof DOMException && error.name === 'AbortError') return
      if (!mounted.current) return
      const apiError = error instanceof ProductApiError ? error : null
      if (isExplicitAuthenticationFailure(error)) {
        redirectToLogin()
        return
      }
      if (detailMode && (apiError?.status === 404 || apiError?.code === 'resource_not_found')) {
        setApprovals([])
        setMissingDetail(true)
        return
      }
      if (!detailMode && (apiError?.status === 404 || apiError?.code === 'resource_not_found')) {
        setApprovals([])
        setLoadError('Write approvals are not available yet')
        setLoadErrorKind('unavailable')
        return
      }
      setLoadError(apiError?.isAuthRequired
        ? 'Sign in to continue.'
        : apiError?.isCsrfFailed
          ? 'Session security token expired. Try again.'
          : apiError?.recoveryHint ?? "Couldn't load write approvals")
      setLoadErrorKind(apiError?.isAuthRequired ? 'auth' : apiError?.isCsrfFailed ? 'csrf' : 'other')
    } finally {
      if (mounted.current) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [bootstrapping, detailMode, enabled, invalidPlanId, isLoggedIn, planId, redirectToLogin])

  useEffect(() => {
    if (!enabled || bootstrapping || isLoggedIn) return
    redirectToLogin()
  }, [bootstrapping, enabled, isLoggedIn, redirectToLogin])

  useEffect(() => {
    mounted.current = true
    const controller = new AbortController()
    if (enabled && !bootstrapping && isLoggedIn && !invalidPlanId) {
      void load('initial', controller.signal)
    }
    else setLoading(false)
    return () => {
      mounted.current = false
      controller.abort()
    }
  }, [bootstrapping, enabled, invalidPlanId, isLoggedIn, load])

  useEffect(() => {
    if (!enabled || bootstrapping || !isLoggedIn) return
    const controller = new AbortController()
    productClient.loadOwnedCollections({ limit: 100 }, { signal: controller.signal, maxRetries: 0 })
      .then((items) => {
        if (!controller.signal.aborted && mounted.current) {
          setCollectionTitles(new Map(items.map((item) => [item.collection.id, item.collection.title])))
        }
      })
      .catch(() => { /* unresolved ids degrade to muted code */ })
    return () => controller.abort()
  }, [bootstrapping, enabled, isLoggedIn])

  const refreshApproval = useCallback(async (approvalId: string): Promise<WriteApprovalView | null> => {
    try {
      const view = await productClient.getWriteApproval(approvalId, { maxRetries: 0 })
      if (!mounted.current) return null
      setApprovals((items) => items.map((item) => item.planId === approvalId ? view : item))
      const cached = readRouteCache<WriteApprovalView[]>(APPROVALS_CACHE_KEY)
      if (cached?.some((item) => item.planId === approvalId)) {
        writeRouteCache(APPROVALS_CACHE_KEY, cached.map((item) => item.planId === approvalId ? view : item))
      }
      return view
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      const apiError = error instanceof ProductApiError ? error : null
      if (isExplicitAuthenticationFailure(error)) {
        redirectToLogin()
        throw error
      }
      if (apiError?.status === 404 || apiError?.code === 'resource_not_found') {
        if (mounted.current) {
          setApprovals((items) => items.filter((item) => item.planId !== approvalId))
          if (detailMode && planId === approvalId) setMissingDetail(true)
        }
        const cached = readRouteCache<WriteApprovalView[]>(APPROVALS_CACHE_KEY)
        if (cached) writeRouteCache(APPROVALS_CACHE_KEY, cached.filter((item) => item.planId !== approvalId))
        return null
      }
      throw error
    }
  }, [detailMode, planId, redirectToLogin])

  const handleDecision = useCallback(async (
    approval: WriteApprovalView,
    decision: WriteApprovalDecision,
    replay = false,
  ) => {
    const currentDraft = drafts[approval.planId] ?? idleDraft
    let frozen = replay ? currentDraft.frozen : null
    if (!frozen) {
      if (!isDecisionAllowed(approval)) return
      frozen = {
        intentId: `write-approval:${approval.planId}:${decision}:${crypto.randomUUID()}`,
        decision,
        etag: approval.etag,
      }
    }
    updateDraft(approval.planId, {
      phase: 'submitting',
      message: null,
      frozen,
      desiredDecision: decision,
    })
    try {
      await productClient.decideWriteApproval(approval.planId, frozen.decision, frozen.etag, {
        intentId: frozen.intentId,
        maxRetries: 0,
        clearIntentOnSuccess: false,
      })
      productClient.abandonWriteApprovalIntent(frozen.intentId)
      try {
        const latest = await refreshApproval(approval.planId)
        if (!mounted.current) return
        if (latest) updateDraft(latest.planId, idleDraft)
      } catch {
        if (mounted.current) {
          updateDraft(approval.planId, {
            phase: 'blocked',
            message: 'Decision saved. Refresh to see the latest status.',
            frozen: null,
            desiredDecision: decision,
          })
        }
      }
      success(frozen.decision === 'approve' ? 'Plan approved' : 'Plan denied')
    } catch (error) {
      if (!mounted.current) return
      if (error instanceof DOMException && error.name === 'AbortError') return
      const apiError = error instanceof ProductApiError
        ? error
        : new ProductApiError({
            status: 0,
            code: 'transport_error',
            message: 'The decision may not have been recorded.',
            recovery: 'same_request',
            sameRequestRetrySafe: true,
          })

      if (isExplicitAuthenticationFailure(apiError)) {
        productClient.abandonWriteApprovalIntent(frozen.intentId)
        redirectToLogin()
        return
      }
      const strategy = recoveryStrategyFor(apiError)

      if (strategy === 'retry_same_command') {
        updateDraft(approval.planId, {
          phase: 'unknown',
          message: 'The decision may not have been recorded. Try again to confirm the result.',
          frozen,
          desiredDecision: decision,
        })
        return
      }

      if (apiError.status === 404 || apiError.code === 'resource_not_found') {
        productClient.abandonWriteApprovalIntent(frozen.intentId)
        try {
          await refreshApproval(approval.planId)
          if (mounted.current) updateDraft(approval.planId, idleDraft)
        } catch {
          updateDraft(approval.planId, {
            phase: 'blocked',
            message: "Couldn't load the latest approval.",
            frozen: null,
            desiredDecision: decision,
          })
        }
        return
      }

      if (
        strategy === 'refresh_and_retry'
        || apiError.status === 409
        || apiError.code === 'mutation_conflict'
      ) {
        productClient.abandonWriteApprovalIntent(frozen.intentId)
        try {
          const latest = await refreshApproval(approval.planId)
          if (!mounted.current) return
          if (!latest) {
            updateDraft(approval.planId, idleDraft)
            return
          }
          if (isDecisionAllowed(latest) && latest.etag !== frozen.etag) {
            updateDraft(approval.planId, {
              phase: 'stale',
              message: 'This plan changed. Review the latest version, then decide again.',
              frozen: null,
              desiredDecision: decision,
            })
          } else {
            updateDraft(approval.planId, idleDraft)
          }
        } catch {
          updateDraft(approval.planId, {
            phase: 'refresh_required',
            message: 'This plan changed. Refresh it before deciding again.',
            frozen: null,
            desiredDecision: decision,
          })
        }
        return
      }

      if (strategy === 'new_user_intent') {
        productClient.abandonWriteApprovalIntent(frozen.intentId)
        updateDraft(approval.planId, {
          phase: 'blocked',
          message: apiError.recoveryHint,
          frozen: null,
          desiredDecision: decision,
        })
        return
      }

      updateDraft(approval.planId, {
        phase: 'blocked',
        message: apiError.isAuthRequired
          ? 'Sign in to continue this decision.'
          : apiError.recoveryHint,
        frozen: null,
        desiredDecision: decision,
      })
    }
  }, [drafts, redirectToLogin, refreshApproval, success, updateDraft])

  const retryRefresh = useCallback(async (approval: WriteApprovalView) => {
    try {
      const latest = await refreshApproval(approval.planId)
      if (!mounted.current) return
      if (!latest) {
        updateDraft(approval.planId, idleDraft)
        return
      }
      updateDraft(approval.planId, {
        phase: isDecisionAllowed(latest) ? 'stale' : 'idle',
        message: isDecisionAllowed(latest)
          ? 'Review the latest version, then decide again.'
          : null,
        frozen: null,
        desiredDecision: drafts[approval.planId]?.desiredDecision ?? null,
      })
    } catch {
      updateDraft(approval.planId, {
        phase: 'refresh_required',
        message: "Couldn't load the latest approval. Try refreshing it again.",
        frozen: null,
        desiredDecision: drafts[approval.planId]?.desiredDecision ?? null,
      })
    }
  }, [drafts, refreshApproval, updateDraft])

  const startNewDecision = useCallback((approvalId: string) => {
    const frozen = drafts[approvalId]?.frozen
    if (frozen) productClient.abandonWriteApprovalIntent(frozen.intentId)
    updateDraft(approvalId, idleDraft)
  }, [drafts, updateDraft])

  return {
    enabled,
    detailMode,
    invalidPlanId,
    missingDetail,
    authPending: enabled && (bootstrapping || !isLoggedIn),
    approvals,
    loading,
    refreshing,
    loadError,
    loadErrorKind,
    drafts,
    collectionTitles,
    load,
    handleDecision,
    retryRefresh,
    startNewDecision,
  }
}

export type WriteApprovalsData = ReturnType<typeof useWriteApprovals>
