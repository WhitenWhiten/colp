import { useState } from 'react'
import { Modal } from '../../components/Modal'
import { BodyPortal } from '../../components/BodyPortal'
import { EmbedComposer } from './EmbedComposer'

/** Readers get one quiet "Embed" link; the composer (iframe preview,
    appearance controls, snippet) opens only on request. */
export function EmbedShareButton({
  label = 'Embed this digest',
  ...props
}: Parameters<typeof EmbedComposer>[0] & { label?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(true)}>Embed</button>
      {/* The trigger sits in span.social-actions-links under .page-head.
          Portaling keeps the dialog out of that span so phone
          .social-actions .btn and .page-head p rules cannot restyle it. */}
      <BodyPortal>
        <Modal open={open} onClose={() => setOpen(false)} label={label} title="Embed" size="lg">
          {open ? <EmbedComposer {...props} heading={false} /> : null}
        </Modal>
      </BodyPortal>
    </>
  )
}
