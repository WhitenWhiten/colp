// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CommandBlock } from './CommandBlock'
import { cleanup, mountTree } from '../test/render'

const clipboard = vi.hoisted(() => ({ copyTextToClipboard: vi.fn<(value: string) => Promise<void>>() }))
vi.mock('../lib/clipboard', () => clipboard)

describe('CommandBlock', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    clipboard.copyTextToClipboard.mockReset().mockResolvedValue(undefined)
  })
  afterEach(() => cleanup())

  const command = 'claude mcp add --transport http colp "http://127.0.0.1:8090/collections/-/mcp-compat"\nclaude mcp login colp'

  it('shows the command text unchanged, wrapping only between words and after slashes', () => {
    mountTree(<CommandBlock label="Claude Code commands" command={command} />)
    const code = document.querySelector('[data-testid="command-block"] code')!
    expect(code.textContent).toBe(command)
    const words = [...code.querySelectorAll('span')].map((span) => span.textContent)
    expect(words).toContain('colp')
    expect(words).toContain('mcp-compat"')
    expect(words).toContain('"http://')
    expect(code.querySelectorAll('wbr').length).toBe(4)
  })

  it('lets a long unbroken secret break anywhere instead of overflowing', () => {
    const secret = `kn_c_${'a'.repeat(60)}`
    mountTree(<CommandBlock label="API key" command={secret} />)
    const code = document.querySelector('[data-testid="command-block"] code')!
    expect(code.textContent).toBe(secret)
    expect(code.querySelector('span')).toBeNull()
  })

  it('copies the exact command and confirms it', async () => {
    mountTree(<CommandBlock label="Claude Code commands" command={command} />)
    const button = document.querySelector<HTMLButtonElement>('button[aria-label="Copy Claude Code commands"]')!
    await act(async () => {
      button.click()
    })
    expect(clipboard.copyTextToClipboard).toHaveBeenCalledWith(command)
    expect(button.textContent).toContain('Copied')
    expect(button.getAttribute('data-state')).toBe('copied')
  })
})
