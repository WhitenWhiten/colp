import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Link, useParams } from 'react-router-dom'
import { isLive, isProductApiError, productClient } from '../../api'
import { useAuth } from '../../auth/AuthContext'
import { useToast } from '../../components/AppToast'
import { useConfirm } from '../../components/ConfirmModal'
import { PageHead } from '../../components/PageHead'
import { PageSection, PageShell } from '../../components/PageShell'
import { RouteState } from '../../components/RouteState'
import type { GovernanceAction, GovernanceEvidence, GovernanceOfficialCase } from '@known/product-v1-client'
import { formatGovernanceTarget } from '../../lib/governanceTarget'
import { humanLabel, MODERATION_ACTION_LABEL, MODERATION_ACTION_STATE_LABEL, MODERATION_CATEGORY_LABEL, MODERATION_STATUS_LABEL } from '../../lib/moderationLabels'
import { privateSessionIdentity, subscribeSession } from '../../api/sessionStore'

export function ModerationCaseDetail() {
  const { caseId = '' } = useParams()
  const { isLoggedIn } = useAuth()
  const sessionIdentity = useSyncExternalStore(subscribeSession, privateSessionIdentity, privateSessionIdentity)
  const confirm = useConfirm()
  const { success } = useToast()
  const enabled = isLive('contentGovernance')
  const [view, setView] = useState<GovernanceOfficialCase | null>(null)
  const [etag, setEtag] = useState<string | null>(null)
  const [evidence, setEvidence] = useState<GovernanceEvidence[]>([])
  const [actions, setActions] = useState<GovernanceAction[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [forbidden, setForbidden] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const renderedIdentityRef = useRef(sessionIdentity)

  useEffect(() => {
    renderedIdentityRef.current = sessionIdentity
    if (!enabled || !isLoggedIn || !caseId) return
    const controller = new AbortController()
    const requestIdentity = sessionIdentity
    const options = { signal: controller.signal, maxRetries: 0 }
    setLoadError(null)
    setForbidden(false)
    /* A different case id (or a retry) must not paint the previous case's
       projection: a stale view would also suppress the error branch below,
       swallowing a failed load. Reset the projection with the fetch. */
    setView(null)
    setEvidence([])
    setActions([])
    setEtag(null)
    productClient.getModerationCase(caseId, options)
      .then(async (result) => {
        const [loadedEvidence, loadedActions] = await Promise.all([
          Promise.all(result.evidenceIds.map((id) =>
            productClient.getModerationEvidence(caseId, id, options),
          )),
          Promise.all(result.actionIds.map((id) =>
            productClient.getModerationAction(id, options),
          )),
        ])
        if (controller.signal.aborted || privateSessionIdentity() !== requestIdentity) return
        setView(result)
        setEvidence(loadedEvidence)
        setActions(loadedActions)
      })
      .catch((err) => {
        if (controller.signal.aborted || privateSessionIdentity() !== requestIdentity) return
        if (isProductApiError(err) && (err.status === 403 || err.code === 'insufficient_permission')) {
          setForbidden(true)
          return
        }
        setLoadError(isProductApiError(err) ? err.recoveryHint : "Couldn't load this case")
      })
    return () => controller.abort()
  }, [enabled, isLoggedIn, caseId, attempt, sessionIdentity])

  async function patchCase(status: 'in_review' | 'resolved' | 'dismissed') {
    if (!view) return
    const requestIdentity = sessionIdentity
    setBusy(true)
    setActionError(null)
    try {
      const current = etag ?? `"${view.case.revision}"`
      const updated = await productClient.updateModerationCase(
        view.case.id,
        status === 'in_review'
          ? { status }
          : { status, publicResolution: 'Official collection control applied.' },
        current,
        { intentId: productClient.mutationIntentKey('moderation-case', productClient.newCommandId()), maxRetries: 0 },
      )
      if (privateSessionIdentity() !== requestIdentity) return
      setView(updated)
      setEtag(`"${updated.case.revision}"`)
      success(status === 'in_review' ? 'Review started.' : 'Case updated.')
    } catch (err) {
      if (privateSessionIdentity() === requestIdentity) {
        setActionError(isProductApiError(err) ? err.recoveryHint : 'Case could not be updated')
      }
    } finally {
      if (privateSessionIdentity() === requestIdentity) setBusy(false)
    }
  }

  async function restrict(kind: 'restrict_interaction' | 'restrict_publication') {
    if (!view) return
    const requestIdentity = sessionIdentity
    const target = view.case.target
    if (target.kind !== 'account') return
    const title = kind === 'restrict_interaction' ? 'Restrict interaction?' : 'Restrict publication?'
    const body = kind === 'restrict_interaction'
      ? "The account can't comment, vote or follow until this is revoked."
      : "The account's profile and public content stop appearing in Explore, search and feeds until this is revoked."
    if (!(await confirm({ title, body, confirmLabel: 'Restrict' }))) return
    if (privateSessionIdentity() !== requestIdentity) return
    setBusy(true)
    setActionError(null)
    try {
      const created = await productClient.createModerationAction(
        {
          caseId: view.case.id,
          target,
          action: kind,
          reason: kind === 'restrict_interaction' ? 'Restrict account interaction' : 'Restrict account publication',
        },
        { intentId: productClient.mutationIntentKey('moderation-action', productClient.newCommandId()), maxRetries: 0 },
      )
      if (privateSessionIdentity() !== requestIdentity) return
      setActions((current) => [...current, created])
      success(kind === 'restrict_interaction' ? 'Interaction restricted.' : 'Publication restricted.')
    } catch (err) {
      if (privateSessionIdentity() === requestIdentity) {
        setActionError(isProductApiError(err) ? err.recoveryHint : 'Action could not be created')
      }
    } finally {
      if (privateSessionIdentity() === requestIdentity) setBusy(false)
    }
  }

  async function act(kind: 'delist' | 'hide_public') {
    if (!view) return
    const requestIdentity = sessionIdentity
    const target = view.case.target
    if (!canHideDelist(target.kind)) return
    const targetTitle = evidence[0]?.title
    const title = kind === 'hide_public'
      ? (targetTitle ? `Hide “${targetTitle}”?` : 'Hide this content?')
      : (targetTitle ? `Delist “${targetTitle}”?` : 'Delist this content?')
    const confirmLabel = kind === 'hide_public' ? 'Hide' : 'Delist'
    const body = kind === 'hide_public'
      ? 'The content stays in place for its owner but is replaced by a notice for everyone else. You can revoke this later.'
      : 'The content stays visible at its address but is removed from Explore, search and the directory. You can revoke this later.'
    if (!(await confirm({ title, body, confirmLabel }))) return
    if (privateSessionIdentity() !== requestIdentity) return
    setBusy(true)
    setActionError(null)
    try {
      const reason = hideDelistReason(target.kind, kind)
      const body = target.kind === 'collection'
        ? { caseId: view.case.id, target, action: kind, reason }
        : target.kind === 'bookmark'
          ? { caseId: view.case.id, target, action: kind, reason }
          : target.kind === 'digest_series'
            ? { caseId: view.case.id, target, action: kind, reason }
            : target.kind === 'digest_edition'
              ? { caseId: view.case.id, target, action: kind, reason }
              : null
      if (body === null) return
      const created = await productClient.createModerationAction(
        body,
        { intentId: productClient.mutationIntentKey('moderation-action', productClient.newCommandId()), maxRetries: 0 },
      )
      if (privateSessionIdentity() !== requestIdentity) return
      setActions((current) => [...current, created])
      success(kind === 'hide_public' ? 'Content hidden.' : 'Content delisted.')
    } catch (err) {
      if (privateSessionIdentity() === requestIdentity) {
        setActionError(isProductApiError(err) ? err.recoveryHint : 'Action could not be created')
      }
    } finally {
      if (privateSessionIdentity() === requestIdentity) setBusy(false)
    }
  }

  async function revoke(action: GovernanceAction) {
    const requestIdentity = sessionIdentity
    if (!(await confirm({
      title: 'Revoke this action?',
      body: 'The original action is undone and the content returns to its previous state.',
      confirmLabel: 'Revoke',
    }))) return
    if (privateSessionIdentity() !== requestIdentity) return
    setBusy(true)
    setActionError(null)
    try {
      const revoked = await productClient.revokeModerationAction(
        action.id,
        { reason: `Revoked by a reviewer (${action.action})` },
        `"${action.revision}"`,
        { intentId: productClient.mutationIntentKey('moderation-revoke', productClient.newCommandId()), maxRetries: 0 },
      )
      if (privateSessionIdentity() !== requestIdentity) return
      setActions((current) => current.map((item) => item.id === revoked.id ? revoked : item))
      success('Action revoked.')
    } catch (err) {
      if (privateSessionIdentity() === requestIdentity) {
        setActionError(isProductApiError(err) ? err.recoveryHint : 'Action could not be revoked')
      }
    } finally {
      if (privateSessionIdentity() === requestIdentity) setBusy(false)
    }
  }

  const identityReady = renderedIdentityRef.current === sessionIdentity
  const visibleView = identityReady ? view : null
  const visibleEvidence = identityReady ? evidence : []
  const visibleActions = identityReady ? actions : []
  const visibleLoadError = identityReady ? loadError : null
  const visibleForbidden = identityReady ? forbidden : false
  const visibleActionError = identityReady ? actionError : null
  const visibleBusy = identityReady ? busy : false

  return (
    <PageShell>
      <PageHead
        documentTitle="Moderation case"
        eyebrow="Admin"
        title="Moderation case"
        lede="Official case, evidence, collection/bookmark/digest hide/delist, and account restrict."
      />
      <PageSection>
        <p><Link to="/admin/moderation/cases">All cases</Link></p>
        {!enabled ? (
          <RouteState
            kind="unavailable"
            icon="bell"
            title="Moderation cases are not available yet"
            feature="Moderation cases"
          />
        ) : !isLoggedIn ? (
          <RouteState kind="auth" returnTo={`/admin/moderation/cases/${caseId}`} />
        ) : visibleForbidden ? (
          <RouteState
            kind="forbidden"
            title="Official reviewer access is required."
            description="This console is limited to official reviewers."
          />
        ) : visibleLoadError && visibleView === null ? (
          <RouteState
            kind="error"
            title="Couldn't load this case"
            description={visibleLoadError}
            onRetry={() => setAttempt((current) => current + 1)}
          />
        ) : visibleView === null ? (
          <RouteState kind="loading" loadingLabel="Loading case" />
        ) : (
          <div className="stack" data-testid="admin-moderation-case">
            {visibleActionError ? <p className="field-error" role="alert">{visibleActionError}</p> : null}
            <p>
              {visibleEvidence[0]?.title ? <strong>{visibleEvidence[0].title} · </strong> : null}
              {formatGovernanceTarget(visibleView.case.target)}
              {visibleView.case.target.kind === 'bookmark' ? ` · in collection ${visibleView.case.target.collectionId}` : ''}
              {visibleView.case.target.kind === 'digest_edition' ? ` · in digest ${visibleView.case.target.seriesId}` : ''}
              {' · '}{humanLabel(MODERATION_CATEGORY_LABEL, visibleView.case.category)} · {humanLabel(MODERATION_STATUS_LABEL, visibleView.case.status)}
            </p>
            {visibleView.case.target.kind === 'account' ? (
              <p data-testid="admin-moderation-account-locator">{formatGovernanceTarget(visibleView.case.target)}</p>
            ) : null}
            <p className="meta">{visibleView.description}</p>
            <ul data-testid="admin-moderation-evidence">
              {visibleEvidence.map((item) => (
                <li key={item.id}>
                  <p><strong>{item.title}</strong></p>
                  <p>{item.text}{item.truncated ? ' truncated' : ''}</p>
                </li>
              ))}
            </ul>
            {canHideDelist(visibleView.case.target.kind) ? (
              <div className="row row-wrap">
                <button type="button" className="btn btn-secondary btn-sm" disabled={visibleBusy || visibleView.case.status === 'in_review'} onClick={() => void patchCase('in_review')}>Start review</button>
                <button type="button" className="btn btn-danger btn-sm" disabled={visibleBusy} onClick={() => void act('hide_public')}>Hide public</button>
                <button type="button" className="btn btn-danger btn-sm" disabled={visibleBusy} onClick={() => void act('delist')}>Delist</button>
              </div>
            ) : null}
            {visibleView.case.target.kind === 'account' ? (
              <div className="row row-wrap">
                <button type="button" className="btn btn-secondary btn-sm" disabled={visibleBusy || visibleView.case.status === 'in_review'} onClick={() => void patchCase('in_review')}>Start review</button>
                <button type="button" className="btn btn-danger btn-sm" disabled={visibleBusy} onClick={() => void restrict('restrict_interaction')}>Restrict interaction</button>
                <button type="button" className="btn btn-danger btn-sm" disabled={visibleBusy} onClick={() => void restrict('restrict_publication')}>Restrict publication</button>
              </div>
            ) : null}
            <ul data-testid="admin-moderation-actions">
              {visibleActions.map((action) => (
                <li key={action.id}>
                  {humanLabel(MODERATION_ACTION_LABEL, action.action)} · {humanLabel(MODERATION_ACTION_STATE_LABEL, action.state)}
                  {action.state === 'active' ? (
                    <button type="button" className="btn btn-danger-ghost btn-sm" disabled={visibleBusy} onClick={() => void revoke(action)}>Revoke</button>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        )}
      </PageSection>
    </PageShell>
  )
}

function canHideDelist(kind: string): boolean {
  return kind === 'collection' || kind === 'bookmark' || kind === 'digest_series' || kind === 'digest_edition'
}

function hideDelistReason(kind: string, action: 'delist' | 'hide_public'): string {
  if (kind === 'bookmark') return action === 'hide_public' ? 'Hide public bookmark' : 'Delist bookmark'
  if (kind === 'digest_series') return action === 'hide_public' ? 'Hide public digest' : 'Delist digest'
  if (kind === 'digest_edition') return action === 'hide_public' ? 'Hide public edition' : 'Delist edition'
  return action === 'hide_public' ? 'Hide public collection' : 'Delist collection'
}
