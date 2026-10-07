// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BookmarkNotePanel, type BookmarkNoteMeta } from './BookmarkNotePanel'
import { renderWithRouter, waitForDom } from '../test/render'

const mocks = vi.hoisted(() => ({ toast: vi.fn() }))
vi.mock('./AppToast', () => ({ useToast: () => ({ toast: mocks.toast }) }))

function setText(control: HTMLTextAreaElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(control, value)
    control.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }))
  })
}

describe('BookmarkNotePanel', () => {
  const initial: BookmarkNoteMeta = { note: 'Initial note', tldr: '', tldrSource: 'empty' }

  beforeEach(() => { mocks.toast.mockReset() })

  it('persists edited note and TLDR drafts without bubbling panel clicks', () => {
    let stored = initial
    const persist = vi.fn((patch: Partial<BookmarkNoteMeta>) => {
      stored = { ...stored, ...patch }
      return stored
    })
    const parentClick = vi.fn()
    document.body.addEventListener('click', parentClick)
    renderWithRouter(<BookmarkNotePanel id="bookmark-1" meta={initial} onPersist={persist}
      onGenerate={async () => 'generated'} />)

    const note = document.getElementById('note-bookmark-1') as HTMLTextAreaElement
    const tldr = document.getElementById('tldr-bookmark-1') as HTMLTextAreaElement
    setText(note, '  Edited note  ')
    setText(tldr, '  Manual summary  ')
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('button')]
    act(() => buttons.find((button) => button.textContent === 'Save note')!.click())
    act(() => buttons.find((button) => button.textContent === 'Save TL;DR')!.click())
    expect(persist.mock.calls.map(([patch]) => patch)).toEqual([
      { note: 'Edited note' },
      { tldr: 'Manual summary', tldrSource: 'user' },
    ])
    expect(mocks.toast).toHaveBeenCalledWith('Note saved')
    expect(mocks.toast).toHaveBeenCalledWith('TL;DR saved')

    act(() => document.querySelector<HTMLElement>('[class~="lib-link-panel"]')!.click())
    expect(parentClick).not.toHaveBeenCalled()
    document.body.removeEventListener('click', parentClick)
  })

  it('shows generation progress, persists the AI result, and resets for another bookmark', async () => {
    let resolveGeneration: (value: string) => void = () => undefined
    const persist = vi.fn((patch: Partial<BookmarkNoteMeta>) => ({ ...initial, ...patch }))
    const view = renderWithRouter(
      <BookmarkNotePanel id="bookmark-1" meta={initial} onPersist={persist}
        onGenerate={() => new Promise((resolve) => { resolveGeneration = resolve })} />,
    )

    act(() => [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Generate TL;DR')!.click())
    expect(document.body.textContent).toContain('Generating…')
    expect(document.querySelector('[aria-live="polite"]')).not.toBeNull()
    await act(async () => {
      resolveGeneration('Generated summary')
      await Promise.resolve()
    })
    const tldr = document.getElementById('tldr-bookmark-1') as HTMLTextAreaElement
    expect(tldr.value).toBe('Generated summary')
    expect(tldr.classList.contains('is-ai')).toBe(true)
    expect(persist).toHaveBeenCalledWith({ tldr: 'Generated summary', tldrSource: 'ai' })

    view.rerender(<BookmarkNotePanel id="bookmark-2"
      meta={{ note: 'Other note', tldr: 'Other summary', tldrSource: 'user' }}
      onPersist={persist} onGenerate={async () => 'unused'} />)
    await waitForDom(() => (document.getElementById('note-bookmark-2') as HTMLTextAreaElement)?.value === 'Other note')
    expect((document.getElementById('tldr-bookmark-2') as HTMLTextAreaElement).value).toBe('Other summary')
  })
})
