import { useEffect, useRef, useState } from 'react'
import { CommunityCharCounter } from './CommunityCharCounter'
import { Modal } from './Modal'

/* CS-04 curation/lock reason cap (community_comment_curations.reason and
   community_comment_settings.reason both check char_length 1..1000). The
   field counts code points so astral characters count once. */
const REASON_MAX_CODE_POINTS = 1_000

type Props = {
  open: boolean
  /** Dialog heading + accessible label, e.g. "Hide this comment?" */
  title: string
  /** Action-button text; the destructive decision names itself, e.g. "Hide". */
  confirmLabel: string
  /** Field label and placeholder, e.g. "Reason for hiding". */
  reasonLabel: string
  /** A manage write is in flight: the field and both actions lock. */
  pending?: boolean
  onSubmit: (reason: string) => void
  onClose: () => void
}

/**
 * CS-04 reason prompt for the reversible curator decisions — hide/unhide a
 * comment, lock/unlock the comment area. The schema requires a reason for
 * each, so those decisions collect it in the same danger-tone modal chrome
 * the author's delete confirm uses; sibling decisions share one interaction
 * grammar instead of mixing an inline form with a modal.
 */
export function CommunityReasonModal({
  open,
  title,
  confirmLabel,
  reasonLabel,
  pending = false,
  onSubmit,
  onClose,
}: Props) {
  const [reason, setReason] = useState('')
  /* The exit beat keeps painting the last open frame (Modal holds its
     children the same way), so cache the labels while open — the caller
     clears its target the moment the write lands. */
  const lastRef = useRef({ title, confirmLabel, reasonLabel })
  if (open) lastRef.current = { title, confirmLabel, reasonLabel }
  const shown = open ? { title, confirmLabel, reasonLabel } : lastRef.current

  useEffect(() => {
    if (open) setReason('')
  }, [open])

  const trimmed = reason.trim()
  const count = [...reason].length
  const canSubmit = !pending && trimmed.length > 0 && count <= REASON_MAX_CODE_POINTS

  return (
    <Modal
      open={open}
      onClose={onClose}
      label={shown.title}
      title={shown.title}
      size="sm"
      tone="danger"
    >
      <div className="field">
        <label htmlFor="community-reason-input">{shown.reasonLabel}</label>
        <textarea
          id="community-reason-input"
          rows={2}
          value={reason}
          placeholder={shown.reasonLabel}
          disabled={pending}
          onChange={(event) => setReason(event.target.value)}
          data-testid="community-reason-input"
        />
        <CommunityCharCounter count={count} max={REASON_MAX_CODE_POINTS} testId="community-reason-count" />
      </div>
      <div className="empty-state-actions">
        <button
          type="button"
          className="btn btn-secondary"
          data-testid="community-reason-cancel"
          onClick={onClose}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-danger"
          data-testid="community-reason-submit"
          disabled={!canSubmit}
          onClick={() => onSubmit(trimmed)}
        >
          {pending ? 'Saving…' : shown.confirmLabel}
        </button>
      </div>
    </Modal>
  )
}
