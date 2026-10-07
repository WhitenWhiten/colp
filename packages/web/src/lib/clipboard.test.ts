// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyTextToClipboard } from './clipboard'

describe('copyTextToClipboard', () => {
  const writeText = vi.fn()
  const execCommand = vi.fn()

  beforeEach(() => {
    writeText.mockReset()
    execCommand.mockReset()
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses the Clipboard API in a secure context', async () => {
    writeText.mockResolvedValueOnce(undefined)
    await copyTextToClipboard('https://know-n.com/share/demo')
    expect(writeText).toHaveBeenCalledWith('https://know-n.com/share/demo')
    expect(execCommand).not.toHaveBeenCalled()
  })

  it('falls back to execCommand when writeText is rejected', async () => {
    writeText.mockRejectedValueOnce(new Error('Document is not focused'))
    execCommand.mockReturnValueOnce(true)
    await copyTextToClipboard('https://know-n.com/share/demo')
    expect(execCommand).toHaveBeenCalledWith('copy')
  })

  it('copies synchronously with execCommand outside a secure context', async () => {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false })
    execCommand.mockReturnValueOnce(true)
    await copyTextToClipboard('https://know-n.com/share/demo')
    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(writeText).not.toHaveBeenCalled()
  })

  it('throws when neither clipboard surface can copy', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'))
    execCommand.mockReturnValueOnce(false)
    await expect(copyTextToClipboard('https://know-n.com/share/demo')).rejects.toThrow('Clipboard unavailable')
  })
})
