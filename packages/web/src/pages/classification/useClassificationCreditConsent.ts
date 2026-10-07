import { useCallback, useEffect, useState } from 'react'
import { productClient, ProductApiError } from '../../api'
import { getApiBaseUrl } from '../../api/config'
import { getSessionSnapshot, subscribeSession } from '../../api/sessionStore'
import { isAbort } from '../../lib/libraryTree'

type ClassificationBillingMode = 'managed' | 'legacy_free'

type CreditConsentState = {
  loading: boolean
  mode: ClassificationBillingMode | null
  priceVersion: string | null
  unitPoints: number | null
  available: number | null
  maxPoints: number | null
  consentKey: string
  error: string | null
  refresh: () => void
}

type ResolvedState = Omit<CreditConsentState, 'refresh' | 'consentKey'> & {
  scopeKey: string
}

function authorityIdentity(expectedAccountId?: string): string {
  const session = getSessionSnapshot()
  return `${getApiBaseUrl()}|${expectedAccountId ?? session.me?.account.id ?? ''}|${session.sessionEpoch}`
}

function initialState(scopeKey: string): ResolvedState {
  return {
    scopeKey,
    loading: true,
    mode: null,
    priceVersion: null,
    unitPoints: null,
    available: null,
    maxPoints: null,
    error: null,
  }
}

function errorMessage(cause: unknown): string {
  if (cause instanceof ProductApiError && cause.status === 401) {
    return 'Sign in again to confirm the current credit price.'
  }
  if (cause instanceof Error && cause.message === 'credit_account_changed') {
    return 'The signed-in account changed. Refresh to confirm the current credit price.'
  }
  if (cause instanceof Error && cause.message === 'classification_mode_unavailable') {
    return 'This classification mode is unavailable. Refresh the collection settings to continue.'
  }
  if (cause instanceof Error && cause.message === 'classification_price_missing') {
    return 'The current classification price is unavailable. Refresh to continue.'
  }
  return "Couldn't load the current credit price. Refresh to continue."
}

/** Reads the server price and execution mode before a hosted classification command. */
export function useClassificationCreditConsent(collectionId: string, units: number, expectedAccountId?: string): CreditConsentState {
  const [revision, setRevision] = useState(0)
  const [, setAuthorityRevision] = useState(0)
  const authority = authorityIdentity(expectedAccountId)
  const scopeKey = `${authority}|${collectionId}|${units}`
  const [state, setState] = useState<ResolvedState>(() => initialState(scopeKey))

  useEffect(() => subscribeSession(() => setAuthorityRevision(previous => previous + 1)), [expectedAccountId])

  useEffect(() => {
    const controller = new AbortController()
    const requestScope = scopeKey
    setState(initialState(requestScope))
    void (async () => {
      try {
        if (!Number.isInteger(units) || units < 0) {
          throw new Error('classification_price_missing')
        }
        const settings = await productClient.getClassificationSettings(collectionId, {
          signal: controller.signal, maxRetries: 0,
        })
        const executionMode = settings.settings.executionMode
        if (executionMode !== 'server_managed') {
          throw new Error('classification_mode_unavailable')
        }
        const mode: ClassificationBillingMode = 'managed'
        const overview = await productClient.getMyCredits({ signal: controller.signal, maxRetries: 0 })
        const verifiedAccountId = expectedAccountId ?? getSessionSnapshot().me?.account.id
        if (!verifiedAccountId || overview.accountId !== verifiedAccountId) throw new Error('credit_account_changed')
        if (overview.managedClassificationBillingMode === 'legacy_free') {
          if (!controller.signal.aborted) setState({
            scopeKey: requestScope, loading: false, mode: 'legacy_free',
            priceVersion: null, unitPoints: null, available: null, maxPoints: 0, error: null,
          })
          return
        }
        const price = overview.prices.find(item => item.operationType === 'bookmark.classify')
        if (!price || !Number.isSafeInteger(price.unitPoints) || price.unitPoints < 1) throw new Error('classification_price_missing')
        const maxPoints = units * price.unitPoints
        if (!controller.signal.aborted) setState({
          scopeKey: requestScope,
          loading: false, mode, priceVersion: price.priceVersion,
          unitPoints: price.unitPoints, available: overview.balance.available,
          maxPoints, error: null,
        })
      } catch (cause) {
        if (isAbort(cause) || controller.signal.aborted) return
        setState(previous => ({ ...previous, scopeKey: requestScope, loading: false, error: errorMessage(cause) }))
      }
    })()
    return () => controller.abort()
  }, [collectionId, revision, scopeKey, units, expectedAccountId])

  const refresh = useCallback(() => setRevision(previous => previous + 1), [])
  const visibleState = state.scopeKey === scopeKey ? state : initialState(scopeKey)
  const consentKey = visibleState.loading
    ? `${scopeKey}|loading`
    : `${scopeKey}|${visibleState.mode ?? 'unavailable'}|${visibleState.priceVersion ?? 'free'}|${visibleState.unitPoints ?? 0}`
  return { ...visibleState, consentKey, refresh }
}

export function isCreditPriceChanged(error: unknown): boolean {
  return error instanceof ProductApiError && (error.code === 'credit_price_changed' || error.code === 'billing_consent_required')
}
