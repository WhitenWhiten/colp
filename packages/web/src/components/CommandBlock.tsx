import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { copyTextToClipboard } from '../lib/clipboard'
import { Icon } from './Icon'

/** Tokens up to this length never break inside. */
const KEEP_WHOLE_MAX = 32
/** A URL segment longer than this (a secret, a JSON blob) may break anywhere. */
const SEGMENT_MAX = 40

/**
 * A long token such as a URL breaks only after `/`, `?`, `&` or `,`: each
 * piece is a nowrap span and a <wbr> sits between them.
 */
function longToken(token: string, key: number): ReactNode {
  const pieces = token.split(/(?<=[/?&,])(?!\/)/u)
  if (pieces.some((piece) => piece.length > SEGMENT_MAX)) return token
  return (
    <Fragment key={key}>
      {pieces.map((piece, at) => (
        <Fragment key={at}>
          {at > 0 && <wbr />}
          <span className="command-block-word">{piece}</span>
        </Fragment>
      ))}
    </Fragment>
  )
}

/**
 * Lines wrap only between words: `colp-server` must not break at its
 * hyphen. Each short token is a nowrap span; the text itself is unchanged,
 * so a manual selection copies exactly what is shown.
 */
function commandLines(command: string): ReactNode {
  return command.split('\n').map((line, index) => (
    <Fragment key={index}>
      {index > 0 && '\n'}
      {line.split(/( +)/u).map((part, at) => {
        if (part.trim() === '') return part
        if (part.length > KEEP_WHOLE_MAX) return longToken(part, at)
        return <span key={at} className="command-block-word">{part}</span>
      })}
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
 * Copy control for a value the reader pastes somewhere else. Copying goes
 * through lib/clipboard so it also works on the plain-HTTP origins this
 * server supports; a failure asks for a manual copy instead of hiding.
 */
export function CopyButton({ label, text }: { label: string; text: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')

  useEffect(() => {
    if (state === 'idle') return
    const timer = window.setTimeout(() => setState('idle'), 2_000)
    return () => window.clearTimeout(timer)
  }, [state])

  async function copy() {
    try {
      await copyTextToClipboard(text)
      setState('copied')
    } catch {
      setState('failed')
    }
  }

  return (
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
  )
}

/**
 * A shell command the reader runs somewhere else. The command sits in a
 * terminal-style block with the Copy control in its corner, so the button
 * belongs to the code it copies.
 */
export function CommandBlock({ label, command, className }: Props) {
  return (
    <div className={['command-block', className ?? ''].filter(Boolean).join(' ')} data-testid="command-block">
      <pre className="command-block-code"><code>{commandLines(command)}</code></pre>
      <CopyButton label={label} text={command} />
    </div>
  )
}
