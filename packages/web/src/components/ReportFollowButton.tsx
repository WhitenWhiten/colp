import { useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { isReportsExposureEnabled } from '../api'
import { useAuth } from '../auth/AuthContext'
import { useReportFollowWorkflow } from '../lib/useReportFollowWorkflow'
import { SubscriptionFollowButton } from './bookmark-subscriptions/SubscriptionFollowButton'

export type ReportFollowAuthority = {
  following: boolean
  followerCount: number
}

/**
 * Follow button for a report (News Digest) series. Same chrome and state
 * machine as the collection Follow button; the report workflow broadcasts on
 * the report-follow channel so the Library Digests section reloads.
 */
export function ReportFollowButton({ reportId, className, onState }: {
  reportId: string | null | undefined
  className?: string
  onState?: (state: ReportFollowAuthority | null) => void
}) {
  const { isLoggedIn, bootstrapping } = useAuth()
  const exposed = isReportsExposureEnabled()
  const canRead = exposed && isLoggedIn && !bootstrapping && !!reportId
  const workflow = useReportFollowWorkflow({
    reportId: canRead ? reportId ?? null : null,
    enabled: canRead,
  })
  const onStateRef = useRef(onState)
  onStateRef.current = onState

  useEffect(() => {
    if (workflow.status === 'unavailable') {
      onStateRef.current?.(null)
      return
    }
    if (workflow.followerCount != null && workflow.status !== 'loading' && workflow.status !== 'pending') {
      onStateRef.current?.({ following: workflow.following, followerCount: workflow.followerCount })
    }
  }, [workflow.followerCount, workflow.following, workflow.status])

  if (exposed && !bootstrapping && !isLoggedIn && reportId) {
    // Same-origin path only, matching the safeReturnTo convention on /login.
    const returnTo = `${window.location.pathname}${window.location.search}`
    return (
      <Link
        to={`/login?returnTo=${encodeURIComponent(returnTo)}`}
        className={`btn btn-secondary follow-btn${className ? ` ${className}` : ''}`}
        data-testid="report-follow-signin"
      >
        Sign in to follow
      </Link>
    )
  }

  if (!canRead || workflow.status === 'unavailable') return null

  return <SubscriptionFollowButton source={{ sourceType: 'digest_series', sourceId: reportId! }} workflow={workflow} className={className} testId="report-follow" />
}
