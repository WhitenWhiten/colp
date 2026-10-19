import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { copyTextToClipboard } from '../lib/clipboard'
import { CopyButton } from './CommandBlock'

type Props = {
  /** Visible label; also names the copy button for assistive tech. */
  label: string
  value: string
  /** Multi-line value (a command block) renders as a <pre>. */
  multiline?: boolean
  /** The label is read to assistive tech only; for values whose row already names them. */
  compact?: boolean
  className?: string
  onCopied?: () => void
  onCopyFailed?: () => void
}

/** An address wraps between its parts, after / ? & or ,; a part too long for
    the line still breaks anywhere (.command-block-code). The text itself is
    unchanged, so a manual selection copies exactly what is shown. */
function withBreaks(value: string): ReactNode {
  return value.split(/(?<=[/?&,])(?!\/)/u).map((piece, at) => (
    <Fragment key={at}>{at > 0 && <wbr />}{piece}</Fragment>
  ))
}

/**
 * A value the owner has to carry somewhere else: a server address, a share
 * link. Its label, then the value in the same sunken box a command sits in,
 * with the same Copy in its corner (CommandBlock), so copying looks one way
 * everywhere. Copying goes through lib/clipboard so it also works on the
 * plain-HTTP origins this edition supports (navigator.clipboard is absent
 * there).
 */
export function CopyField({ label, value, multiline = false, compact = false, className, onCopied, onCopyFailed }: Props) {
  if (compact) {
    return <CompactCopyField label={label} value={value} multiline={multiline} className={className}
      onCopied={onCopied} onCopyFailed={onCopyFailed} />
  }
  return (
    <div className={['copy-field', className ?? ''].filter(Boolean).join(' ')} data-testid="copy-field">
      <span className="copy-field-label">{label}</span>
      <div className="command-block">
        {multiline
          ? <pre className="command-block-code" data-testid="copy-field-value">{value}</pre>
          : <code className="command-block-code" data-testid="copy-field-value">{withBreaks(value)}</code>}
        <CopyButton label={label} text={value} onCopied={onCopied} onCopyFailed={onCopyFailed} />
      </div>
    </div>
  )
}

/** Compact: the row around it names the value, so the label is for
    assistive tech only and the value sits as a chip beside its button. */
function CompactCopyField({ label, value, multiline, className, onCopied, onCopyFailed }: Omit<Props, 'compact'>) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')

  useEffect(() => {
    if (state === 'idle') return
    const timer = window.setTimeout(() => setState('idle'), 2_000)
    return () => window.clearTimeout(timer)
  }, [state])

  async function copy() {
    try {
      await copyTextToClipboard(value)
      setState('copied'); onCopied?.()
    } catch {
      setState('failed'); onCopyFailed?.()
    }
  }

  const classes = ['copy-field', 'copy-field--compact', multiline ? 'copy-field--block' : '', className ?? '']
    .filter(Boolean).join(' ')
  return (
    <div className={classes} data-testid="copy-field">
      <span className="visually-hidden">{label}</span>
      {multiline
        ? <pre className="copy-field-value" data-testid="copy-field-value">{value}</pre>
        : <code className="copy-field-value" data-testid="copy-field-value">{value}</code>}
      <button
        type="button"
        className="btn btn-secondary btn-sm copy-field-button"
        aria-label={`Copy ${label}`}
        aria-live="polite"
        onClick={() => void copy()}
      >
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Select and copy' : 'Copy'}
      </button>
    </div>
  )
}
