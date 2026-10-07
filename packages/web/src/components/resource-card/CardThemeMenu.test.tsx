// @vitest-environment happy-dom
import { createRef } from 'react'
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { DESK_THEMES } from '../../lib/deskThemes'
import { renderWithRouter } from '../../test/render'
import { CardThemeMenu } from './CardThemeMenu'

describe('CardThemeMenu', () => {
  it('renders radio choices, contains pointer events, and reports the selected theme', () => {
    const pick = vi.fn()
    const pointer = vi.fn()
    const context = vi.fn()
    document.body.addEventListener('pointerdown', pointer)
    document.body.addEventListener('contextmenu', context)
    const ref = createRef<HTMLDivElement>()
    const view = renderWithRouter(<CardThemeMenu menuRef={ref} x={24} y={48}
      options={DESK_THEMES} activeTheme="paper" onPick={pick} />)

    const menu = document.querySelector<HTMLElement>('[role="menu"]')!
    expect(ref.current).toBe(menu)
    expect(menu.style.left).toBe('24px')
    expect(menu.style.top).toBe('48px')
    const choices = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
    expect(choices).toHaveLength(3)
    expect(choices[0]?.getAttribute('aria-checked')).toBe('true')
    act(() => choices[2]!.click())
    expect(pick).toHaveBeenCalledWith('mist')

    act(() => menu.dispatchEvent(new Event('pointerdown', { bubbles: true })))
    act(() => menu.dispatchEvent(new Event('contextmenu', { bubbles: true, cancelable: true })))
    expect(pointer).not.toHaveBeenCalled()
    expect(context).not.toHaveBeenCalled()

    view.rerender(<CardThemeMenu menuRef={ref} x={24} y={48}
      options={DESK_THEMES} activeTheme="mist" onPick={pick} closing />)
    expect(menu.classList.contains('is-closing')).toBe(true)
    expect(menu.hasAttribute('inert')).toBe(true)
    document.body.removeEventListener('pointerdown', pointer)
    document.body.removeEventListener('contextmenu', context)
  })
})
