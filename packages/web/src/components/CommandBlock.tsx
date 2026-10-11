import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { copyTextToClipboard } from '../lib/clipboard'
import { Icon } from './Icon'

/** Longer tokens (URLs, JSON) may break anywhere rather than overflow. */
const KEEP_WHOLE_MAX = 32

/**
 * Lines wrap only between words: `colp-server` must not break at its
 * hyphen. Each short token is a nowrap span; the text itself is unchanged,
 * so a manual selection copies exactly what is shown.
 */
function commandLines(command: string): ReactNode {
  return command.split('\n').map((line, index) => (
    <Fragment key={index}>
      {index > 0 && '\n'}
      {line.split(/( +)/u).map((part, at) => (
        part.trim() === '' || part.length > KEEP_WHOLE_MAX
          ? part
          : <span key={at} className="command-block-word">{part}</span>
      ))}
    </Fragment>
  ))
}

type Props = {
  /** Names the copy button for assistive tech ("Copy {label}"). */
  label: string
  command: string
  className?: string
}

/**
 * A shell command the reader runs somewhere else. The command sits in a
 * terminal-style block with the Copy control in its corner, so the button
 * belongs to the code it copies. Copying goes through lib/clipboard so it
 * also works on the plain-HTTP origins this server supports.
 */
export function CommandBlock({ label, command, className }: Props) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')

  useEffect(() => {
    if (state === 'idle') return
    const timer = window.setTimeout(() => setState('idle'), 2_000)
    return () => window.clearTimeout(timer)
  }, [state])

  async function copy() {
    try {
      await copyTextToClipboard(command)
      setState('copied')
    } catch {
      setState('failed')
    }
  }

  return (
    <div className={['command-block', className ?? ''].filter(Boolean).join(' ')} data-testid="command-block">
      <pre className="command-block-code"><code>{commandLines(command)}</code></pre>
      <button
        type="button"
        className="command-block-copy"
        aria-label={`Copy ${label}`}
        data-state={state}
        onClick={() => void copy()}
      >
        <Icon name={state === 'copied' ? 'check' : 'copy'} />
        <span aria-live="polite">{state === 'copied' ? 'Copied' : state === 'failed' ? 'Select and copy' : 'Copy'}</span>
      </button>
    </div>
  )
}
