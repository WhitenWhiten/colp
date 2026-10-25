import type { LinkHealthItem, LinkHealthStatus } from '../../api'
import type { StatusTone } from '../../components/StatusBadge'

export type LinkHealthDisplayKind =
  | 'pending'
  | 'healthy'
  | 'redirect'
  | 'broken'
  | 'check_failed'
  | 'remote_error'

export const HEALTH_STATUS_TONE: Record<LinkHealthDisplayKind, StatusTone> = {
  pending: 'muted',
  healthy: 'success',
  redirect: 'accent',
  broken: 'danger',
  check_failed: 'warning',
  remote_error: 'warning',
}

export function classifyLinkHealthDisplay(
  item: Pick<LinkHealthItem, 'status' | 'errorClass' | 'httpStatus'>,
): { kind: LinkHealthDisplayKind; label: string } {
  if (item.status === 'pending' || item.status === 'healthy' || item.status === 'redirect') {
    return { kind: item.status, label: labelFor(item.status) }
  }
  if (item.errorClass === 'timeout' || item.errorClass === 'denied' || item.errorClass === 'dns') {
    return { kind: 'check_failed', label: 'Could not check' }
  }
  if (item.errorClass === 'invalid_url') return { kind: 'broken', label: 'Broken' }
  const status = item.httpStatus
  if (status != null && status >= 500 && status <= 599) {
    return { kind: 'remote_error', label: 'Remote error' }
  }
  if (status != null && status >= 400 && status <= 499) return { kind: 'broken', label: 'Broken' }
  if (item.errorClass === 'http' && status == null) {
    return { kind: 'check_failed', label: 'Could not check' }
  }
  if (status == null) return { kind: 'check_failed', label: 'Could not check' }
  return { kind: 'broken', label: 'Broken' }
}

/** Why a check came back as it did, in a few words; null when the badge says it all. */
export function healthReason(item: Pick<LinkHealthItem, 'status' | 'errorClass' | 'httpStatus'>): string | null {
  const kind = classifyLinkHealthDisplay(item).kind
  if (kind === 'check_failed') {
    if (item.errorClass === 'timeout') return 'Timed out'
    if (item.errorClass === 'dns') return 'Host not found'
    if (item.errorClass === 'denied') return "This server isn't allowed to reach it"
    return "Couldn't connect"
  }
  if (kind === 'broken' && item.errorClass === 'invalid_url') return 'Not a valid web address'
  if ((kind === 'broken' || kind === 'remote_error') && item.httpStatus != null) return `The site returned ${item.httpStatus}`
  return null
}

export function isCannotProbe(item: Pick<LinkHealthItem, 'status' | 'errorClass' | 'httpStatus'>): boolean {
  const kind = classifyLinkHealthDisplay(item).kind
  return kind === 'check_failed' || kind === 'remote_error'
}

export function canReviewDuplicates(item: Pick<LinkHealthItem, 'membership'>): boolean {
  return item.membership !== 'viewer'
}

function labelFor(status: Extract<LinkHealthStatus, 'pending' | 'healthy' | 'redirect'>): string {
  if (status === 'pending') return 'Not checked yet'
  if (status === 'healthy') return 'Healthy'
  return 'Redirected'
}
