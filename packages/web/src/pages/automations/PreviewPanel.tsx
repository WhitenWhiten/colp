import type { AutomationPreviewDecision, AutomationPreviewResult } from '../../api/automationTypes'
import { Icon } from '../../components/Icon'
import { StatusBadge } from '../../components/StatusBadge'
import { plural } from '../../lib/plural'
import { PREVIEW_GROUPS, previewExplanation, type PreviewNames } from './copy'

/* AU-02: what the rule would have done to the owner's recent bookmarks.
   The server evaluates; this panel counts its decisions per outcome and
   folds identical explanations together, so 180 "doesn't match" rows read
   as one line. Preview changes nothing, and says so. */

export type PreviewView = {
  result: AutomationPreviewResult
  /** The draft changed after this preview ran. */
  stale: boolean
}

type Line = { text: string; count: number }

function linesFor(decisions: readonly AutomationPreviewDecision[], names: PreviewNames): Line[] {
  const counts = new Map<string, number>()
  for (const decision of decisions) {
    const text = previewExplanation(decision, names)
    counts.set(text, (counts.get(text) ?? 0) + 1)
  }
  return [...counts.entries()].map(([text, count]) => ({ text, count })).sort((a, b) => b.count - a.count)
}

export function PreviewPanel({
  preview,
  busy,
  collectionTitle,
  names,
  onPreview,
  disabled,
}: {
  preview: PreviewView | null
  busy: boolean
  collectionTitle: string | null
  names: PreviewNames
  onPreview: () => void
  /** The draft is not complete enough to preview. */
  disabled: boolean
}) {
  const where = collectionTitle ? <strong>{collectionTitle}</strong> : 'the collection'
  if (!preview) {
    return (
      <section className="automation-preview" aria-labelledby="automation-preview-heading" data-state="empty">
        <h2 id="automation-preview-heading" className="automation-panel-title">Preview</h2>
        <p className="automation-preview-lede">
          See what this rule would do to your recent bookmarks in {where} before you turn it on. A preview changes nothing.
        </p>
        <button type="button" className="btn btn-secondary btn-sm" disabled={disabled || busy} onClick={onPreview}>
          {busy ? 'Previewing…' : 'Preview'}
        </button>
      </section>
    )
  }

  const { result, stale } = preview
  const total = result.decisions.length
  const groups = PREVIEW_GROUPS
    .map((group) => ({ ...group, decisions: result.decisions.filter((decision) => decision.outcome === group.outcome) }))
    .filter((group) => group.decisions.length > 0)
  const matched = result.decisions.filter((decision) => decision.outcome === 'matched').length
  const warnings = result.diagnostics.filter((item) => item.severity !== 'info')

  return (
    <section
      className="automation-preview"
      aria-labelledby="automation-preview-heading"
      aria-busy={busy}
      data-state={stale ? 'stale' : 'current'}
    >
      <div className="automation-preview-head">
        <h2 id="automation-preview-heading" className="automation-panel-title">Preview</h2>
        <button type="button" className="btn btn-ghost btn-sm" disabled={disabled || busy} onClick={onPreview}>
          <Icon name="refresh" />
          {busy ? 'Previewing…' : 'Preview again'}
        </button>
      </div>
      {stale && (
        <p className="automation-preview-stale" role="status">
          You changed the rule after this preview. Preview again before turning it on.
        </p>
      )}
      <p className="automation-preview-lede">
        {total === 0
          ? <>There are no bookmarks in {where} to try it on yet. That is fine: the rule still files new ones.</>
          : <>Tried on your {plural(total, 'most recent bookmark')} in {where}{result.truncated ? ' (a sample)' : ''}. Nothing was changed.</>}
      </p>
      {total > 0 && (
        <ul className="automation-preview-stats" aria-label="Preview totals">
          {PREVIEW_GROUPS.map((group) => {
            const count = result.decisions.filter((decision) => decision.outcome === group.outcome).length
            if (count === 0 && group.outcome !== 'matched') return null
            return (
              <li key={group.outcome} data-outcome={group.outcome}>
                <span className="automation-preview-stat">{count}</span>
                <span className="automation-preview-stat-label">{group.label.toLowerCase()}</span>
              </li>
            )
          })}
        </ul>
      )}
      {total > 0 && matched === 0 && (
        <p className="automation-preview-note">
          None of these bookmarks match. That can be right for a rule about new kinds of pages; check the conditions if you expected matches.
        </p>
      )}
      {groups.map((group) => (
        <details key={group.outcome} className="automation-preview-group" open={group.outcome !== 'notMatched'}>
          <summary>
            <Icon name="chevron-right" className="automation-disclosure-chevron" />
            <StatusBadge tone={group.tone}>{group.label}</StatusBadge>
            <span className="automation-preview-count">{plural(group.decisions.length, 'bookmark')}</span>
          </summary>
          <ul className="automation-preview-lines">
            {linesFor(group.decisions, names).map((line) => (
              <li key={line.text}>
                <span>{line.text}</span>
                {line.count > 1 && <span className="automation-preview-times">×{line.count}</span>}
              </li>
            ))}
          </ul>
        </details>
      ))}
      {warnings.length > 0 && (
        <ul className="automation-preview-warnings">
          {warnings.map((item) => <li key={`${item.code}:${item.location}`}>{item.message}</li>)}
        </ul>
      )}
      <p className="automation-meta">
        Uses your bookmarks as they are now. A turned-on rule only acts on bookmarks you save from then on.
      </p>
    </section>
  )
}
