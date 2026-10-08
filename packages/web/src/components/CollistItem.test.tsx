// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Resource } from '../types/catalog'
import { CollistItem } from './CollistItem'
import { cleanup, mountTree } from '../test/render'

const item: Resource = {
  id: 'path',
  type: 'path',
  title: 'Suggested reading path',
  url: 'https://example.com/path',
  summary: 'Start here.',
  host: 'example.com',
  layout: { x: 0, y: 0, w: 300, h: 200, z: 1 },
}

describe('CollistItem notes panel', () => {

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  it('anchors the notes dialog to the Notes button', () => {
    mountTree(<CollistItem item={item} mode="compact" />)
    const notes = document.querySelector<HTMLButtonElement>('button[aria-label="Open notes for Suggested reading path"]')!
    notes.getBoundingClientRect = () =>
      ({
        x: 240,
        y: 120,
        width: 56,
        height: 24,
        top: 120,
        left: 240,
        right: 296,
        bottom: 144,
        toJSON() {
          return this
        },
      }) as DOMRect
    act(() => notes.click())
    const panel = document.querySelector<HTMLElement>('[role="dialog"]')
    expect(panel).not.toBeNull()
    expect(panel?.getAttribute('role')).toBe('dialog')
    const style = panel?.getAttribute('style') ?? ''
    expect(style).toContain('position: fixed')
    expect(style).toContain('max-height')
  })

  it('renders stored markdown previews without headings or raw markers', () => {
    localStorage.setItem('known.resource.meta.v1', JSON.stringify({
      path: { note: '## Note\n\n**details**', tldr: '**summary**', tldrSource: 'user', noteFormat: 'markdown', tldrFormat: 'markdown' },
    }))
    mountTree(<CollistItem item={item} mode="compact" />)
    const notes = document.querySelector<HTMLButtonElement>('button[aria-label="Open notes for Suggested reading path"]')!
    act(() => notes.dispatchEvent(new Event('mouseover', { bubbles: true })))
    const preview = document.querySelector('[data-testid="collist-pop-preview"]')
    expect(preview).not.toBeNull()
    if (!preview) return
    expect(preview.querySelector('strong')).not.toBeNull()
    expect(preview.querySelector('h1,h2,h3,h4,h5,h6')).toBeNull()
    expect(preview.textContent).not.toContain('##')
  })
})
