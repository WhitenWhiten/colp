import { classificationFolderLabel } from './classification/classification-folder-label'
import { useEffect, useRef, useState } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { isClassificationBatchExposureEnabled, productClient, type CreditBillingConsent, type EditorSnapshot, type OwnedCollectionListItem } from '../api'
import { useAuth } from '../auth/AuthContext'
import { Breadcrumb } from '../components/Breadcrumb'
import { useConfirm } from '../components/ConfirmModal'
import { PageHead } from '../components/PageHead'
import { PageShell } from '../components/PageShell'
import { RouteState } from '../components/RouteState'
import { LoadMoreButton } from '../components/LoadMoreButton'
import { isAbort } from '../lib/libraryTree'
import { plural } from '../lib/plural'
import { formatMediumInstant } from '../lib/formatDate'
import { ClassificationBatchReview } from './classification/ClassificationBatchReview'
import { batchSessionKey, clearBatchSession } from './classification/batch-session'
import { useClassificationBatch } from './classification/useClassificationBatch'
import { useClassificationCreditConsent } from './classification/useClassificationCreditConsent'
import '../styles/classification-batch.css'

export function ClassificationBatch() {
  const enabled = isClassificationBatchExposureEnabled(), { user } = useAuth()
  const [params, setParams] = useSearchParams()
  const collectionId = params.get('collectionId') ?? '', runId = params.get('runId') || undefined
  const [collections, setCollections] = useState<OwnedCollectionListItem[]>([])
  const [owner, setOwner] = useState<string | null>(null)
  const [cursor, setCursor] = useState<string | undefined>()
  const accountRef = useRef(user?.accountId); accountRef.current = user?.accountId
  const reading = useRef<AbortController | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const abort = new AbortController(); reading.current = abort
    setCollections([]); setOwner(null); setError(null)
    if (!enabled || !user) return () => abort.abort()
    void productClient.getOwnedCollectionsPage({ limit: 50 }, { signal: abort.signal, maxRetries: 0 }).then(page => {
      if (abort.signal.aborted) return
      setCollections(page.items); setCursor(page.page.nextCursor ?? undefined); setOwner(user.accountId)
    }).catch(cause => { if (!isAbort(cause) && !abort.signal.aborted) setError("Couldn't load your collections.") })
    return () => abort.abort()
  }, [enabled, user?.accountId]) // eslint-disable-line react-hooks/exhaustive-deps
  async function more() {
    if (loadingMore || !cursor) return
    const account = accountRef.current, signal = reading.current?.signal
    setLoadingMore(true)
    try {
      const page = await productClient.getOwnedCollectionsPage({ cursor }, { maxRetries: 0, signal })
      if (signal?.aborted || account !== accountRef.current) return
      setCollections(old => [...new Map([...old, ...page.items].map(item => [item.collection.id, item])).values()]); setCursor(page.page.nextCursor ?? undefined)
    } catch (cause) { if (!isAbort(cause) && account === accountRef.current) setError("Couldn't load more collections.") }
    finally { if (account === accountRef.current) setLoadingMore(false) }
  }
  const head = <PageHead title="Batch classification" documentTitle="Batch classification" variant="workbench"
    breadcrumb={<Breadcrumb items={[{ label: 'Library', to: '/library' }, { label: 'Classify', to: '/classify' }, { label: 'Batch' }]} />}
    lede="Request folder and existing-tag suggestions, then review the changes before applying them." />
  if (!enabled) return <PageShell>{head}<RouteState kind="unavailable" icon="folder" title="Batch classification is not available yet" description="Single-bookmark review remains available in Classify." /></PageShell>
  if (!user) return <PageShell>{head}<RouteState kind="auth" title="Sign in to classify your bookmarks" /></PageShell>
  return <PageShell className="classification-batch-page">{head}
    {error && <p className="field-error" role="alert">{error}</p>}
    <div className="field">
      <label htmlFor="batch-collection">Collection</label>
      <select id="batch-collection" value={collectionId} disabled={owner !== user.accountId} onChange={event => setParams({ collectionId: event.target.value })}>
        <option value="">Choose a collection</option>
        {(owner === user.accountId ? collections : []).map(item => <option key={item.collection.id} value={item.collection.id}>{item.collection.title}</option>)}
      </select>
    </div>
    {cursor && <LoadMoreButton loading={loadingMore} onClick={() => void more()} status="Loading more collections">More collections</LoadMoreButton>}
    {collectionId && <BatchScope key={`${user.accountId}:${collectionId}:${runId ?? 'new'}`} accountId={user.accountId} collectionId={collectionId} runId={runId}
      onRun={id => setParams({ collectionId, runId: id })} onNew={() => {
        clearBatchSession(batchSessionKey(user.accountId, collectionId)); setParams({ collectionId })
      }} />}
  </PageShell>
}

function BatchScope({ accountId, collectionId, runId, onRun, onNew }: {
  accountId: string; collectionId: string; runId?: string; onRun: (id: string) => void; onNew: () => void
}) {
  const confirm = useConfirm()
  const [snapshot, setSnapshot] = useState<EditorSnapshot | null>(null)
  const [source, setSource] = useState(''), [maxItems, setMaxItems] = useState(50)
  const [acceptedKey, setAcceptedKey] = useState<string | null>(null)
  const [snapshotError, setSnapshotError] = useState(false)
  const batch = useClassificationBatch(collectionId, batchSessionKey(accountId, collectionId, runId), runId, onRun)
  const quoteUnits = selectedBookmarkCount(snapshot, source, maxItems)
  const credit = useClassificationCreditConsent(collectionId, quoteUnits, accountId)
  const billingAccepted = acceptedKey === credit.consentKey
  const previousConsentKey = useRef(credit.consentKey)
  useEffect(() => {
    if (previousConsentKey.current === credit.consentKey) return
    previousConsentKey.current = credit.consentKey
    setAcceptedKey(null)
  }, [credit.consentKey])
  const refreshCredit = credit.refresh
  useEffect(() => {
    if (batch.error?.startsWith('The credit price changed.') || batch.error?.startsWith('Confirm the displayed credit cost')) {
      setAcceptedKey(null)
      refreshCredit()
    }
  }, [batch.error, refreshCredit])
  useEffect(() => {
    const abort = new AbortController()
    void Promise.all([productClient.loadEditorSnapshot(collectionId, { signal: abort.signal, maxRetries: 0 }),
      productClient.getClassificationSettings(collectionId, { signal: abort.signal, maxRetries: 0 })]).then(([value]) => {
      if (!abort.signal.aborted) { setSnapshot(value); setSource(value.collection.rootNodeId) }
    }).catch(cause => { if (!isAbort(cause) && !abort.signal.aborted) setSnapshotError(true) })
    return () => abort.abort()
  }, [collectionId])
  const folderNodes = new Map(snapshot?.nodes.map(node => [node.id, node]) ?? [])
  const run = batch.run, stale = Boolean(run && snapshot && run.taxonomyRevision !== snapshot.collection.contentRevision)
  const disabled = batch.busy || Boolean(batch.pending) || batch.blocked || stale || !snapshot
  const billing: CreditBillingConsent | undefined = credit.mode !== 'managed' || !credit.priceVersion || credit.maxPoints === null
    ? undefined
    : { priceVersion: credit.priceVersion, maxPoints: credit.maxPoints }
  const creditBlocked = credit.loading || Boolean(credit.error) || credit.mode === null
    || (credit.mode === 'managed' && (credit.maxPoints === null
      || (credit.available !== null && credit.maxPoints > credit.available)))
  const insufficientCredits = credit.mode === 'managed' && credit.available !== null && credit.maxPoints !== null && credit.maxPoints > credit.available
  const runSucceeded = run ? run.actions.filter(action => action.status === 'succeeded').length : 0
  const runFailed = run ? run.actions.filter(action => action.status === 'failed').length : 0
  const runTotal = run ? run.actions.length : 0
  return <section className="classification-batch" aria-label="Classification batch">
    {snapshotError && <p className="field-error" role="alert">Couldn't load this collection. Choose a collection you own, or try again later.</p>}
    {!snapshot && !snapshotError && <p className="meta" role="status">Loading collection…</p>}
    {!run && !batch.runId && <>
      <div className="field">
        <label htmlFor="batch-source">Bookmarks to classify</label>
        <select id="batch-source" value={source} disabled={!snapshot || batch.busy || Boolean(batch.pending)} onChange={event => { setSource(event.target.value); setAcceptedKey(null) }}>
          {snapshot && <option value={snapshot.collection.rootNodeId}>Entire collection</option>}
          {snapshot?.nodes.filter(node => node.kind === 'folder').map(node => <option key={node.id} value={node.id}>{classificationFolderLabel(folderNodes, node.id)}</option>)}
        </select>
      </div>
      {snapshot && quoteUnits === 0 && <p className="meta">No bookmarks match this selection.</p>}
      <div className="field">
        <label htmlFor="batch-max">Maximum bookmarks</label>
        <input id="batch-max" type="number" min={1} max={50} value={maxItems} disabled={batch.busy || Boolean(batch.pending)}
          onChange={event => { setMaxItems(Number(event.target.value)); setAcceptedKey(null) }} />
      </div>
      {credit.loading && <p className="meta" role="status">Checking the current credit price…</p>}
      {credit.error && <p className="field-error" role="alert">{credit.error} <button type="button" className="btn btn-ghost btn-sm" onClick={credit.refresh}>Refresh price</button></p>}
      {credit.mode === 'legacy_free' ? <p className="meta">Platform credits are not charged for this batch.</p> : !credit.loading && !credit.error && credit.mode === 'managed' && <>
        <p className="meta">Up to {credit.maxPoints} credits for this hosted batch. Available: {credit.available}.</p>
        {insufficientCredits && <p className="field-error" role="alert">Not enough credits for this batch. <Link to="/credits" className="btn btn-ghost btn-sm">View credits</Link></p>}
        <label className="classification-credit-consent">
          <input type="checkbox" checked={billingAccepted} disabled={disabled || creditBlocked} onChange={event => setAcceptedKey(event.target.checked ? credit.consentKey : null)} />
          I agree to spend up to {credit.maxPoints} credits for this hosted batch.
        </label>
      </>}
      <button type="button" className="btn btn-primary" disabled={disabled || creditBlocked || (credit.mode === 'managed' && !billingAccepted) || !source || quoteUnits === 0 || !Number.isInteger(maxItems) || maxItems < 1 || maxItems > 50}
        onClick={() => void batch.create({ sourceFolderIds: [source], requested: { folder: true, tags: true }, maxItems, ...(billing ? { billing } : {}) })}>Start batch classification</button>
    </>}
    {batch.error && <p className="field-error" role="alert">{batch.error}</p>}
    {batch.pending && <button type="button" className="btn btn-secondary" disabled={batch.busy} onClick={() => void batch.retry()}>Check result</button>}
    {batch.runId && <button type="button" className="btn btn-ghost btn-sm" disabled={batch.busy} onClick={() => void batch.refresh()}>Refresh progress</button>}
    {run && <>
      <p className="meta" role="status">{run.status === 'applied' ? 'Selected changes applied.' : run.status === 'cancelled' ? 'Batch cancelled.'
        : `${runSucceeded} of ${plural(runTotal, 'suggestion')} ready.${runFailed > 0 ? ` ${runFailed} failed.` : ''}`}</p>
      <BatchCreditSummary run={run} />
      <p className="meta">Suggestions due by {formatMediumInstant(run.deadlineAt)}.</p>
      <p className="meta">Review before {formatMediumInstant(run.expiresAt)}.</p>
      {stale && run.status === 'open' && <p className="field-error" role="alert">The collection changed. Start a new batch to review current suggestions.</p>}
      {run.failureCode && <p className="field-error" role="alert">{run.failureCode === 'all_actions_failed' ? 'No bookmarks could be classified.' : 'The collection or classification settings changed.'}</p>}
      {['queued', 'running', 'open'].includes(run.status) && <button type="button" className="btn btn-danger-ghost btn-sm" disabled={batch.busy || Boolean(batch.pending)}
        onClick={async () => {
          if (await confirm({
            title: 'Cancel this classification batch?',
            body: 'Suggestions that have not been applied will be discarded.',
            confirmLabel: 'Cancel batch',
          })) {
            void batch.cancel()
          }
        }}>Cancel batch</button>}
      <ClassificationBatchReview run={run} snapshot={snapshot} disabled={disabled || run.status !== 'open'} onApply={document => { void batch.apply(document) }} />
    </>}
    {(run || batch.blocked) && <button type="button" className="btn btn-secondary" disabled={batch.busy || Boolean(batch.pending)} onClick={onNew}>Start another batch</button>}
  </section>
}

function BatchCreditSummary({ run }: {
  run: NonNullable<ReturnType<typeof useClassificationBatch>['run']>
}) {
  if (!('creditUsage' in run)) return <p className="meta classification-credit-summary">Historical batch: no platform credits were charged.</p>
  const usage = run.creditUsage
  if (usage.mode === 'legacy_free') return <p className="meta classification-credit-summary">Platform credits: none (charging was disabled).</p>
  if (usage.mode !== 'managed') return <p className="meta classification-credit-summary">Platform credits: none (your configured provider).</p>
  return <p className="meta classification-credit-summary">
    {`Charged ${usage.chargedPoints} of up to ${usage.quotedPoints} credits.${usage.releasedPoints > 0 ? ` ${usage.releasedPoints} returned.` : ''}${usage.reservedPoints > 0 ? ` ${usage.reservedPoints} still on hold.` : ''}`}
  </p>
}

function selectedBookmarkCount(snapshot: EditorSnapshot | null, source: string, maxItems: number): number {
  if (!snapshot || !source || !Number.isInteger(maxItems) || maxItems < 1 || maxItems > 50) return 0
  const nodes = new Map(snapshot.nodes.map(node => [node.id, node]))
  const count = snapshot.nodes.filter(node => {
    if (node.kind !== 'bookmark') return false
    let parentId: string | null = node.parentId
    const seen = new Set<string>()
    while (parentId && !seen.has(parentId)) {
      if (parentId === source) return true
      seen.add(parentId)
      parentId = nodes.get(parentId)?.parentId ?? null
    }
    return false
  }).length
  return Math.min(maxItems, count)
}
