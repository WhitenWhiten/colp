import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  ProductApiError,
  productClient,
  type CreditLedgerEntry,
  type CreditLedgerPage,
} from '../api'
import { EmptyState, LoadingState } from '../components/EmptyState'
import { RouteState } from '../components/RouteState'
import { SelectMenu } from '../components/SelectMenu'
import { StatusBadge, type StatusTone } from '../components/StatusBadge'
import { LoadMoreButton } from '../components/LoadMoreButton'
import { PageHead } from '../components/PageHead'
import { PageSection, PageShell } from '../components/PageShell'
import { DataTable, DataTableCell, DataTableRow } from '../components/DataTable'
import { useAuth } from '../auth/AuthContext'
import { getApiBaseUrl } from '../api/config'
import { getSessionSnapshot } from '../api/sessionStore'
import { formatInstant, formatTimeZoneName } from '../lib/formatDate'
import '../styles/credits.css'

const KINDS = ['all', 'grant', 'spend', 'refund', 'topup', 'reserve', 'release', 'expire', 'payment_refund'] as const
type KindFilter = (typeof KINDS)[number]

type LedgerFilters = {
  kind: KindFilter
  from: string
  to: string
  chargeId: string
  runId: string
}

type LoadState = 'loading' | 'ready' | 'auth' | 'offline' | 'error' | 'cursor-expired'

function initialFilters(params: URLSearchParams): LedgerFilters {
  const kind = params.get('kind')
  return {
    kind: KINDS.includes(kind as KindFilter) ? kind as KindFilter : 'all',
    from: params.get('from') ?? '',
    to: params.get('to') ?? '',
    chargeId: params.get('chargeId') ?? '',
    runId: params.get('runId') ?? '',
  }
}

function filtersKey(filters: LedgerFilters): string {
  return JSON.stringify(filters)
}

function isoDate(value: string): string | undefined {
  if (!value) return undefined
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString()
}

function filterError(filters: LedgerFilters): string | null {
  if (filters.from && !isoDate(filters.from)) return 'The start time is invalid. Choose a valid date and time.'
  if (filters.to && !isoDate(filters.to)) return 'The end time is invalid. Choose a valid date and time.'
  if (filters.from && filters.to && new Date(filters.from).valueOf() >= new Date(filters.to).valueOf()) {
    return 'The start time must be earlier than the end time.'
  }
  return null
}

function formatPoints(value: number): string {
  return new Intl.NumberFormat('en-US').format(value)
}

function signedPoints(value: number): string {
  return `${value > 0 ? '+' : ''}${formatPoints(value)}`
}

/* Compact "what moved" line under the points figure — only when the entry
   shifted credits between the available and held buckets, which the net
   points delta alone cannot express (reserve/release, split deltas). */
function deltaBreakdown(entry: CreditLedgerEntry): string | null {
  const parts: string[] = []
  if (entry.availableDelta !== 0 && entry.availableDelta !== entry.pointsDelta) {
    parts.push(`${signedPoints(entry.availableDelta)} avail`)
  }
  if (entry.reservedDelta !== 0) parts.push(`${signedPoints(entry.reservedDelta)} held`)
  return parts.length > 0 ? parts.join(' · ') : null
}

const KIND_LABEL: Record<CreditLedgerEntry['kind'], string> = {
  grant: 'Granted', reserve: 'Reserved', spend: 'Spent', release: 'Released',
  expire: 'Expired', refund: 'Refunded', topup: 'Top-up', payment_refund: 'Payment refund',
}
function kindLabel(kind: CreditLedgerEntry['kind']): string {
  return KIND_LABEL[kind] ?? 'Other'
}

/* Ledger kinds carry the shared <StatusBadge> tones: inflow reads
   success, a loss to expiry reads warning, ordinary spending and bucket
   moves stay quiet. */
const KIND_TONE: Record<string, StatusTone> = {
  grant: 'success',
  topup: 'success',
  refund: 'success',
  spend: 'neutral',
  expire: 'warning',
  payment_refund: 'neutral',
  reserve: 'accent',
  release: 'accent',
}

const SOURCE_LABEL: Record<CreditLedgerEntry['source'], string> = {
  extension: 'Browser extension',
  web: 'Web',
  batch: 'Batch classification',
  operator: 'Know-N support',
  scheduler: 'Scheduled grant',
  system: 'Know-N',
  payment: 'Payment',
}
function sourceLabel(source: CreditLedgerEntry['source']): string {
  return SOURCE_LABEL[source] ?? 'Other'
}

const REASON_LABEL: Record<CreditLedgerEntry['reasonCode'], string> = {
  trial_grant: 'Trial credits', manual_grant: 'Manual grant',
  classification_requested: 'Classification requested', classification_completed: 'Classification completed',
  classification_failed: 'Classification failed', classification_cancelled: 'Classification cancelled',
  classification_unneeded: 'Classification not needed', credits_expired: 'Credits expired',
  hold_expired: 'Hold expired', manual_refund: 'Manual refund',
  payment_received: 'Payment received', payment_refunded: 'Payment refunded',
}
function reasonLabel(reason: CreditLedgerEntry['reasonCode']): string {
  return REASON_LABEL[reason] ?? 'Other'
}

function isAuthError(error: unknown): boolean {
  return error instanceof ProductApiError && (error.status === 401 || error.code === 'authentication_required')
}

function isCursorExpired(error: unknown): boolean {
  return error instanceof ProductApiError && (error.status === 410 || error.code === 'cursor_expired')
}

function ledgerErrorMessage(error: unknown): string {
  if (!(error instanceof ProductApiError)) return "Couldn't load your credit history. Try again."
  if (isAuthError(error)) return 'Your session ended. Sign in again to view this ledger.'
  if (error.code === 'invalid_cursor') return 'This ledger page is invalid. Start again from the first page.'
  if (error.code === 'credits_busy' || error.code === 'credits_reconciling') return 'Credits are being reconciled. Retry shortly.'
  if (error.code === 'credits_unavailable') return 'The credit ledger is temporarily unavailable. Retry shortly.'
  if (error.code === 'rate_limited') return 'The ledger is receiving too many requests. Retry shortly.'
  return error.recoveryHint
}

function isLegacyClassificationEntry(entry: CreditLedgerEntry): boolean {
  return entry.operationType === 'bookmark.classify' && entry.chargeId === null && entry.task === null
}

function queryFor(filters: LedgerFilters, cursor?: string) {
  if (cursor) return { cursor }
  return {
    limit: 20,
    kind: filters.kind === 'all' ? undefined : filters.kind,
    from: isoDate(filters.from),
    to: isoDate(filters.to),
    chargeId: filters.chargeId || undefined,
    runId: filters.runId || undefined,
  }
}

export function Credits() {
  const { user, bootstrapping } = useAuth()
  const [params, setParams] = useSearchParams()
  const filterSearch = new URLSearchParams(['kind', 'from', 'to', 'chargeId', 'runId']
    .map(key => [key, params.get(key) ?? ''])).toString()
  const filters = useMemo(() => initialFilters(new URLSearchParams(filterSearch)), [filterSearch])
  const [draft, setDraft] = useState(filters)
  useEffect(() => setDraft(filters), [filters])
  const advancedCount = [filters.from, filters.to, filters.chargeId, filters.runId].filter(Boolean).length
  const [moreOpen, setMoreOpen] = useState(advancedCount > 0)
  useEffect(() => { if (advancedCount > 0) setMoreOpen(true) }, [advancedCount])
  const [page, setPage] = useState<CreditLedgerPage | null>(null)
  const [pageAuthorityKey, setPageAuthorityKey] = useState<string | null>(null)
  const [selected, setSelected] = useState<CreditLedgerEntry | null>(null)
  const [selectedAuthorityKey, setSelectedAuthorityKey] = useState<string | null>(null)
  const [state, setState] = useState<LoadState>('loading')
  const [error, setError] = useState<string | null>(null)
  const [refreshSuggested, setRefreshSuggested] = useState(false)
  const [, setSessionRevision] = useState(0)
  const [cursorLoading, setCursorLoading] = useState(false)
  const authorityGeneration = useRef(0)
  const requestController = useRef<AbortController | null>(null)
  const entryId = params.get('entryId')
  const authorityKey = `${getApiBaseUrl()}|${user?.accountId ?? ''}|${getSessionSnapshot().sessionEpoch}`
  const authorityKeyRef = useRef(authorityKey)
  if (authorityKeyRef.current !== authorityKey) {
    authorityKeyRef.current = authorityKey
    authorityGeneration.current += 1
    requestController.current?.abort()
  }
  const activeFiltersKey = filtersKey(filters)
  const pageScopeKey = `${authorityKey}|${activeFiltersKey}`
  const detailScopeKey = `${authorityKey}|${entryId ?? ''}`

  useEffect(() => productClient.subscribeSession(() => setSessionRevision(previous => previous + 1)), [])

  useEffect(() => {
    const onFocus = () => setRefreshSuggested(true)
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [])

  const updateFilter = (patch: Partial<LedgerFilters>) => {
    const next = { ...draft, ...patch }
    setDraft(next)
    if (filtersKey(next) === activeFiltersKey) { void loadFirst(); return }
    setState('loading')
    setParams(current => {
      const updated = new URLSearchParams(current)
      updated.delete('entryId')
      for (const key of ['kind', 'from', 'to', 'chargeId', 'runId'] as const) {
        const value = next[key]
        if (value && !(key === 'kind' && value === 'all')) updated.set(key, value)
        else updated.delete(key)
      }
      return updated
    }, { replace: true })
  }

  const loadFirst = useCallback(async () => {
    const generation = ++authorityGeneration.current
    requestController.current?.abort()
    const controller = new AbortController()
    requestController.current = controller
    setState(user ? 'loading' : bootstrapping ? 'loading' : 'auth')
    setError(null)
    setCursorLoading(false)
    setPage(null)
    setPageAuthorityKey(null)
    if (!user) return
    const requestedAccountId = user.accountId
    const localFilterError = filterError(filters)
    if (localFilterError) {
      setState('error')
      setError(localFilterError)
      return
    }
    try {
      const next = await productClient.listMyCreditLedger(queryFor(filters), { signal: controller.signal, maxRetries: 0 })
      if (controller.signal.aborted || generation !== authorityGeneration.current) return
      if (next.accountId !== requestedAccountId || authorityKeyRef.current !== authorityKey) {
        setState('error')
        setError('The ledger account changed while it was loading. Refresh to load the verified account.')
        return
      }
      setPage(next)
      setPageAuthorityKey(pageScopeKey)
      setState('ready')
      setRefreshSuggested(false)

    } catch (loadError) {
      if (controller.signal.aborted || generation !== authorityGeneration.current) return
      setState(isAuthError(loadError) ? 'auth' : !navigator.onLine ? 'offline' : 'error')
      setError(ledgerErrorMessage(loadError))
    } finally {
      if (requestController.current === controller) requestController.current = null
    }
  }, [authorityKey, bootstrapping, filters, pageScopeKey, user])

  useEffect(() => {
    void loadFirst()
    return () => {
      requestController.current?.abort()
      authorityGeneration.current += 1
    }
  }, [loadFirst, activeFiltersKey])

  useEffect(() => {
    const controller = new AbortController()
    setSelected(null)
    setSelectedAuthorityKey(null)
    if (!entryId || !user) return () => controller.abort()
    void productClient.getMyCreditLedgerEntry(entryId, { signal: controller.signal, maxRetries: 0 }).then(detail => {
      if (controller.signal.aborted || authorityKeyRef.current !== authorityKey) return
      setSelected(detail.entry)
      setSelectedAuthorityKey(detailScopeKey)
    }).catch(cause => {
      if (controller.signal.aborted || authorityKeyRef.current !== authorityKey) return
      if (isAuthError(cause)) { setState('auth'); setPage(null); setPageAuthorityKey(null) }
      setError(isAuthError(cause) ? 'Your session ended. Sign in again to view this ledger.' : 'This ledger entry is unavailable.')
    })
    return () => controller.abort()
  }, [authorityKey, detailScopeKey, entryId, user])

  const loadMore = useCallback(async () => {
    if (!page?.nextCursor || cursorLoading || !user) return
    const generation = authorityGeneration.current
    const controller = new AbortController()
    requestController.current = controller
    setCursorLoading(true)
    try {
      const next = await productClient.listMyCreditLedger(queryFor(filters, page.nextCursor), { maxRetries: 0, signal: controller.signal })
      if (generation !== authorityGeneration.current || authorityKeyRef.current !== authorityKey) return
      if (next.accountId !== user.accountId) {
        setError('The ledger account changed while loading older entries. Refresh to load the verified account.')
        return
      }
      setPage((previous) => previous ? { ...next, items: [...previous.items, ...next.items] } : next)
    } catch (loadError) {
      if (generation !== authorityGeneration.current) return
      if (isCursorExpired(loadError)) setState('cursor-expired')
      else setError(loadError instanceof ProductApiError ? ledgerErrorMessage(loadError) : "Couldn't load more history.")
    } finally {
      if (generation === authorityGeneration.current) setCursorLoading(false)
      if (requestController.current === controller) requestController.current = null
    }
  }, [authorityKey, cursorLoading, filters, page, user])

  const currentPage = pageAuthorityKey === pageScopeKey && page?.accountId === user?.accountId ? page : null
  const currentSelected = selectedAuthorityKey === detailScopeKey ? selected : null
  const selectedId = currentSelected?.entryId
  const balance = currentPage?.snapshot.balance
  const columns = useMemo(() => [
    { key: 'posted', label: 'Posted' },
    { key: 'kind', label: 'Type' },
    { key: 'purpose', label: 'Purpose' },
    { key: 'points', label: 'Credits', className: 'credits-table-num' },
    { key: 'balance', label: 'Balance after', className: 'credits-table-num' },
  ], [])

  const selectEntry = (entry: CreditLedgerEntry) => {
    setParams((current) => {
      const next = new URLSearchParams(current)
      next.set('entryId', entry.entryId)
      return next
    }, { replace: true })
  }

  if (state === 'auth' && !user && !bootstrapping) {
    return (
      <PageShell variant="grid" data-testid="credits-auth">
        <PageHead
          layout="split"
          variant="workbench"
          eyebrow="Account"
          title="Credits and ledger"
          documentTitle="Credits and ledger"
          lede="See the credits you received, spent, got back and lost to expiry."
          meta={{ robots: 'noindex', canonicalPath: null }}
        />
        <RouteState kind="auth" title="Sign in to view your credits" description="Your credit ledger is private to your account." />
      </PageShell>
    )
  }

  const unfiltered = filters.kind === 'all' && !filters.from && !filters.to && !filters.chargeId && !filters.runId
  const ledgerNeverUsed = unfiltered && currentPage != null && currentPage.items.length === 0 && !currentPage.nextCursor

  return (
    <PageShell variant="grid" data-testid="credits-page" sections>
      <PageSection>
        <PageHead
          layout="split"
          variant="workbench"
          eyebrow="Account"
          title="Credits and ledger"
          documentTitle="Credits and ledger"
          lede="See the credits you received, spent, got back and lost to expiry."
          meta={{ robots: 'noindex', canonicalPath: null }}
          actions={<button type="button" className="btn btn-secondary btn-sm" onClick={() => void loadFirst()} disabled={state === 'loading'}>Refresh</button>}
        />
      </PageSection>

      <PageSection className="credits-overview" aria-label="Credit balance">
        <dl className="credits-balance-grid">
          <div className="credits-balance-item credits-balance-item--lead"><dt className="meta">Available</dt><dd><strong>{balance ? formatPoints(balance.available) : '—'}</strong></dd></div>
          <div className="credits-balance-item"><dt className="meta">In progress</dt><dd><strong>{balance ? formatPoints(balance.reserved) : '—'}</strong></dd></div>
          <div className="credits-balance-item"><dt className="meta">Next expiry</dt><dd><strong>{balance ? (balance.nextExpiryAt ? formatInstant(balance.nextExpiryAt) : 'None scheduled') : '—'}</strong></dd></div>
          <div className={`credits-balance-item${balance && balance.expiringPoints > 0 ? ' credits-balance-item--warn' : ''}`}><dt className="meta">Credits expiring</dt><dd><strong>{balance ? formatPoints(balance.expiringPoints) : '—'}</strong></dd></div>
        </dl>
      </PageSection>

      <PageSection className="credits-content">
        {refreshSuggested && <div className="credits-refresh-note" role="status">There may be newer activity. Refresh to see it.</div>}
        {/* Nine ledger types and a date/ID filter form over an account with
            no activity at all is noise: the filters appear once there is a
            ledger to narrow. */}
        {!ledgerNeverUsed && <>
        <div className="credits-filter-bar">
        <SelectMenu label="Ledger type" prefix="Type:" value={draft.kind} disabled={state === 'loading'}
          options={KINDS.map(kind => ({ value: kind, label: kind === 'all' ? 'All' : kindLabel(kind) }))}
          onChange={kind => updateFilter({ kind })} testId="credits-type-filter" />
        {/* Date range and IDs are free-form inputs, not choices: they stay in
            the disclosure that closes the filter bar. */}
        <details className="credits-more-filters" open={moreOpen} onToggle={event => setMoreOpen(event.currentTarget.open)}>
          <summary className="filter-btn" aria-expanded={moreOpen}>
            More filters
            {advancedCount > 0 && <span className="credits-filter-count">{advancedCount}</span>}
          </summary>
          <form className="credits-filter-fields panel panel-pad" aria-label="Ledger filters" onSubmit={event => { event.preventDefault(); updateFilter({}) }}>
            <div className="field"><label htmlFor="credits-filter-from">From</label><input id="credits-filter-from" type="datetime-local" value={draft.from} disabled={state === 'loading'} onChange={event => setDraft(previous => ({ ...previous, from: event.target.value }))} /></div>
            <div className="field"><label htmlFor="credits-filter-to">To</label><input id="credits-filter-to" type="datetime-local" value={draft.to} disabled={state === 'loading'} onChange={event => setDraft(previous => ({ ...previous, to: event.target.value }))} /></div>
            <div className="field"><label htmlFor="credits-filter-charge">Charge ID</label><input id="credits-filter-charge" value={draft.chargeId} disabled={state === 'loading'} onChange={event => setDraft(previous => ({ ...previous, chargeId: event.target.value }))} /></div>
            <div className="field"><label htmlFor="credits-filter-run">Run ID</label><input id="credits-filter-run" value={draft.runId} disabled={state === 'loading'} onChange={event => setDraft(previous => ({ ...previous, runId: event.target.value }))} /></div>
            <div className="credits-filter-actions">
              <button type="submit" className="btn btn-secondary btn-sm" disabled={state === 'loading'}>Apply filters</button>
              <button type="button" className="btn btn-ghost btn-sm" disabled={state === 'loading'} onClick={() => updateFilter({ kind: 'all', from: '', to: '', chargeId: '', runId: '' })}>Clear filters</button>
            </div>
          </form>
        </details>
        </div>
        </>}
        {state === 'loading' && !page && <LoadingState label="Loading credit ledger…" />}
        {state === 'offline' && <EmptyState role="alert" icon="alert" title="You’re offline" description="Reconnect to load your private ledger." action={<button type="button" className="btn btn-secondary btn-sm" onClick={() => void loadFirst()}>Try again</button>} />}
        {state === 'error' && <EmptyState role="alert" icon="alert" title="Couldn't load your credits" description={error ?? "Couldn't load your credit history."} action={<button type="button" className="btn btn-secondary btn-sm" onClick={() => void loadFirst()}>Try again</button>} />}
        {state === 'cursor-expired' && <EmptyState role="alert" icon="alert" title="This list is out of date" description="Start again from your newest activity." action={<button type="button" className="btn btn-secondary btn-sm" onClick={() => void loadFirst()}>Start again</button>} />}
        {currentPage && state !== 'cursor-expired' && (
          <>
            {error && <p className="credits-inline-error" role="alert">{error}</p>}
            {currentSelected && <CreditEntryDetail entry={currentSelected} onClose={() => { setSelected(null); setSelectedAuthorityKey(null); setParams((current) => { const next = new URLSearchParams(current); next.delete('entryId'); return next }, { replace: true }) }} />}
            {currentPage.items.length === 0 ? (
              <EmptyState icon="book" title={unfiltered ? 'No credit activity yet' : 'No matching ledger entries'} description="Activity appears here after your first credit is granted or spent." />
            ) : (
              <DataTable label="Credit ledger entries" className="credits-table" columns={columns}>
                {currentPage.items.map((entry) => {
                  const delta = deltaBreakdown(entry)
                  return <DataTableRow key={entry.entryId} className={entry.entryId === selectedId ? 'is-selected' : ''}>
                    <DataTableCell><button type="button" className="credits-entry-button" onClick={() => selectEntry(entry)}><time dateTime={entry.postedAt}>{formatInstant(entry.postedAt)}</time></button></DataTableCell>
                    <DataTableCell><StatusBadge tone={KIND_TONE[entry.kind] ?? 'neutral'}>{kindLabel(entry.kind)}</StatusBadge></DataTableCell>
                    <DataTableCell><span>{sourceLabel(entry.source)}</span><small>{isLegacyClassificationEntry(entry) ? 'Historical classification' : reasonLabel(entry.reasonCode)}</small>{entry.kind === 'release' && entry.expiredPoints > 0 && <small>Reservation cleared; {entry.expiredPoints} credits had expired.</small>}</DataTableCell>
                    <DataTableCell className="credits-table-num"><strong className={entry.pointsDelta < 0 ? 'is-negative' : entry.pointsDelta > 0 ? 'is-positive' : undefined}>{signedPoints(entry.pointsDelta)}</strong>{delta && <small className="credits-delta">{delta}</small>}</DataTableCell>
                    <DataTableCell className="credits-table-num"><span>{formatPoints(entry.balanceAfter.available)}</span>{entry.balanceAfter.reserved > 0 && <small className="credits-held">{formatPoints(entry.balanceAfter.reserved)} held</small>}</DataTableCell>
                  </DataTableRow>
                })}
              </DataTable>
            )}
            {currentPage.nextCursor && <div className="credits-load-more"><LoadMoreButton loading={cursorLoading} onClick={() => void loadMore()} status="Loading older ledger entries" /></div>}
            {!ledgerNeverUsed && <p className="credits-timezone meta">Times are in your time zone ({formatTimeZoneName(new Date())}).</p>}
          </>
        )}
      </PageSection>
    </PageShell>
  )
}

function CreditEntryDetail({ entry, onClose }: { entry: CreditLedgerEntry; onClose: () => void }) {
  const [params] = useSearchParams()
  const relatedParams = new URLSearchParams(params)
  if (entry.relatedEntryId) relatedParams.set('entryId', entry.relatedEntryId)
  return (
    <aside className="credits-detail panel panel-pad" aria-label="Ledger entry details">
      <div className="credits-detail-head">
        <h2>Ledger entry</h2>
        <StatusBadge tone={KIND_TONE[entry.kind] ?? 'neutral'}>{kindLabel(entry.kind)}</StatusBadge>
        <strong className={`credits-detail-points${entry.pointsDelta < 0 ? ' is-negative' : entry.pointsDelta > 0 ? ' is-positive' : ''}`}>{signedPoints(entry.pointsDelta)}</strong>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>Close</button>
      </div>
      <dl>
        <div><dt>Reference</dt><dd>{entry.entryId}</dd></div>
        <div><dt>Available change</dt><dd>{signedPoints(entry.availableDelta)}</dd></div>
        <div><dt>Reserved change</dt><dd>{signedPoints(entry.reservedDelta)}</dd></div>
        {entry.expiredPoints > 0 && <div><dt>Expired credits</dt><dd>{entry.expiredPoints}</dd></div>}
        <div><dt>Type</dt><dd>{kindLabel(entry.kind)}</dd></div>
        <div><dt>Reason</dt><dd>{reasonLabel(entry.reasonCode)}</dd></div>
        <div><dt>Posted</dt><dd>{formatInstant(entry.postedAt)}</dd></div>
        <div><dt>Effective</dt><dd>{formatInstant(entry.effectiveAt)}</dd></div>
        <div><dt>Time zone</dt><dd>{formatTimeZoneName(new Date(entry.postedAt))}</dd></div>
        <div><dt>Balance after</dt><dd>{formatPoints(entry.balanceAfter.available)} available / {formatPoints(entry.balanceAfter.reserved)} reserved</dd></div>
        {entry.expiresAt && <div><dt>Expires</dt><dd>{formatInstant(entry.expiresAt)}</dd></div>}
        {entry.task && <div><dt>Task</dt><dd><Link to={entry.task.runId ? `/classify/batch?collectionId=${encodeURIComponent(entry.task.collectionId)}&runId=${encodeURIComponent(entry.task.runId)}` : `/library/${encodeURIComponent(entry.task.collectionId)}`}>{entry.task.runId ? 'Open classification run' : 'Open collection'}</Link></dd></div>}
        {isLegacyClassificationEntry(entry) && <div><dt>History</dt><dd>This historical classification has no platform credit charge or task link.</dd></div>}
        {entry.chargeId && <div><dt>Charge</dt><dd><Link to={`/credits?chargeId=${encodeURIComponent(entry.chargeId)}`}>{entry.chargeId}</Link></dd></div>}
        {entry.relatedEntryId && <div><dt>Related entry</dt><dd><Link to={`/credits?${relatedParams.toString()}`}>{entry.relatedEntryId}</Link></dd></div>}
      </dl>
    </aside>
  )
}
