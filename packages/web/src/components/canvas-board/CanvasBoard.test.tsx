// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Resource } from '../../types/catalog'
import { renderWithRouter } from '../../test/render'
import { CanvasBoard } from '../CanvasBoard'

const mocks = vi.hoisted(() => {
  const layout = { x: 0, y: 0, w: 280, h: 220, z: 1 }
  return {
    board: {
      markEditing: vi.fn(), markSaved: vi.fn(), showToast: vi.fn(), commitLayout: vi.fn(),
      persist: vi.fn(), applyBoardMetrics: vi.fn(), bringForward: vi.fn(), setSelected: vi.fn(),
      status: 'saved', canvasSize: { width: 1280, height: 900 }, widthInput: '1280', heightInput: '900',
      setWidthInput: vi.fn(), setHeightInput: vi.fn(), applyInputs: vi.fn(), fitToContent: vi.fn(),
      setCanvasSizeSafe: vi.fn(), reset: vi.fn(), shellOverflow: { start: true, end: true },
      shellRef: { current: null }, boardRef: { current: null }, canEditLayout: true,
      layouts: { card: layout }, layoutsRef: { current: { card: layout } }, selected: 'card',
      themes: { card: 'paper' }, toggleLock: vi.fn(), setThemeFor: vi.fn(),
      persistCanvasSize: vi.fn(), canvasSizeRef: { current: { width: 1280, height: 900 } },
      toastMounted: true, toastClosing: false, toast: 'Saved', lastToastRef: { current: 'Saved' },
    },
    background: {
      backgroundPanelOpen: true, setBackgroundPanelOpen: vi.fn(), backgroundPanelMounted: true,
      backgroundPanelClosing: false, backgroundInputId: 'background-input',
      background: { kind: 'image', color: '#fff', fit: 'cover' }, backgroundBusy: false,
      updateCanvasBackground: vi.fn(), uploadCanvasBackground: vi.fn(async () => undefined),
      removeCanvasBackgroundImage: vi.fn(async () => undefined), backgroundImageUrl: 'blob:fixture',
      canvasBackgroundStyle: { '--canvas-background': '#fff' },
    },
    pointer: {
      activeUi: { id: 'card', type: 'move' }, activeRef: { current: null },
      canvasResizeRef: { current: null }, cleanupRef: { current: null }, cancel: vi.fn(),
      beginInteraction: vi.fn(), endInteraction: vi.fn(), moveWithKeyboard: vi.fn(),
      resizeWithKeyboard: vi.fn(),
    },
    beginCanvasResize: vi.fn(),
    removeResource: vi.fn(),
  }
})

vi.mock('./useCanvasBoard', () => ({ useCanvasBoard: () => mocks.board }))
vi.mock('./useCanvasBackground', () => ({ useCanvasBackground: () => mocks.background }))
vi.mock('./interaction', () => ({
  useCanvasPointer: () => mocks.pointer,
  useCanvasResize: () => ({ beginCanvasResize: mocks.beginCanvasResize }),
}))
vi.mock('../Icon', () => ({ Icon: () => <span aria-hidden>icon</span> }))
vi.mock('../SourceCard', () => ({
  SourceCard: (props: {
    resource: Resource
    onSelect?: () => void
    onToggleLock?: () => void
    onRemove?: () => void
    onThemeChange?: (theme: string) => void
    onMoveStart?: (event: never) => void
    onResizeStart?: (event: never) => void
    onMoveKey?: (event: never) => void
    onResizeKey?: (event: never) => void
  }) => <div role="listitem" data-testid={`card-${props.resource.id}`}>
    <button onClick={props.onSelect}>select</button>
    <button onClick={props.onToggleLock}>lock</button>
    <button onClick={props.onRemove}>remove</button>
    <button onClick={() => props.onThemeChange?.('mist')}>theme</button>
    <button onClick={() => props.onMoveStart?.({} as never)}>move pointer</button>
    <button onClick={() => props.onResizeStart?.({} as never)}>resize pointer</button>
    <button onClick={() => props.onMoveKey?.({} as never)}>move key</button>
    <button onClick={() => props.onResizeKey?.({} as never)}>resize key</button>
  </div>,
}))
vi.mock('./CanvasToolbar', () => ({
  CanvasToolbar: (props: {
    onWidthInput: (value: string) => void
    onHeightInput: (value: string) => void
    onApplyInputs: () => void
    onFitToContent: () => void
    onSetCanvasSize: (size: { width: number; height: number }) => void
    onReset: () => void
    onToggleBackgroundPanel: () => void
    onCloseBackgroundPanel: () => void
    onUpdateBackground: (patch: { color: string }) => void
    onUploadBackground: (file: File) => void
    onRemoveBackgroundImage: () => void
  }) => <div data-testid="toolbar">
    <button onClick={() => props.onWidthInput('1440')}>width</button>
    <button onClick={() => props.onHeightInput('960')}>height</button>
    <button onClick={props.onApplyInputs}>apply</button>
    <button onClick={props.onFitToContent}>fit</button>
    <button onClick={() => props.onSetCanvasSize({ width: 960, height: 720 })}>preset</button>
    <button onClick={props.onReset}>reset</button>
    <button onClick={props.onToggleBackgroundPanel}>toggle background</button>
    <button onClick={props.onCloseBackgroundPanel}>close background</button>
    <button onClick={() => props.onUpdateBackground({ color: '#000' })}>color</button>
    <button onClick={() => props.onUploadBackground(new File(['x'], 'background.png'))}>upload</button>
    <button onClick={props.onRemoveBackgroundImage}>remove background</button>
  </div>,
}))

const resource: Resource = {
  id: 'card', type: 'search', title: 'Search', url: '', summary: '', host: '',
  layout: { x: 0, y: 0, w: 280, h: 220, z: 1 },
}

describe('CanvasBoard composition', () => {
  beforeEach(() => {
    for (const value of Object.values(mocks.board)) if (typeof value === 'function' && 'mockClear' in value) value.mockClear()
    for (const value of Object.values(mocks.background)) if (typeof value === 'function' && 'mockClear' in value) value.mockClear()
    for (const value of Object.values(mocks.pointer)) if (typeof value === 'function' && 'mockClear' in value) value.mockClear()
    mocks.beginCanvasResize.mockClear()
    mocks.removeResource.mockClear()
  })

  it('wires toolbar, card and resize interactions through the public CanvasBoard export', () => {
    renderWithRouter(<CanvasBoard resources={[resource]} storageKey="board" showEditChrome
      layoutEditable customCanvasSize backgroundCustomizable onRemoveResource={mocks.removeResource} />)

    expect(document.querySelector('[role="list"]')?.getAttribute('aria-label')).toContain('Editable dashboard canvas')
    expect(document.querySelector('[data-testid="card-card"]')).not.toBeNull()
    for (const button of document.querySelectorAll<HTMLButtonElement>('button')) act(() => button.click())
    act(() => document.querySelector<HTMLButtonElement>('[aria-label^="Resize canvas"]')
      ?.dispatchEvent(new Event('pointerdown', { bubbles: true })))

    expect(mocks.board.setWidthInput).toHaveBeenCalledWith('1440')
    expect(mocks.board.setHeightInput).toHaveBeenCalledWith('960')
    expect(mocks.board.applyInputs).toHaveBeenCalled()
    expect(mocks.board.fitToContent).toHaveBeenCalled()
    expect(mocks.board.setCanvasSizeSafe).toHaveBeenCalledWith({ width: 960, height: 720 })
    expect(mocks.board.reset).toHaveBeenCalled()
    expect(mocks.background.setBackgroundPanelOpen).toHaveBeenCalledWith(expect.any(Function))
    expect(mocks.background.setBackgroundPanelOpen).toHaveBeenCalledWith(false)
    expect(mocks.background.updateCanvasBackground).toHaveBeenCalledWith({ color: '#000' })
    expect(mocks.background.uploadCanvasBackground).toHaveBeenCalledWith(expect.any(File))
    expect(mocks.background.removeCanvasBackgroundImage).toHaveBeenCalled()
    expect(mocks.board.setSelected).toHaveBeenCalledWith('card')
    expect(mocks.board.toggleLock).toHaveBeenCalledWith('card')
    expect(mocks.removeResource).toHaveBeenCalledWith('card')
    expect(mocks.board.setThemeFor).toHaveBeenCalledWith('card', 'mist')
    expect(mocks.pointer.beginInteraction).toHaveBeenCalledTimes(2)
    expect(mocks.pointer.moveWithKeyboard).toHaveBeenCalledWith('card', {})
    expect(mocks.pointer.resizeWithKeyboard).toHaveBeenCalledWith('card', {})
    expect(mocks.beginCanvasResize).toHaveBeenCalled()
    expect(document.body.textContent).toContain('Scroll or drag to see more of the board')
    expect(document.body.textContent).toContain('Saved')
  })
})
