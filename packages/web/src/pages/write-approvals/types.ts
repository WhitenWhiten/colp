import type {
  WriteApprovalDecision,
  WriteApprovalOperationPreview,
  WriteApprovalView,
} from '../../api'
import type { IconName } from '../../components/Icon'
import type { StatusTone } from '../../components/StatusBadge'
import { formatMediumInstant } from '../../lib/formatDate'

export type DraftPhase =
  | 'idle'
  | 'submitting'
  | 'unknown'
  | 'stale'
  | 'refresh_required'
  | 'blocked'

export type FrozenDecision = {
  intentId: string
  decision: WriteApprovalDecision
  etag: string
}

export type DecisionDraft = {
  phase: DraftPhase
  message: string | null
  frozen: FrozenDecision | null
  desiredDecision: WriteApprovalDecision | null
}

export const idleDraft: DecisionDraft = {
  phase: 'idle',
  message: null,
  frozen: null,
  desiredDecision: null,
}

const STATUS_LABELS: Record<WriteApprovalView['status'], string> = {
  pending: 'Pending approval',
  approved: 'Approved',
  committing: 'Committing',
  consumed: 'Consumed',
  cancelled: 'Cancelled',
  expired: 'Expired',
}

const OPERATION_LABELS: Record<string, string> = {
  set_visibility: 'Change visibility',
}

/** A pending plan past its expiry reads as expired everywhere. */
export function effectiveStatus(approval: WriteApprovalView): WriteApprovalView['status'] {
  if (approval.status === 'pending' && Date.parse(approval.expiresAt) <= Date.now()) {
    return 'expired'
  }
  return approval.status
}

export function statusLabel(approval: WriteApprovalView): string {
  return STATUS_LABELS[effectiveStatus(approval)]
}

export type WriteApprovalTone = 'warning' | 'success' | 'neutral' | 'muted'

export const TONE_CLASS: Record<WriteApprovalTone, string> = {
  warning: 'is-warning',
  success: 'is-success',
  neutral: 'is-neutral',
  muted: 'is-muted',
}

export const RISK_TONE: Record<WriteApprovalView['risk'], StatusTone> = {
  high: 'danger',
  medium: 'warning',
  low: 'success',
}

export const RISK_LABEL: Record<WriteApprovalView['risk'], string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
}

export const DRAFT_PHASE_CLASS: Record<DraftPhase, string> = {
  idle: 'is-idle',
  submitting: 'is-submitting',
  unknown: 'is-unknown',
  stale: 'is-stale',
  refresh_required: 'is-refresh_required',
  blocked: 'is-blocked',
}

const STATUS_TONES: Record<WriteApprovalView['status'], WriteApprovalTone> = {
  pending: 'warning',
  approved: 'success',
  committing: 'success',
  consumed: 'success',
  cancelled: 'neutral',
  expired: 'muted',
}

const STATUS_ICONS: Record<WriteApprovalView['status'], IconName> = {
  pending: 'bell',
  approved: 'check',
  committing: 'refresh',
  consumed: 'check',
  cancelled: 'cross',
  expired: 'info',
}

export function statusTone(approval: WriteApprovalView): WriteApprovalTone {
  return STATUS_TONES[effectiveStatus(approval)]
}

export function statusIcon(approval: WriteApprovalView): IconName {
  return STATUS_ICONS[effectiveStatus(approval)]
}

const TERMINAL_DESCRIPTIONS: Record<WriteApprovalView['status'], string> = {
  pending: '',
  approved: 'This plan has been approved and is ready to execute.',
  committing: 'Applying the approved changes…',
  consumed: 'This plan has been fully executed.',
  cancelled: 'This plan was denied. No changes were applied.',
  expired: 'This plan expired before a decision was made.',
}

export function terminalStatusDescription(approval: WriteApprovalView): string {
  return TERMINAL_DESCRIPTIONS[effectiveStatus(approval)]
}

export function isDecisionAllowed(approval: WriteApprovalView): boolean {
  return approval.status === 'pending' && Date.parse(approval.expiresAt) > Date.now()
}

export function formatInstant(value: string): string {
  return formatMediumInstant(value)
}

function createNodeOperationLabel(kind: string | null | undefined): string {
  if (kind === 'bookmark') return 'Create bookmark'
  if (kind === 'folder') return 'Create folder'
  return 'Create bookmark or folder'
}

export function operationTypeLabel(
  operation: WriteApprovalOperationPreview,
  target: WriteApprovalView['target'],
): string {
  if (operation.type === 'create_node') {
    return createNodeOperationLabel(operation.nodeSummary?.kind)
  }
  if (operation.type === 'set_visibility' && target.kind === 'collection') {
    if (operation.visibility === 'public') return 'Publish library'
    if (operation.visibility === 'unlisted') return 'Make library unlisted'
    if (operation.visibility === 'private') return 'Unpublish library'
    return 'Change library visibility'
  }
  return OPERATION_LABELS[operation.type] ?? operation.type.replaceAll('_', ' ')
}

export function operationIcon(operation: WriteApprovalOperationPreview): IconName {
  if (operation.type === 'set_visibility') {
    return operation.visibility === 'public' || operation.visibility === 'unlisted'
      ? 'lock-open'
      : 'lock'
  }
  if (operation.type === 'create_node') {
    return operation.nodeSummary?.kind === 'folder' ? 'folder' : 'bookmark'
  }
  return 'file'
}

export type WriteApprovalVisibilityTone = 'warning' | 'accent' | 'neutral'

/** Exposure-increasing targets get the caution tint; everything else stays quiet. */
export function visibilityTone(visibility: string | null): WriteApprovalVisibilityTone {
  if (visibility === 'public') return 'warning'
  if (visibility === 'unlisted') return 'accent'
  return 'neutral'
}

export type WriteApprovalKeyChange = {
  icon: IconName
  title: string
  detail: string
  targetId: string | null
  /** Human-readable name for the target when the preview carries one. */
  targetTitle: string | null
}

/**
 * The one thing a reviewer must not miss: an operation that exposes private
 * content. Everything else stays in the plain operations list.
 */
export function keyChangeForOperation(
  operation: WriteApprovalOperationPreview,
  target: WriteApprovalView['target'],
): WriteApprovalKeyChange | null {
  if (operation.type !== 'set_visibility') return null
  if (operation.visibility !== 'public' && operation.visibility !== 'unlisted') return null
  const targetId = operation.collectionId ?? operation.nodeId
  const subject = target.kind === 'collection' ? 'Library' : 'Item'
  const object = target.kind === 'collection' ? 'this library' : 'this item'
  if (operation.visibility === 'public') {
    return {
      icon: 'lock-open',
      title: `${subject} becomes public`,
      detail: `Anyone on the web can find and read ${object}.`,
      targetId,
      targetTitle: operation.nodeSummary?.title ?? null,
    }
  }
  return {
    icon: 'lock-open',
    title: `${subject} becomes unlisted`,
    detail: `Anyone with the link can read ${object}; it stays out of public listings.`,
    targetId,
    targetTitle: operation.nodeSummary?.title ?? null,
  }
}
