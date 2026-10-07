import type { ProductSyncConflictResolutionView, SyncConflictSummary } from '../../api'
import { customField, fieldName, formatInstant } from './fields'
import { CONFLICT_TYPE_LABELS, INTENT_MESSAGE_CLASS, RESOLUTIONS, type ConflictDraft, type Resolution } from './types'

export function ConflictReceipt({ receipt }: { receipt: ProductSyncConflictResolutionView }) {
  return <article className="conflict-card conflict-receipt" data-conflict-receipt={receipt.conflictId}>
    <header className="conflict-title"><div><span className="conflict-field">Resolved</span><h3>Conflict resolved</h3></div>
      <time dateTime={receipt.resolvedAt}>{formatInstant(receipt.resolvedAt)}</time></header>
  </article>
}

export function ConflictEditor({ conflict, draft, onDraft, onSubmit, onReplay, onRefresh, onNewIntent }: {
  conflict: SyncConflictSummary; draft: ConflictDraft; onDraft(change: Partial<ConflictDraft>): void
  onSubmit(): void; onReplay(): void; onRefresh(): void; onNewIntent(): void
}) {
  const busy = draft.phase === 'submitting'
  const frozen = draft.phase === 'unknown' || (draft.phase === 'blocked' && draft.frozen !== null)
  const custom = customField(conflict.field)
  const choose = (resolution: Resolution) => onDraft({ resolution, phase: 'idle', message: null, frozen: null })
  return <article className="conflict-card" data-conflict-id={conflict.id}>
    <header className="conflict-title"><div><span className="conflict-field">{fieldName(conflict.field)}</span><h3>{CONFLICT_TYPE_LABELS[conflict.type]}</h3></div><time dateTime={conflict.createdAt}>{formatInstant(conflict.createdAt)}</time></header>
    <div className="conflict-comparison"><div><span>In Know-N</span><p>{conflict.summary.current ?? 'No value'}</p></div><div><span>From the browser</span><p>{conflict.summary.incoming ?? 'No value'}</p></div></div>
    <fieldset disabled={busy || frozen} className="conflict-options"><legend>Resolution</legend>
      {RESOLUTIONS.map((option) => { const allowed = conflict.allowedResolutions.includes(option.value); const supported = option.value !== 'custom' || custom !== null
        return <label key={option.value} className="resolution-option"><input type="radio" name={`resolution-${conflict.id}`} value={option.value}
          checked={draft.resolution === option.value} disabled={!allowed || !supported} onChange={() => choose(option.value)} />
          <span><strong>{option.label}</strong><small>{allowed && supported ? option.detail : 'Not available for this conflict.'}</small></span></label> })}
    </fieldset>
    {draft.resolution === 'custom' && custom && <CustomEditor field={custom} value={draft.customText} disabled={busy || frozen}
      onChange={(customText) => onDraft({ customText, phase: 'idle', message: null, frozen: null })} />}
    {draft.message && <div className={`conflict-message ${INTENT_MESSAGE_CLASS[draft.phase] ?? ''}`.trim()} role="alert">{draft.message}</div>}
    <div className="conflict-submit">{draft.phase === 'unknown'
      ? <button type="button" className="btn btn-primary btn-sm" onClick={onReplay}>Retry resolution</button>
      : draft.phase === 'stale' ? <button type="button" className="btn btn-primary btn-sm" onClick={onSubmit}>Confirm with latest version</button>
        : draft.phase === 'refresh_required' ? <button type="button" className="btn btn-secondary btn-sm" onClick={onRefresh}>Refresh conflict</button>
        : draft.phase === 'blocked' && draft.frozen ? <button type="button" className="btn btn-secondary btn-sm" onClick={onNewIntent}>Start new resolution</button>
          : <button type="button" className="btn btn-primary btn-sm" disabled={busy || !conflict.allowedResolutions.includes(draft.resolution)
            || (draft.resolution === 'custom' && !custom)} onClick={onSubmit}>{busy ? 'Resolving…' : 'Resolve conflict'}</button>}</div>
  </article>
}

function CustomEditor({ field, value, disabled, onChange }: {
  field: NonNullable<ReturnType<typeof customField>>; value: string; disabled: boolean; onChange(value: string): void
}) {
  if (field === 'visibility') return <label className="custom-editor field"><span>Custom visibility</span><select aria-label="Custom visibility" value={value || 'inherit'} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
    <option value="inherit">Inherit</option><option value="protected">Protected</option><option value="private">Private</option></select></label>
  if (field === 'description' || field === 'tags') return <label className="custom-editor field"><span>{field === 'tags' ? 'Custom tags (one per line)' : 'Custom description'}</span>
    <textarea aria-label={field === 'tags' ? 'Custom tags' : 'Custom description'} value={value} disabled={disabled}
      maxLength={field === 'tags' ? 4159 : 20_000} rows={field === 'tags' ? 4 : 5} onChange={(event) => onChange(event.target.value)} /></label>
  const label = field === 'title' ? 'Custom title' : field === 'canonicalUrl' ? 'Custom canonical URL' : 'Custom URL'
  return <label className="custom-editor field"><span>{label}</span><input aria-label={label} type={field === 'title' ? 'text' : 'url'} value={value} disabled={disabled}
    maxLength={field === 'title' ? 512 : 4096} onChange={(event) => onChange(event.target.value)} /></label>
}
