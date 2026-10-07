/* CS-03 deep link: /community/comments/:commentId resolves the comment
   through the same CS-01 target authority, then redirects to the canonical
   target page thread anchor. A reply anchors on its thread root; a concealed
   target or superseded generation lands on the generic unavailable note
   exactly like an unknown comment id — no existence leak. Transient failures
   (5xx, network, rate-limit) are NOT concealed: they land on a distinct
   failure state with a retry, never on the not-available note. */
import { useEffect, useState } from 'react'
import { Navigate, useParams } from 'react-router-dom'
import { isProductApiError, productClient } from '../api'
import { ABSENCE_CORNERS, AbsenceStage } from '../components/AbsenceStage'
import { PageShell } from '../components/PageShell'
import { RouteState } from '../components/RouteState'
import { useDocumentTitle } from '../lib/useDocumentTitle'
import '../styles/not-found.css'

type RedirectState =
  | { kind: 'loading' }
  | { kind: 'redirect'; to: string }
  | { kind: 'unavailable' }
  | { kind: 'failed' }

export function CommunityCommentRedirect() {
  useDocumentTitle('Comment')
  const { commentId } = useParams<{ commentId: string }>()
  const [state, setState] = useState<RedirectState>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!commentId) {
      setState({ kind: 'unavailable' })
      return
    }
    const controller = new AbortController()
    setState({ kind: 'loading' })
    void (async () => {
      try {
        const comment = await productClient.getCommunityComment(commentId, { signal: controller.signal })
        const target = comment.target
        const view = await productClient.resolveCommunityTarget({
          kind: target.kind,
          id: target.id,
          ...(target.collectionId !== null ? { collectionId: target.collectionId } : {}),
          ...(target.seriesId !== null ? { seriesId: target.seriesId } : {}),
        }, { signal: controller.signal })
        const anchor = comment.depth === 0 ? comment.id : comment.rootId
        setState({ kind: 'redirect', to: `${view.href}#comment-${anchor}` })
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return
        if (isProductApiError(error)
            && (error.status === 404 || error.code === 'resource_not_found')) {
          setState({ kind: 'unavailable' })
          return
        }
        setState({ kind: 'failed' })
      }
    })()
    return () => controller.abort()
  }, [commentId, attempt])

  if (state.kind === 'redirect') {
    return <Navigate to={state.to} replace />
  }

  if (state.kind === 'unavailable') {
    return (
      <AbsenceStage
        title="Comment unavailable"
        corners={ABSENCE_CORNERS.comment}
        exits={[{ to: '/explore', label: 'Back to Explore' }]}
        testId="community-comment-redirect"
      />
    )
  }

  return (
    <PageShell data-testid="community-comment-redirect">
      {state.kind === 'failed' ? (
        <RouteState
          kind="error"
          title="Couldn't load this comment"
          onRetry={() => setAttempt((current) => current + 1)}
        />
      ) : (
        <RouteState kind="loading" loadingLabel="Opening comment…" />
      )}
    </PageShell>
  )
}
