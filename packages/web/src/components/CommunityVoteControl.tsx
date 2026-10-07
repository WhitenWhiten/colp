/* CS-01 community vote control. Mounts on every votable surface
   (collection masthead, bookmark detail, digest series, digest issue) and
   resolves the live target + vote counts through the community target
   endpoint before enabling a vote. Anonymous visitors still see the
   authoritative counts; pressing either arrow routes them to /login with a
   returnTo (the pill is the sign-in affordance — no separate CTA, so every
   masthead shows one Follow control and one vote pill, nothing more). The
   server-declared canVote flag (false for owners and any other restricted
   viewer) renders the buttons disabled rather than hidden, matching the
   FollowWorkflowButton pattern of one stable control across states. Hidden
   entirely when the feature is not exposed or the target cannot be resolved
   (uniform concealment). */
import { useNavigate } from 'react-router-dom'
import { isCommunityExposureEnabled } from '../api'
import type { CommunityTargetQuery } from '../api'
import { useAuth } from '../auth/AuthContext'
import { useCommunityVote } from '../lib/useCommunityVote'
import { plural } from '../lib/plural'
import { Icon } from './Icon'

export type CommunityVoteSummary = {
  myVote: -1 | 0 | 1 | null
  up: number
  down: number
}

export function CommunityVoteControl({ query, enabled = true, className, testId = 'community-vote' }: {
  /** Target selector for the surface; null keeps the control hidden. */
  query: CommunityTargetQuery | null
  /** Page-level gate (e.g. wait for the series projection on issue pages). */
  enabled?: boolean
  className?: string
  testId?: string
}) {
  const { isLoggedIn, bootstrapping } = useAuth()
  const navigate = useNavigate()
  const exposed = isCommunityExposureEnabled()
  const canResolve = exposed && enabled && !bootstrapping && query !== null
  const workflow = useCommunityVote({ query: canResolve ? query : null, enabled: canResolve })

  if (!exposed || !enabled || !query || bootstrapping) return null
  if (workflow.status === 'unavailable') return null

  const rootClass = `community-vote${className ? ` ${className}` : ''}`
  const upCount = workflow.up ?? 0
  const downCount = workflow.down ?? 0

  if (workflow.status === 'loading') {
    return (
      <span className={`${rootClass} community-vote--loading`} data-testid={testId} aria-busy="true">
        <span className="visually-hidden" role="status">Checking votes</span>
        <span className="community-vote-btn community-vote-btn--skeleton" aria-hidden />
      </span>
    )
  }

  if (workflow.status === 'conflict') {
    return (
      <span className={rootClass} data-testid={testId}>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          data-testid={`${testId}-refresh`}
          onClick={() => void workflow.refresh()}
        >
          Refresh votes
        </button>
        <span className="community-vote-message" role="status">{workflow.message}</span>
      </span>
    )
  }

  if (workflow.status === 'error' || workflow.status === 'unknown') {
    const label = workflow.status === 'unknown' || workflow.retryKind === 'intent'
      ? 'Retry'
      : 'Retry status'
    return (
      <span className={rootClass} data-testid={testId}>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          data-testid={`${testId}-retry`}
          onClick={() => void workflow.retry()}
        >
          {label}
        </button>
        {workflow.message ? (
          <span className="community-vote-message" role="alert">{workflow.message}</span>
        ) : null}
      </span>
    )
  }

  const busy = workflow.status === 'pending'
  const votingOpen = isLoggedIn && workflow.canVote && !busy
  /* Anonymous visitors get live arrows that lead to sign-in; a signed-in
     viewer the server refuses (owner, restricted) gets disabled arrows. */
  const pressable = votingOpen || !isLoggedIn
  const press = (value: 1 | -1) => {
    if (!isLoggedIn) {
      // Same-origin path only, matching the safeReturnTo convention on /login.
      const returnTo = `${window.location.pathname}${window.location.search}`
      navigate(`/login?returnTo=${encodeURIComponent(returnTo)}`)
      return
    }
    void workflow.vote(value)
  }
  const hint = (mine: boolean, verb: 'upvote' | 'downvote') => votingOpen
    ? (mine ? `Remove your ${verb}` : verb === 'upvote' ? 'Upvote' : 'Downvote')
    : isLoggedIn ? 'You cannot vote on this' : 'Sign in to vote'

  return (
    <span className={`${rootClass}${!isLoggedIn ? ' community-vote--signin' : ''}`} data-testid={testId}>
      <span className="community-vote-group" role="group" aria-label="Community votes">
        <button
          type="button"
          className={`community-vote-btn community-vote-btn--up${workflow.myVote === 1 ? ' is-active' : ''}`}
          data-testid={`${testId}-up`}
          aria-pressed={workflow.myVote === 1}
          aria-busy={busy}
          aria-label={`${isLoggedIn ? 'Upvote' : 'Sign in to upvote'}${upCount > 0 ? `, ${plural(upCount, 'vote')}` : ''}`}
          disabled={!pressable}
          title={hint(workflow.myVote === 1, 'upvote')}
          onClick={() => press(1)}
        >
          <Icon name="chevron-up" />
          <span className="community-vote-count" data-testid={`${testId}-up-count`}>{upCount}</span>
        </button>
        <button
          type="button"
          className={`community-vote-btn community-vote-btn--down${workflow.myVote === -1 ? ' is-active' : ''}`}
          data-testid={`${testId}-down`}
          aria-pressed={workflow.myVote === -1}
          aria-busy={busy}
          aria-label={`${isLoggedIn ? 'Downvote' : 'Sign in to downvote'}${downCount > 0 ? `, ${plural(downCount, 'vote')}` : ''}`}
          disabled={!pressable}
          title={hint(workflow.myVote === -1, 'downvote')}
          onClick={() => press(-1)}
        >
          <Icon name="chevron-down" />
          <span className="community-vote-count" data-testid={`${testId}-down-count`}>{downCount}</span>
        </button>
      </span>
      <span className="visually-hidden" aria-live="polite">{workflow.message}</span>
    </span>
  )
}
