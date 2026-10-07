// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Resource } from '../../types/catalog'

const background = vi.hoisted(() => ({
  load: vi.fn(() => ({ kind: 'color' as const, colorId: 'paper', fit: 'cover' as const,
    finish: 'clear' as const, imageName: '', imageVersion: 0 })),
  persist: vi.fn(),
  read: vi.fn(async () => new Blob()),
  write: vi.fn(async () => undefined),
  remove: vi.fn(async () => undefined),
}))

vi.mock('../../lib/canvasBackground', () => ({
  loadCanvasBackground: background.load,
  persistCanvasBackground: background.persist,
  readCanvasBackgroundImage: background.read,
  writeCanvasBackgroundImage: background.write,
  deleteCanvasBackgroundImage: background.remove,
}))

import {
  canvasBackgroundStorageKey,
  canvasSizeStorageKey,
  clearCanvasStorage,
  deleteBoardBackgroundImage,
  loadBoardBackground,
  loadCanvasSize,
  loadLayouts,
  persistBoardBackground,
  persistCanvasSize,
  persistLayouts,
  readBoardBackgroundImage,
  snapCanvasSize,
  writeBoardBackgroundImage,
} from './persistence'

const resource: Resource = {
  id: 'search-card', type: 'search', title: 'Search', url: '', summary: '', host: '',
  layout: { x: 0, y: 0, w: 240, h: 100, z: 9 },
}

describe('canvas persistence', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
  })

  it('loads only known cards, snaps hostile geometry, and normalizes stack order', () => {
    localStorage.setItem('layout', JSON.stringify([
      { id: 'search-card', x: 13, y: -9, w: 101, h: 41, z: 99, locked: true },
      { id: 'unknown', x: 0, y: 0, w: 1, h: 1, z: 1 },
    ]))
    expect(loadLayouts('layout', [resource])).toEqual({
      'search-card': { x: 20, y: 0, w: 220, h: 80, z: 1, locked: true },
    })

    localStorage.setItem('layout', '{')
    expect(loadLayouts('layout', [resource])['search-card']).toMatchObject({ z: 1, locked: false })
  })

  it('round-trips layouts and clamps canvas sizes to the supported grid', () => {
    const map = { card: { x: 20, y: 40, w: 280, h: 220, z: 3, locked: true } }
    persistLayouts('layout', map)
    expect(JSON.parse(localStorage.getItem('layout') ?? '[]')).toEqual([
      { id: 'card', x: 20, y: 40, w: 280, h: 220, z: 3, locked: true },
    ])
    expect(snapCanvasSize({ width: 639, height: 4010 })).toEqual({ width: 640, height: 4000 })
    expect(loadCanvasSize('missing', { width: 961, height: 719 })).toEqual({ width: 960, height: 720 })
    localStorage.setItem('size', JSON.stringify({ width: 1011, height: 777 }))
    expect(loadCanvasSize('size', { width: 640, height: 480 })).toEqual({ width: 1020, height: 780 })
    localStorage.setItem('size', JSON.stringify({ width: 'wide', height: null }))
    expect(loadCanvasSize('size', { width: 800, height: 600 })).toEqual({ width: 800, height: 600 })

    persistCanvasSize('size', { width: 1200, height: 900 })
    clearCanvasStorage('layout', 'size')
    expect(localStorage.getItem('layout')).toBeNull()
    expect(localStorage.getItem('size')).toBeNull()
  })

  it('binds background storage and image operations to the board namespace', async () => {
    expect(canvasSizeStorageKey('board')).toBe('board:canvas-size')
    expect(canvasBackgroundStorageKey('board')).toBe('board:canvas-background')
    expect(loadBoardBackground('board')).toEqual({ kind: 'color', colorId: 'paper', fit: 'cover',
      finish: 'clear', imageName: '', imageVersion: 0 })
    expect(background.load).toHaveBeenCalledWith('board:canvas-background')
    const settings = { kind: 'color' as const, colorId: 'ink', fit: 'contain' as const,
      finish: 'deep' as const, imageName: '', imageVersion: 0 }
    persistBoardBackground('board', settings)
    expect(background.persist).toHaveBeenCalledWith('board:canvas-background', settings)
    const image = new Blob(['image'])
    await writeBoardBackgroundImage('board', image)
    await readBoardBackgroundImage('board')
    await deleteBoardBackgroundImage('board')
    expect(background.write).toHaveBeenCalledWith('board:canvas-background', image)
    expect(background.read).toHaveBeenCalledWith('board:canvas-background')
    expect(background.remove).toHaveBeenCalledWith('board:canvas-background')
  })
})
