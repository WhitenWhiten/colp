// @vitest-environment happy-dom
import { act, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ThemeMap } from '../../lib/deskThemes'
import type { Resource } from '../../types/catalog'
import { cleanup, mountTree } from '../../test/render'
import type { CanvasBoardProps } from './CanvasBoard'
import { useCanvasBoard, type CanvasBoardThemeProps } from './useCanvasBoard'

const CARD: Resource = {
  id: 'card-1',
  title: 'Card',
  url: 'https://example.com',
  summary: '',
  host: 'example.com',
  type: 'article',
  layout: { x: 0, y: 0, w: 220, h: 160, z: 1 },
}

const STORAGE = 'known.test.canvas-board.themes'

type ExpectRejected<T> = T extends CanvasBoardProps ? never : true

/** Compile-time: `themeMap` alone is not a CanvasBoardProps. */
const _themeMapWithoutWriter: ExpectRejected<{
  resources: Resource[]
  storageKey: string
  themeMap: ThemeMap
}> = true

/** Compile-time: writer alone is not a CanvasBoardProps. */
const _writerWithoutThemeMap: ExpectRejected<{
  resources: Resource[]
  storageKey: string
  onThemeMapChange: (next: ThemeMap) => void
}> = true

const _uncontrolledOk: CanvasBoardProps = { resources: [], storageKey: STORAGE }
const _controlledOk: CanvasBoardProps = {
  resources: [],
  storageKey: STORAGE,
  themeMap: {},
  onThemeMapChange: () => {},
}

// @ts-expect-error themeMap requires onThemeMapChange
const _illegalThemeOnly: CanvasBoardProps = {
  resources: [],
  storageKey: STORAGE,
  themeMap: {},
}

void _themeMapWithoutWriter
void _writerWithoutThemeMap
void _uncontrolledOk
void _controlledOk
void _illegalThemeOnly

function ThemeProbe({
  storageKey,
  themeControl,
}: {
  storageKey: string
  themeControl?: CanvasBoardThemeProps
}) {
  const board = useCanvasBoard({
    resources: [CARD],
    storageKey,
    cancelInteraction: () => {},
    ...(themeControl ?? {}),
  })
  return (
    <>
      <span data-testid="theme">{board.themes[CARD.id] ?? ''}</span>
      <button type="button" data-testid="recolor" onClick={() => board.setThemeFor(CARD.id, 'ink')}>
        Recolor
      </button>
    </>
  )
}

function ControlledHost({ storageKey, initial }: { storageKey: string; initial: ThemeMap }) {
  const [themeMap, setThemeMap] = useState<ThemeMap>(initial)
  return <ThemeProbe storageKey={storageKey} themeControl={{ themeMap, onThemeMapChange: setThemeMap }} />
}

describe('useCanvasBoard setThemeFor', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    localStorage.removeItem(STORAGE)
    localStorage.removeItem(`${STORAGE}:themes`)
  })

  afterEach(() => {
    cleanup()
    localStorage.removeItem(STORAGE)
    localStorage.removeItem(`${STORAGE}:themes`)
    document.body.innerHTML = ''
  })

  it('rejects themeMap without onThemeMapChange at the type level', () => {
    expect(_themeMapWithoutWriter).toBe(true)
    expect(_writerWithoutThemeMap).toBe(true)
  })

  it('updates local state and persists when themes are uncontrolled', () => {
    mountTree(<ThemeProbe storageKey={STORAGE} />)
    expect(document.querySelector('[data-testid="theme"]')?.textContent).toBe('')
    act(() => {
      document.querySelector<HTMLButtonElement>('[data-testid="recolor"]')?.click()
    })
    expect(document.querySelector('[data-testid="theme"]')?.textContent).toBe('ink')
    expect(JSON.parse(localStorage.getItem(`${STORAGE}:themes`) ?? '{}')).toEqual({
      [CARD.id]: 'ink',
    })
  })

  it('writes through onThemeMapChange and skips persist when themes are controlled', () => {
    const onThemeMapChange = vi.fn()
    mountTree(
      <ThemeProbe
        storageKey={STORAGE}
        themeControl={{ themeMap: { [CARD.id]: 'paper' }, onThemeMapChange }}
      />,
    )
    expect(document.querySelector('[data-testid="theme"]')?.textContent).toBe('paper')
    act(() => {
      document.querySelector<HTMLButtonElement>('[data-testid="recolor"]')?.click()
    })
    expect(onThemeMapChange).toHaveBeenCalledTimes(1)
    expect(onThemeMapChange).toHaveBeenCalledWith({ [CARD.id]: 'ink' })
    expect(localStorage.getItem(`${STORAGE}:themes`)).toBeNull()
    expect(document.querySelector('[data-testid="theme"]')?.textContent).toBe('paper')
  })

  it('shows the parent map after a controlled writer updates state', () => {
    mountTree(<ControlledHost storageKey={STORAGE} initial={{ [CARD.id]: 'mist' }} />)
    expect(document.querySelector('[data-testid="theme"]')?.textContent).toBe('mist')
    act(() => {
      document.querySelector<HTMLButtonElement>('[data-testid="recolor"]')?.click()
    })
    expect(document.querySelector('[data-testid="theme"]')?.textContent).toBe('ink')
    expect(localStorage.getItem(`${STORAGE}:themes`)).toBeNull()
  })
})
