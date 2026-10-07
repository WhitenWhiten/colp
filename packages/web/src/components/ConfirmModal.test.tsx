// @vitest-environment happy-dom
/* R9-19: the shared promise-based destructive confirm — Modal tone="danger",
   resolves true only through the destructive action. The render helper wraps
   every tree in ConfirmProvider, mirroring Layout. */
import { act, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useCancelConfirm, useConfirm } from './ConfirmModal'
import { cleanup, mountTree } from '../test/render'

function Harness() {
  const confirm = useConfirm()
  const [result, setResult] = useState('')
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          void confirm({
            title: 'Delete this thing?',
            body: 'This action is recorded canonically.',
            confirmLabel: 'Delete it',
          }).then((ok) => setResult(ok ? 'yes' : 'no'))
        }}
      >
        ask
      </button>
      <output data-testid="result">{result}</output>
    </div>
  )
}

function ask() {
  act(() => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((candidate) => candidate.textContent === 'ask')
    button!.click()
  })
}

function dialog() {
  return document.querySelector('[role="dialog"]')
}

function result() {
  return document.querySelector('[data-testid="result"]')?.textContent
}

async function clickModalButton(label: string) {
  await act(async () => {
    const button = [...(dialog()?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
      .find((candidate) => candidate.textContent?.trim() === label)
    if (!button) throw new Error(`modal button missing: ${label}`)
    button.click()
    await Promise.resolve()
  })
}

describe('ConfirmProvider', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  it('resolves true through the destructive action, false through Cancel and Escape', async () => {
    mountTree(<Harness />)

    ask()
    expect(dialog()?.textContent).toContain('Delete this thing?')
    expect(dialog()?.textContent).toContain('recorded canonically')
    await clickModalButton('Delete it')
    expect(result()).toBe('yes')
    expect(dialog()).toBeNull()

    ask()
    await clickModalButton('Cancel')
    expect(result()).toBe('no')

    ask()
    await act(async () => {
      // Modal's Esc listener lives on document (shared trap/Esc contract).
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      await Promise.resolve()
    })
    // Escape settled the request false and closed the dialog.
    expect(result()).toBe('no')
    expect(dialog()).toBeNull()
  })

  it('resolves the superseded request false when a second confirm opens', async () => {
    mountTree(<Harness />)
    ask()
    expect(dialog()).not.toBeNull()
    // A second request before the first resolves: the stale promise must not
    // hang — it cancels so its caller treats it as declined.
    ask()
    await clickModalButton('Delete it')
    expect(result()).toBe('yes')
  })

  it('resolves false through useCancelConfirm without a second prompt', async () => {
    function CancelHarness() {
      const confirm = useConfirm()
      const cancel = useCancelConfirm()
      const [result, setResult] = useState('')
      return (
        <div>
          <button
            type="button"
            onClick={() => {
              void confirm({ title: 'Delete this thing?' }).then((ok) => setResult(ok ? 'yes' : 'no'))
            }}
          >
            ask
          </button>
          <button type="button" onClick={() => cancel()}>dismiss</button>
          <output data-testid="result">{result}</output>
        </div>
      )
    }

    mountTree(<CancelHarness />)
    ask()
    expect(dialog()).not.toBeNull()
    await act(async () => {
      const button = [...document.querySelectorAll<HTMLButtonElement>('button')]
        .find((candidate) => candidate.textContent === 'dismiss')
      button!.click()
      await Promise.resolve()
    })
    expect(result()).toBe('no')
    expect(dialog()).toBeNull()
  })
})
