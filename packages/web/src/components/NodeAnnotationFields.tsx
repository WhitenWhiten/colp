import type { AnnotationVisibility } from '../api'
import { FilterRail } from './FilterRail'

/** The drawer and the editor expose exactly two visibility segments. */
export type SegmentVisibility = Extract<AnnotationVisibility, 'private' | 'public'>

const OPTIONS: ReadonlyArray<{ value: SegmentVisibility; label: string }> = [
  { value: 'private', label: 'Private' },
  { value: 'public', label: 'Public' },
]

/**
 * Two-segment Private/Public control on the shared FilterRail radiogroup
 * (R10-27): `.view-switch` segmented chrome plus the APG arrow-key/roving-
 * tabindex contract every rail already carries.
 */
function VisibilitySwitch({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string
  value: SegmentVisibility
  onChange: (value: SegmentVisibility) => void
  disabled?: boolean
}) {
  return (
    <FilterRail
      className="node-visibility-switch view-switch"
      variant="segments"
      label={`${label} visibility`}
      value={value}
      options={OPTIONS.map((option) => ({ ...option, disabled }))}
      onChange={onChange}
    />
  )
}

/**
 * The note + TL;DR block shared by the library desk drawer (FE-04) and the
 * collection editor inspector (FE-07): a head row with the field label and its
 * visibility switch, then the textarea. The textarea sits in a `.field` so it
 * keeps the canonical form chrome instead of the native control.
 */
export function NodeAnnotationFields({
  idPrefix,
  disabled,
  tldr,
  note,
  tldrVisibility,
  noteVisibility,
  onTldrChange,
  onNoteChange,
  onTldrVisibilityChange,
  onNoteVisibilityChange,
}: {
  idPrefix: string
  disabled?: boolean
  tldr: string
  note: string
  tldrVisibility: SegmentVisibility
  noteVisibility: SegmentVisibility
  onTldrChange: (value: string) => void
  onNoteChange: (value: string) => void
  onTldrVisibilityChange: (value: SegmentVisibility) => void
  onNoteVisibilityChange: (value: SegmentVisibility) => void
}) {
  const tldrId = `${idPrefix}-tldr`
  const noteId = `${idPrefix}-note`

  return (
    <>
      <section className="node-drawer-annotation">
        <div className="node-drawer-annotation-head">
          <label htmlFor={tldrId}>TL;DR</label>
          <VisibilitySwitch
            label="TL;DR"
            value={tldrVisibility}
            onChange={onTldrVisibilityChange}
            disabled={disabled}
          />
        </div>
        <div className="field">
          <textarea
            id={tldrId}
            rows={2}
            value={tldr}
            disabled={disabled}
            placeholder="One-sentence takeaway a reader can trust…"
            onChange={(event) => onTldrChange(event.target.value)}
          />
        </div>
      </section>
      <section className="node-drawer-annotation">
        <div className="node-drawer-annotation-head">
          <label htmlFor={noteId}>Note</label>
          <VisibilitySwitch
            label="Note"
            value={noteVisibility}
            onChange={onNoteVisibilityChange}
            disabled={disabled}
          />
        </div>
        <div className="field">
          <textarea
            id={noteId}
            rows={4}
            value={note}
            disabled={disabled}
            placeholder="Why this is worth keeping — shown publicly when set to Public…"
            onChange={(event) => onNoteChange(event.target.value)}
          />
        </div>
      </section>
    </>
  )
}
