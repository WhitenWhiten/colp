import { classificationFolderLabel } from './classification-folder-label'
import { useEffect, useRef, useState } from 'react'
import { productClient, ProductApiError, type ClassifyInboxItem, type ClassificationPreviewRequest, type ClassificationPreviewResponse, type CreditBillingConsent } from '../../api'
import { useAuth } from '../../auth/AuthContext'
import { plural } from '../../lib/plural'
import { isAbort } from '../../lib/libraryTree'
import { isCreditPriceChanged, useClassificationCreditConsent } from './useClassificationCreditConsent'
import { getApiBaseUrl } from '../../api/config'

export interface ClassificationFolderChoice { folderId: string; folderTitle: string; suggestionId: string }
interface Props {
  item: ClassifyInboxItem
  disabled: boolean
  selectedFolderId?: string
  selectedTags?: readonly string[]
  onTagsChange?: (tags: string[]) => void
  onConfirmTags?: () => void
  onChooseFolder: (folder: ClassificationFolderChoice | null) => void
}

function previewErrorMessage(cause: ProductApiError, sameIntent: boolean, unknownOutcome: boolean): string {
  if (cause.status === 404) return 'Classification is not available for this collection.'
  if (cause.code === 'billing_consent_required') return 'Confirm the displayed credit cost before starting this hosted classification.'
  if (cause.code === 'credit_limit_exceeded') return 'This classification exceeds the confirmed credit limit. Refresh the price and confirm again.'
  if (cause.code === 'insufficient_credits') return 'There are not enough available credits for this classification. Try again after a grant.'
  if (cause.code === 'credits_busy' || cause.code === 'credits_reconciling' || cause.code === 'credits_unavailable') return 'Credits are temporarily unavailable. Check the result again shortly.'
  if (unknownOutcome) return 'The request may not have completed. Check the result before starting another classification.'
  if (sameIntent) return 'No final result yet. Check the result before starting another classification.'
  return 'Classification could not be completed. You can explicitly start a new request.'
}

export function ClassificationPreview({ item, disabled, selectedFolderId = '', selectedTags = [], onTagsChange, onConfirmTags, onChooseFolder }: Props) {
  const { user } = useAuth()
  const [folders, setFolders] = useState<ClassificationFolderChoice[]>([])
  const [folderError, setFolderError] = useState(false)
  const folderId = selectedFolderId
  const [preview, setPreview] = useState<ClassificationPreviewResponse | null>(null)
  const [error, setError] = useState<{ message: string; sameIntent: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [acceptedKey, setAcceptedKey] = useState<string | null>(null)
  const controller = useRef<AbortController | null>(null)
  const intent = useRef<string | null>(null)
  const intentRequest = useRef<ClassificationPreviewRequest | null>(null)
  const credit = useClassificationCreditConsent(item.collectionId, 1, user?.accountId)
  const billingAccepted = acceptedKey === credit.consentKey
  const previousConsentKey = useRef(credit.consentKey)
  const requestScope = `${getApiBaseUrl()}|${user?.accountId ?? ''}|${item.collectionId}|${item.nodeId}`
  const previousRequestScope = useRef(requestScope)
  useEffect(() => {
    if (previousConsentKey.current === credit.consentKey && previousRequestScope.current === requestScope) return
    const retainUnknownIntent = previousRequestScope.current === requestScope
      && intent.current !== null && intentRequest.current !== null && (busy || error?.sameIntent === true)
    previousConsentKey.current = credit.consentKey
    previousRequestScope.current = requestScope
    controller.current?.abort()
    controller.current = null
    setBusy(false)
    if (!retainUnknownIntent) { intent.current = null; intentRequest.current = null }
    setAcceptedKey(null)
    setPreview(null)
    setError(retainUnknownIntent ? {
      sameIntent: true, message: 'The session changed before the result arrived. Check the result before starting another classification.',
    } : null)
    onTagsChange?.([])
  }, [credit.consentKey, requestScope, busy, error?.sameIntent, onTagsChange])
  useEffect(() => {
    const abort = new AbortController()
    void productClient.loadEditorSnapshot(item.collectionId, { signal: abort.signal, maxRetries: 0 }).then(snapshot => {
      if (abort.signal.aborted) return
      const nodes = new Map(snapshot.nodes.map(node => [node.id, node]))
      setFolders(snapshot.nodes.filter(node => node.kind === 'folder').map(node => {
        return { folderId: node.id, suggestionId: node.id, folderTitle: classificationFolderLabel(nodes, node.id) }
      }))
    }).catch(cause => { if (!isAbort(cause) && !abort.signal.aborted) setFolderError(true) })
    return () => { abort.abort(); controller.current?.abort() }
  }, [item.collectionId])

  async function classify(reuse: boolean) {
    if (busy || disabled) return
    if (!reuse || !intent.current || !intentRequest.current) {
      intent.current = productClient.mutationIntentKey('classification-preview', `${item.nodeId}:${crypto.randomUUID()}`)
      const billing: CreditBillingConsent | undefined = credit.mode === 'managed' && credit.priceVersion && credit.maxPoints !== null
        ? { priceVersion: credit.priceVersion, maxPoints: credit.maxPoints }
        : undefined
      intentRequest.current = {
        source: 'web', nodeId: item.nodeId, requested: { folder: true, tags: true },
        ...(billing ? { billing } : {}),
      }
      reuse = false
    }
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort
    setBusy(true); setError(null); if (!reuse) { setPreview(null); onTagsChange?.([]) }
    try {
      const result = await productClient.previewBookmarkClassification(item.collectionId,
        intentRequest.current,
        { intentId: intent.current, maxRetries: 0, signal: abort.signal })
      if (!abort.signal.aborted) { setPreview(result); onTagsChange?.(result.tags.candidates.filter(candidate => candidate.selected).map(candidate => candidate.tag)) }
    } catch (cause) {
      if (isAbort(cause) || abort.signal.aborted) return
      if (isCreditPriceChanged(cause)) {
        setAcceptedKey(null)
        intent.current = null
        intentRequest.current = null
        setPreview(null)
        credit.refresh()
      }
      const unknownOutcome = cause instanceof ProductApiError
        && (cause.code === 'outcome_unknown' || cause.code === 'unknown_result'
          || (cause.status === 503 && !cause.sameRequestRetrySafe))
      const sameIntent = unknownOutcome || !(cause instanceof ProductApiError) || cause.sameRequestRetrySafe
      const message = cause instanceof ProductApiError
        ? isCreditPriceChanged(cause) ? 'The credit price changed. Refresh the current price and explicitly start a new request.'
          : previewErrorMessage(cause, sameIntent, unknownOutcome)
        : sameIntent ? 'No final result yet. Check the result before starting another classification.'
          : 'Classification could not be completed. You can explicitly start a new request.'
      setError({ sameIntent, message })
    } finally {
      if (!abort.signal.aborted && controller.current === abort) { controller.current = null; setBusy(false) }
    }
  }
  const chosen = folders.find(folder => folder.folderId === folderId)
  const suggested = folders.find(folder => folder.folderId === preview?.folder?.folderId)
  const evaluated = (preview?.folder?.probabilities ?? []).flatMap(item => {const folder=folders.find(folder=>folder.folderId===item.folderId);return folder?[folder]:[]})
  const otherFolders=folders.filter(folder=>!evaluated.some(candidate=>candidate.folderId===folder.folderId))
  const coverage = preview?.candidateCoverage
  const modeUnavailable = !credit.loading && !credit.error && credit.mode === null
  const managedBlocked = credit.loading || Boolean(credit.error) || modeUnavailable
    || (credit.mode === 'managed' && (credit.maxPoints === null
      || (credit.available !== null && credit.maxPoints > credit.available)))
  const showPreview = !credit.loading && !credit.error && !modeUnavailable
  // Replaying an already-consented command must retain its original body, even
  // if its completed charge has since consumed the available balance.
  const checkingExisting = error?.sameIntent === true && intent.current !== null && intentRequest.current !== null
  const cannotStart = checkingExisting ? credit.loading || Boolean(credit.error)
    : managedBlocked || (credit.mode === 'managed' && !billingAccepted)
  return (
    <section className="classification-preview" aria-label="Bookmark classification">
      <h3>Bookmark classification</h3>
      <p className="meta">Request a folder suggestion, then choose where to file this bookmark.</p>
      {credit.loading && <p className="meta" role="status">Checking the current credit price…</p>}
      {credit.error && <p className="field-error" role="alert">{credit.error} <button type="button" className="btn btn-ghost btn-sm" onClick={credit.refresh}>Refresh price</button></p>}
      {credit.mode === 'legacy_free' ? <p className="meta">Platform credits are not charged for this classification.</p> : !credit.loading && !credit.error && <>
        <p className="meta">Up to {credit.maxPoints} credit{credit.maxPoints === 1 ? '' : 's'} for this hosted classification. Available: {credit.available}.</p>
        <label className="classification-credit-consent">
          <input type="checkbox" checked={billingAccepted} disabled={busy || disabled || managedBlocked} onChange={event => setAcceptedKey(event.target.checked ? credit.consentKey : null)} />
          I agree to spend up to {credit.maxPoints} credits for this hosted classification.
        </label>
      </>}
      <button type="button" className="btn btn-secondary btn-sm" disabled={busy || disabled || cannotStart}
        onClick={() => void classify(error?.sameIntent ?? false)}>
        {busy ? 'Classifying…' : error?.sameIntent ? 'Check existing request' : preview || error ? 'Start new classification' : 'Suggest a folder'}
      </button>
      {error && <p className="field-error" role="alert">{error.message}</p>}
      {preview && showPreview && <div role="status">
        <p>{preview.folder?.decision === 'later' ? 'Suggestion: keep this bookmark in the collection root.'
          : suggested ? `Suggested folder: ${suggested.folderTitle}` : 'The suggested folder is no longer in this folder list. Refresh before choosing.'}</p>
        {preview.folder && <p className="meta">Model score: {Math.round(preview.folder.confidence * 100)}%</p>}
        {coverage && <p className="meta">Candidates considered: {coverage.l1Included}/{coverage.l1Total} top-level folders, {coverage.descendantIncluded}/{coverage.descendantTotal} descendants.
          {(coverage.l1Included < coverage.l1Total || coverage.descendantIncluded < coverage.descendantTotal) && ' Some folders were outside the candidate budget.'}</p>}
        {'creditUsage' in preview && preview.creditUsage.mode === 'managed' && <p className="meta">Credits: {preview.creditUsage.chargedPoints} charged, {preview.creditUsage.releasedPoints} released.</p>}
        {'creditUsage' in preview && preview.creditUsage.mode === 'legacy_free' && <p className="meta">Historical classification: no platform credits were charged.</p>}
        {!('creditUsage' in preview) && <p className="meta">Historical classification: no platform credits were charged.</p>}
        {suggested && <button type="button" className="btn btn-secondary btn-sm" disabled={disabled || busy}
          onClick={() => onChooseFolder(suggested)}>Choose suggested folder</button>}
      </div>}
      {preview?.tags.mode === 'suggest' && <fieldset disabled={disabled || busy}>
        <legend>Review suggested tags</legend>
        <p className="meta">Select up to 3 existing tags. These are added only when you confirm. Short codes such as t1 or x-17 have unclear meaning; review them carefully.</p>
        {preview.tags.candidates.length === 0 && <p className="meta">No additional tags suggested.</p>}
        {preview.tags.candidates.map(candidate => <label key={candidate.tag}>
          <input type="checkbox" checked={selectedTags.includes(candidate.tag)}
            disabled={!selectedTags.includes(candidate.tag) && selectedTags.length >= 3}
            onChange={event => onTagsChange?.(event.target.checked ? [...selectedTags, candidate.tag] : selectedTags.filter(tag => tag !== candidate.tag))} />
          {candidate.tag} <span className="meta">Tag score: {Math.round(candidate.noul * 100)}%</span>
        </label>)}
        {onConfirmTags && <button type="button" className="btn btn-secondary btn-sm" disabled={!selectedTags.length}
          onClick={onConfirmTags}>Add {plural(selectedTags.length, 'selected tag')} only</button>}
      </fieldset>}
      {preview?.tags.mode === 'off' && <p className="meta">Tag suggestions are off or unavailable here. <a href={`/library/${encodeURIComponent(item.collectionId)}?collection=edit`}>Collection settings</a></p>}
      <div className="field">
      <label htmlFor="classification-folder">Choose any existing folder</label>
      <select id="classification-folder" value={folderId} disabled={disabled || busy || !folders.length} onChange={event => {
        onChooseFolder(folders.find(folder => folder.folderId === event.target.value) ?? null)
      }}>
        <option value="">Select a folder</option>
        {evaluated.length > 0 && <optgroup label="Evaluated folders">{evaluated.map(folder => <option key={folder.folderId} value={folder.folderId}>{folder.folderTitle}</option>)}</optgroup>}
        {otherFolders.map(folder => <option key={folder.folderId} value={folder.folderId}>{folder.folderTitle}</option>)}
      </select>
      </div>
      {chosen && <p className="meta">Selected: {chosen.folderTitle}. Use File below to confirm.</p>}
      {folderError && <p className="field-error" role="alert">Couldn't load folders. Refresh the page to try again.</p>}
    </section>
  )
}
