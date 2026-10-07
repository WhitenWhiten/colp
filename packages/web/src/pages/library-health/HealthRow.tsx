import { Link } from 'react-router-dom'
import type { LinkHealthItem } from '../../api'
import { DataTableCell, DataTableRow } from '../../components/DataTable'
import { StatusBadge } from '../../components/StatusBadge'
import { formatMediumInstant } from '../../lib/formatDate'
import {
  HEALTH_STATUS_TONE,
  canReviewDuplicates,
  classifyLinkHealthDisplay,
  isCannotProbe,
} from './classify'

export function hostOf(item: LinkHealthItem): string {
  if (item.host) return item.host
  try {
    return new URL(item.url).host
  } catch {
    return item.url
  }
}

export function resourceMeta(
  item: LinkHealthItem,
  scope: 'owned' | 'shared' | 'all',
): string {
  const base = `${hostOf(item)} · ${item.collectionTitle}`
  if (scope === 'owned' || item.membership == null) return base
  const caption = item.membership === 'owner' ? 'Owner'
    : item.membership === 'editor' ? 'Editor' : 'Viewer'
  return `${base} · ${caption}`
}

export function HealthRow({
  item, scope, busy, rowError, onMark, onUndo, onRetryCheck,
}: {
  item: LinkHealthItem
  scope: 'owned' | 'shared' | 'all'
  busy: boolean
  rowError?: string
  onMark: (item: LinkHealthItem) => void
  onUndo: (item: LinkHealthItem) => void
  onRetryCheck: (item: LinkHealthItem) => void
}) {
  const display = classifyLinkHealthDisplay(item)
  const reviewed = item.duplicateRelationId != null && item.duplicateRelationEtag != null
  const candidate = item.duplicateOfNodeId != null
  const reviewable = canReviewDuplicates(item)
  const editorTo = `/library/${encodeURIComponent(item.collectionId)}?node=${encodeURIComponent(item.nodeId)}`
  const editLink = reviewable
    ? <Link className="btn btn-secondary btn-sm" to={editorTo} aria-label={`Edit link: ${item.title}`}>Edit link</Link>
    : null
  const action = reviewed && reviewable ? (
    <button type="button" className="btn btn-secondary btn-sm" disabled={busy}
      aria-label={`Undo review: ${item.title}`}
      onClick={() => onUndo(item)}>Undo review</button>
  ) : candidate && reviewable ? (
    <button type="button" className="btn btn-secondary btn-sm" disabled={busy}
      aria-label={`Mark as duplicate: ${item.title}`}
      onClick={() => onMark(item)}>Mark as duplicate</button>
  ) : isCannotProbe(item) ? (
    <button type="button" className="btn btn-secondary btn-sm" disabled={busy}
      aria-label={`Retry check: ${item.title}`}
      onClick={() => onRetryCheck(item)}>Retry check</button>
  ) : item.status === 'healthy' ? null
    : item.status === 'redirect' && item.finalUrl ? (
      <span className="row gap-2">
        {editLink}
        <a className="btn btn-ghost btn-sm" href={item.finalUrl} target="_blank" rel="noopener noreferrer" aria-label={`Open final URL: ${item.title}`}>Open final URL</a>
      </span>
    ) : editLink
  return (
    <DataTableRow className="health-row" data-node-id={item.nodeId}>
      <DataTableCell className="health-resource" data-testid="health-resource">
        <strong>{reviewable ? <Link to={editorTo}>{item.title}</Link> : item.title}</strong>
        <span>{resourceMeta(item, scope)}</span>
      </DataTableCell>
      <DataTableCell className="health-issue">
        <StatusBadge tone={HEALTH_STATUS_TONE[display.kind]} data-testid="health-status">{display.label}</StatusBadge>
        {item.status === 'redirect' && item.finalUrl ? (
          <p>
            <a href={item.finalUrl} title={item.finalUrl} target="_blank" rel="noopener noreferrer">{item.finalUrl}</a>
          </p>
        ) : reviewed ? (
          <p>Reviewed as a duplicate. Both bookmarks stay in the collection.</p>
        ) : candidate ? (
          <p>Possible duplicate of another bookmark in this collection</p>
        ) : display.kind === 'check_failed' ? (
          <p>The checker could not reach this link. Retry the check.</p>
        ) : display.kind === 'remote_error' ? (
          <p>The remote server returned {item.httpStatus ?? 'an error'}. Retry the check.</p>
        ) : null}
      </DataTableCell>
      <DataTableCell className="health-checked">
        <span className="health-checked-label">Last checked </span>
        <time dateTime={item.checkedAt}>{formatMediumInstant(item.checkedAt ?? null)}</time>
      </DataTableCell>
      <DataTableCell className="health-action">
        {action}
        {rowError && <p className="field-error" role="alert">{rowError}</p>}
      </DataTableCell>
    </DataTableRow>
  )
}
