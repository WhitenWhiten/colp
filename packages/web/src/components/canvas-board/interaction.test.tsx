// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CardLayout } from '../../types/catalog'
import type { LayoutMap } from './geometry'
import { useCanvasPointer } from './interaction'
import { renderWithRouter } from '../../test/render'

function eventWith(values: Record<string, unknown>): Event {
  const event = new Event(String(values.type ?? 'pointermove'), { bubbles: true, cancelable: true })
  for (const [key, value] of Object.entries(values)) {
    if (key !== 'type') Object.defineProperty(event, key, { configurable: true, value })
  }
  return event
}

describe('canvas pointer and keyboard interaction', () => {
  afterEach(() => {
    document.body.classList.remove('is-manipulating')
    vi.restoreAllMocks()
  })

  function fixture(initial: CardLayout = { x: 0, y: 0, w: 280, h: 220, z: 1 }) {
    const layoutsRef = { current: { card: initial } as LayoutMap }
    const commitLayout = vi.fn((id: string, rect: CardLayout) => {
      layoutsRef.current = { ...layoutsRef.current, [id]: rect }
      return layoutsRef.current
    })
    const persist = vi.fn()
    const applyBoardMetrics = vi.fn()
    const bringForward = vi.fn((id: string) => layoutsRef.current[id])
    const markEditing = vi.fn()
    const showToast = vi.fn()
    const setSelected = vi.fn()
    let api!: ReturnType<typeof useCanvasPointer>
    function Harness() {
      api = useCanvasPointer({ layoutsRef, shellRef: { current: null }, commitLayout, persist,
        applyBoardMetrics, bringForward, markEditing, showToast, setSelected })
      return null
    }
    const view = renderWithRouter(<Harness />)
    return { api: () => api, layoutsRef, commitLayout, persist, applyBoardMetrics,
      bringForward, markEditing, showToast, setSelected, view }
  }

  it('moves and resizes unlocked cards from the keyboard and rejects locked cards', () => {
    const f = fixture()
    const preventDefault = vi.fn()
    act(() => f.api().moveWithKeyboard('card', {
      key: 'ArrowRight', shiftKey: false, preventDefault,
    } as never))
    expect(preventDefault).toHaveBeenCalled()
    expect(f.layoutsRef.current.card?.x).toBe(20)
    expect(f.persist).toHaveBeenLastCalledWith(f.layoutsRef.current)

    act(() => f.api().resizeWithKeyboard('card', {
      key: 'ArrowDown', shiftKey: true, preventDefault,
    } as never))
    expect(f.layoutsRef.current.card?.h).toBe(280)

    f.layoutsRef.current.card = { ...f.layoutsRef.current.card!, locked: true }
    const commits = f.commitLayout.mock.calls.length
    act(() => f.api().moveWithKeyboard('card', {
      key: 'ArrowLeft', shiftKey: false, preventDefault,
    } as never))
    expect(f.commitLayout).toHaveBeenCalledTimes(commits)
    expect(f.showToast).toHaveBeenLastCalledWith('Unlock to move or resize')
    expect(f.setSelected).toHaveBeenLastCalledWith('card')
  })

  it('commits pointer movement, persists on release, and restores on Escape', () => {
    const f = fixture()
    const target = {
      setPointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => true),
      releasePointerCapture: vi.fn(),
    }
    const begin = () => f.api().beginInteraction('move', 'card', {
      preventDefault: vi.fn(), stopPropagation: vi.fn(), currentTarget: target,
      pointerId: 7, clientX: 10, clientY: 20,
    } as never)

    act(begin)
    expect(document.body.classList.contains('is-manipulating')).toBe(true)
    expect(f.markEditing).toHaveBeenCalledTimes(1)
    act(() => window.dispatchEvent(eventWith({
      type: 'pointermove', pointerId: 7, pointerType: 'touch', clientX: 50, clientY: 70,
    })))
    expect(f.layoutsRef.current.card).toMatchObject({ x: 40, y: 50 })
    act(() => window.dispatchEvent(eventWith({ type: 'pointerup', pointerId: 7 })))
    expect(f.persist).toHaveBeenLastCalledWith(f.layoutsRef.current)
    expect(f.applyBoardMetrics).toHaveBeenLastCalledWith(f.layoutsRef.current)
    expect(f.showToast).toHaveBeenLastCalledWith('Position saved')

    const beforeCancel = { ...f.layoutsRef.current.card! }
    act(begin)
    act(() => window.dispatchEvent(eventWith({
      type: 'pointermove', pointerId: 7, pointerType: 'mouse', clientX: 90, clientY: 100,
    })))
    act(() => window.dispatchEvent(eventWith({ type: 'keydown', key: 'Escape' })))
    expect(f.commitLayout).toHaveBeenLastCalledWith('card', beforeCancel)
    expect(f.showToast).toHaveBeenLastCalledWith('Change cancelled')
    expect(document.body.classList.contains('is-manipulating')).toBe(false)
  })
})
