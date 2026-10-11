import { useEffect, useState } from 'react'
import { copyTextToClipboard } from '../lib/clipboard'

type Props = {
  /** Visible label; also names the copy button for assistive tech. */
  label: string
  value: string
  /** Multi-line value (a command block) renders as a <pre>. */
  multiline?: boolean
  className?: string
}

/**
 * A value the owner has to carry somewhere else: a server address, an MCP
 * endpoint, a command. One row, the value in monospace, one Copy button.
 * Copying goes through lib/clipboard so it also works on the plain-HTTP
 * origins this edition supports (navigator.clipboard is absent there).
 */
export function CopyField({ label, value, multiline = false, className }: Props) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')

  useEffect(() => {
    if (state === 'idle') return
    const timer = window.setTimeout(() => setState('idle'), 2_000)
    return () => window.clearTimeout(timer)
  }, [state])

  async function copy() {
    try {
      await copyTextToClipboard(value)
      setState('copied')
    } catch {
      setState('failed')
    }
  }

  const classes = ['copy-field', multiline ? 'copy-field--block' : '', className ?? ''].filter(Boolean).join(' ')
  return (
    <div className={classes} data-testid="copy-field">
      <span className="copy-field-label">{label}</span>
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
