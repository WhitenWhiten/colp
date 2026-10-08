import { classificationFolderLabel } from './classification-folder-label'
import { useEffect, useState } from 'react'
import type { ClassificationRun, ClassificationRunApplyRequest, EditorSnapshot } from '../../api'
import { useConfirm } from '../../components/ConfirmModal'

type Selection = ClassificationRunApplyRequest['selections'][number] & { selected: boolean }
const failureCopy: Record<string, string> = {
  provider_timeout: 'Suggestion timed out', provider_unavailable: 'Suggestions unavailable', contract_drift: 'Invalid provider response',
  outcome_unknown: 'Provider result could not be confirmed', budget_exhausted: 'Classification limit reached',
  context_limit: 'Bookmark context is too large', deadline_exceeded: 'Batch deadline reached', cancelled: 'Cancelled',
}
export function ClassificationBatchReview({ run, snapshot, disabled, onApply }: {
  run: ClassificationRun; snapshot: EditorSnapshot | null; disabled: boolean; onApply: (document: ClassificationRunApplyRequest) => void
}) {
  const confirm = useConfirm()
  const [choices, setChoices] = useState<Record<string, Selection>>({})
  useEffect(() => {
    if (run.status !== 'open') return
    const entries: [string, Selection][] = []
    for (const action of run.actions) {
      if (action.status !== 'succeeded' || !action.decision) continue
      entries.push([action.actionId, {
        actionId: action.actionId, selected: true, folderId: action.decision.folder?.folderId ?? null,
        addTags: action.decision.tags.candidates.filter(tag => tag.selected).slice(0, 3).map(tag => tag.tag),
      }])
    }
    setChoices(Object.fromEntries(entries))
    // An open run is immutable until Apply/Cancel; polling progress must not reset reviewed choices.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.runId, run.status])
  const nodes = new Map(snapshot?.nodes.map(node => [node.id, node]) ?? [])
  const patch = (id: string, value: Partial<Selection>) => setChoices(old => ({ ...old, [id]: { ...old[id]!, ...value } }))
  const selections = Object.values(choices).filter(choice => choice.selected && (choice.folderId !== null || choice.addTags.length))
    .map(({ actionId, folderId, addTags }) => ({ actionId, folderId, addTags: [...addTags] }))
  return <section aria-label="Batch review" className="classification-batch-review">
    <h2>Review suggestions</h2>
    <p className="meta">Only successful items can be selected. All selected changes are applied together once.</p>
    <ol className="classification-batch-items">
      {run.actions.map(action => {
        const node = nodes.get(action.nodeId), title = node?.title?.slice(0, 160) || 'Saved bookmark'
        if (action.status !== 'succeeded' || action.decision === null) return <li key={action.actionId}><strong>{title}</strong><p>{action.status === 'failed'
          ? failureCopy[action.failureCode] ?? 'Suggestion failed' : 'Classifying…'}</p></li>
        const choice = choices[action.actionId], decision = action.decision
        const folders = [...new Set([...(decision.folder?.probabilities.map(item => item.folderId) ?? []), decision.folder?.folderId,
          ...(snapshot?.nodes.filter(node => node.kind === 'folder').map(node => node.id) ?? [])])]
          .filter((id): id is string => typeof id === 'string')
        const coverage = decision.candidateCoverage
        const clipped = coverage.l1Included < coverage.l1Total || coverage.descendantIncluded < coverage.descendantTotal || coverage.tagIncluded < coverage.tagTotal
        return <li key={action.actionId}>
          <label><input type="checkbox" checked={choice?.selected ?? false} disabled={disabled || !choice}
            onChange={event => patch(action.actionId, { selected: event.target.checked })} /> {title}</label>
          {clipped && <p className="meta">Some folders or tags were outside this suggestion's candidate limit.</p>}
          <div className="field"><label htmlFor={`batch-folder-${action.actionId}`}>Folder for {title}</label>
            <select id={`batch-folder-${action.actionId}`} value={choice?.folderId ?? ''} disabled={disabled || !choice?.selected}
              onChange={event => patch(action.actionId, { folderId: event.target.value || null })}>
              <option value="">Keep current folder</option>
              {folders.map(id => <option key={id} value={id}>{classificationFolderLabel(nodes, id)}</option>)}
            </select>
          </div>
          {decision.tags.candidates.length > 0 && <fieldset disabled={disabled || !choice?.selected}>
            <legend>Existing tags for {title} (up to 3)</legend>
            <p className="meta">Short codes such as t1 or x-17 have unclear meaning; review them carefully.</p>
            {decision.tags.candidates.map(candidate => <label key={candidate.tag}>
              <input type="checkbox" checked={choice?.addTags.includes(candidate.tag) ?? false}
                disabled={!choice?.addTags.includes(candidate.tag) && (choice?.addTags.length ?? 0) >= 3}
                onChange={event => patch(action.actionId, { addTags: event.target.checked
                  ? [...choice!.addTags, candidate.tag] : choice!.addTags.filter(tag => tag !== candidate.tag) })} /> {candidate.tag}
            </label>)}
          </fieldset>}
        </li>
      })}
    </ol>
    {run.status === 'open' && <button type="button" className="btn btn-primary" disabled={disabled || !selections.length}
      onClick={async () => {
        if (await confirm({
          title: `Apply ${selections.length} selected changes?`,
          body: `This will update ${selections.length} bookmarks in your collection.`,
          confirmLabel: 'Apply',
        })) {
          onApply({ selections })
        }
      }}>Apply {selections.length} selected changes</button>}
  </section>
}
