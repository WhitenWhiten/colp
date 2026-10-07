// @vitest-environment happy-dom
import { act, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FilterRail } from './FilterRail'
import { cleanup, mountTree } from '../test/render'

describe('FilterRail', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })
  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  it('exposes exclusive options as radios instead of independent toggles', () => {
    function Probe() {
      const [selected, setSelected] = useState('all')
      return (
        <FilterRail
          label="Result type"
          value={selected}
          options={[
            { value: 'all', label: 'All' },
            { value: 'collection', label: 'Collections' },
          ]}
          onChange={setSelected}
        />
      )
    }
    mountTree(<Probe />)
    const group = document.querySelector('[role="radiogroup"]')
    const radios = () => [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    expect(group?.getAttribute('aria-label')).toBe('Result type')
    expect(radios().map((button) => button.textContent)).toEqual(['All', 'Collections'])
    expect(radios()[0]?.getAttribute('aria-checked')).toBe('true')
    expect(radios()[1]?.getAttribute('aria-checked')).toBe('false')
    expect(radios()[0]?.getAttribute('aria-pressed')).toBeNull()
    act(() => radios()[1]!.click())
    expect(radios()[1]?.getAttribute('aria-checked')).toBe('true')
    expect(radios()[0]?.getAttribute('aria-checked')).toBe('false')
  })

  it('runs the APG radiogroup contract: arrows select with focus, roving tabindex', () => {
    function Probe() {
      const [selected, setSelected] = useState('all')
      return (
        <FilterRail
          label="Result type"
          value={selected}
          options={[
            { value: 'all', label: 'All' },
            { value: 'collection', label: 'Collections' },
            { value: 'bookmark', label: 'Bookmarks' },
          ]}
          onChange={setSelected}
        />
      )
    }
    mountTree(<Probe />)
    const radios = () => [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    // Keys land on the focused radio (APG composite pattern), like the desk
    // menus drive document.activeElement.
    const key = (k: string) =>
      act(() => (document.activeElement ?? radios()[0]!).dispatchEvent(
        new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }),
      ))

    // Roving tabindex: the checked radio is the only Tab stop.
    expect(radios().map((r) => r.tabIndex)).toEqual([0, -1, -1])

    // Tab reaches the checked option; arrows roam from there.
    act(() => radios()[0]!.focus())
    key('ArrowRight')
    expect(document.activeElement).toBe(radios()[1])
    expect(radios()[1]?.getAttribute('aria-checked')).toBe('true')
    expect(radios().map((r) => r.tabIndex)).toEqual([-1, 0, -1])

    // Wrap-around on ArrowRight from the last option.
    key('ArrowRight')
    key('ArrowRight')
    expect(document.activeElement).toBe(radios()[0])
    expect(radios()[0]?.getAttribute('aria-checked')).toBe('true')

    // ArrowUp from the first option wraps to the last.
    key('ArrowUp')
    expect(document.activeElement).toBe(radios()[2])
    expect(radios()[2]?.getAttribute('aria-checked')).toBe('true')

    key('Home')
    expect(document.activeElement).toBe(radios()[0])
    key('End')
    expect(document.activeElement).toBe(radios()[2])
    expect(radios()[2]?.getAttribute('aria-checked')).toBe('true')
  })

  it('moves focus without selecting when selection is manual, then selects on click', () => {
    const changes: string[] = []
    function Probe() {
      const [selected, setSelected] = useState('editor')
      return (
        <FilterRail
          label="Role"
          selection="manual"
          value={selected}
          options={[
            { value: 'editor', label: 'Editor' },
            { value: 'viewer', label: 'Viewer' },
          ]}
          onChange={(next) => {
            changes.push(next)
            setSelected(next)
          }}
        />
      )
    }
    mountTree(<Probe />)
    const radios = () => [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    const key = (k: string) =>
      act(() => (document.activeElement ?? radios()[0]!).dispatchEvent(
        new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }),
      ))

    act(() => radios()[0]!.focus())
    key('ArrowRight')
    expect(changes).toEqual([])
    expect(document.activeElement).toBe(radios()[1])
    expect(radios()[0]?.getAttribute('aria-checked')).toBe('true')

    // happy-dom does not activate a <button> from Enter; click is that activation.
    key('Enter')
    expect(changes).toEqual([])
    act(() => (document.activeElement as HTMLButtonElement).click())
    expect(changes).toEqual(['viewer'])
    expect(radios()[1]?.getAttribute('aria-checked')).toBe('true')
  })

  it('selects on ArrowRight when selection is left at the default', () => {
    const changes: string[] = []
    function Probe() {
      const [selected, setSelected] = useState('all')
      return (
        <FilterRail
          label="Result type"
          value={selected}
          options={[
            { value: 'all', label: 'All' },
            { value: 'collection', label: 'Collections' },
          ]}
          onChange={(next) => {
            changes.push(next)
            setSelected(next)
          }}
        />
      )
    }
    mountTree(<Probe />)
    const radios = () => [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    act(() => radios()[0]!.focus())
    act(() => radios()[0]!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
    ))
    expect(changes).toEqual(['collection'])
    expect(document.activeElement).toBe(radios()[1])
    expect(radios()[1]?.getAttribute('aria-checked')).toBe('true')
  })

  it('skips a disabled option in the middle when roaming with arrows', () => {
    const changes: string[] = []
    function Probe() {
      const [selected, setSelected] = useState('a')
      return (
        <FilterRail
          label="Result type"
          value={selected}
          options={[
            { value: 'a', label: 'A' },
            { value: 'b', label: 'B', disabled: true },
            { value: 'c', label: 'C' },
          ]}
          onChange={(next) => {
            changes.push(next)
            setSelected(next)
          }}
        />
      )
    }
    mountTree(<Probe />)
    const radios = () => [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    act(() => radios()[0]!.focus())
    act(() => radios()[0]!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
    ))
    expect(changes).toEqual(['c'])
    expect(document.activeElement).toBe(radios()[2])
    expect(radios()[2]?.getAttribute('aria-checked')).toBe('true')
  })
})
