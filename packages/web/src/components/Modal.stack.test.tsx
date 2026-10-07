// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Modal } from './Modal'
import { cleanup, mountTree } from '../test/render'

/**
 * D12 stacking: Esc and the focus trap apply only to the topmost open Modal.
 * happy-dom does not compute stacking — assert stack order, not z-index.
 */
describe('Modal stack', () => {
  let onBottomClose: ReturnType<typeof vi.fn>
  let onTopClose: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    onBottomClose = vi.fn()
    onTopClose = vi.fn()
    document.body.innerHTML = '<button id="trigger">Open</button><div id="root"></div>'
    document.getElementById('trigger')?.focus()
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  function renderStack(topOpen = true) {
    mountTree(
      <>
        <Modal open label="Settings" title="Settings" onClose={onBottomClose}>
          <button type="button">Save profile</button>
          <button type="button">Edit handle</button>
        </Modal>
        <Modal
          open={topOpen}
          label="Search Know-N"
          chrome="bare"
          overlayClassName="search-overlay"
          onClose={onTopClose}
        >
          <div className="search-palette">
            <button type="button">Top first</button>
            <button type="button">Top last</button>
          </div>
        </Modal>
      </>,
    )
  }

  it('closes only the topmost modal on Escape', () => {
    renderStack()
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(onTopClose).toHaveBeenCalledTimes(1)
    expect(onBottomClose).not.toHaveBeenCalled()
  })

  it('returns Escape to the remaining modal after the topmost closes', () => {
    renderStack()
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(onTopClose).toHaveBeenCalledTimes(1)
    renderStack(false)
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(onBottomClose).toHaveBeenCalledTimes(1)
    expect(onTopClose).toHaveBeenCalledTimes(1)
  })

  it('keeps Tab cycling inside the topmost panel', () => {
    renderStack()
    act(() => vi.runOnlyPendingTimers())
    const topDialog = document.querySelector('[aria-label="Search Know-N"]')!
    const topButtons = [...topDialog.querySelectorAll<HTMLButtonElement>('button')]
    const bottomButton = document.querySelector<HTMLButtonElement>('[data-testid="modal-body"] button')!
    const bottomClose = document.querySelector<HTMLButtonElement>('[aria-label="Close dialog"]')!
    expect(topButtons).toHaveLength(2)
    expect(document.activeElement).toBe(topButtons[0])

    topButtons[1]!.focus()
    act(() => topButtons[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })))
    expect(document.activeElement).toBe(topButtons[0])
    expect(document.activeElement).not.toBe(bottomButton)
    expect(document.activeElement).not.toBe(bottomClose)
  })
})
