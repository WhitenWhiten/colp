/* Shared presentational core of FollowButton (profile) and
   CollectionFollowButton (collection): both workflows expose the same
   state machine (status/following/message/retryKind + toggle/refresh/
   retry), so the label stack, action routing, tone, and the width-stable
   measure stack live here exactly once. The wrappers keep their own
   gating (exposure flags, owner check, sign-in link, onState). */

/* Hidden copies of every standard workflow label stack in one grid cell
   with the live label, so the button keeps the longest label's rendered
   width (font/zoom responsive) and never jumps between states. Recovery
   labels (Retry…/Refresh status) stay unmeasured — rare, and the button
   grows to fit them. */
const FOLLOW_MEASURE_LABELS = ['Follow', 'Unfollow', 'Checking…', 'Following…', 'Unfollowing…']

export type FollowWorkflowView = {
  status: 'loading' | 'ready' | 'pending' | 'unknown' | 'conflict' | 'error' | 'unavailable'
  following: boolean
  message: string
  retryKind: 'authority' | 'intent'
  toggle: () => Promise<void>
  refresh: () => Promise<void>
  retry: () => Promise<void>
}

export function FollowWorkflowButton({ workflow, className, testId }: {
  workflow: FollowWorkflowView
  className?: string
  /** Base test id; also derives `-measure` / `-label` ids. Omitted entirely when undefined. */
  testId?: string
}) {
  const busy = workflow.status === 'loading' || workflow.status === 'pending'
  const following = workflow.following
  const label = workflow.status === 'loading'
    ? 'Checking…'
    : workflow.status === 'pending'
      ? following ? 'Unfollowing…' : 'Following…'
      : workflow.status === 'unknown' || (workflow.status === 'error' && workflow.retryKind === 'intent')
        ? 'Retry'
        : workflow.status === 'error'
          ? 'Retry status'
        : workflow.status === 'conflict'
          ? 'Refresh status'
          : following ? 'Unfollow' : 'Follow'
  const action = workflow.status === 'conflict'
    ? workflow.refresh
    : workflow.status === 'unknown' || workflow.status === 'error'
      ? workflow.retry
      : workflow.toggle
  const tone = following ? 'btn btn-secondary' : 'btn btn-primary'

  return (
    <>
      <button
        type="button"
        className={`${tone} follow-btn${following ? ' follow-btn--unfollow' : ''}${className ? ` ${className}` : ''}`}
        data-testid={testId}
        aria-pressed={following}
        aria-busy={busy}
        disabled={busy}
        onClick={() => void action()}
      >
        <span className="follow-btn-stack">
          {FOLLOW_MEASURE_LABELS.map((text) => (
            <span key={text} className="follow-btn-measure" data-testid={testId ? `${testId}-measure` : undefined} aria-hidden="true">{text}</span>
          ))}
          <span className="follow-btn-label" data-testid={testId ? `${testId}-label` : undefined}>{label}</span>
        </span>
      </button>
      {workflow.status === 'error' && workflow.message ? (
        <span className="follow-error" role="alert">{workflow.message}</span>
      ) : null}
      <span className="visually-hidden" aria-live="polite">{workflow.message}</span>
    </>
  )
}
