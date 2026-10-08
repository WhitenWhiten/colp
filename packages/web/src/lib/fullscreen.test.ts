// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { DESKTOP_DASHBOARD_MIN, getIsBrowserFullscreen } from './fullscreen'

describe('getIsBrowserFullscreen', () => {
  const original = {
    innerWidth: window.innerWidth,
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
    screenW: window.screen.width,
    screenH: window.screen.height,
    fullscreenDescriptor: Object.getOwnPropertyDescriptor(Document.prototype, 'fullscreenElement')
      ?? Object.getOwnPropertyDescriptor(document, 'fullscreenElement'),
  }

  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: original.innerWidth })
    Object.defineProperty(window, 'outerWidth', { configurable: true, value: original.outerWidth })
    Object.defineProperty(window, 'outerHeight', { configurable: true, value: original.outerHeight })
    Object.defineProperty(window.screen, 'width', { configurable: true, value: original.screenW })
    Object.defineProperty(window.screen, 'height', { configurable: true, value: original.screenH })
    if (original.fullscreenDescriptor) {
      Object.defineProperty(document, 'fullscreenElement', original.fullscreenDescriptor)
    } else {
      Object.defineProperty(document, 'fullscreenElement', {
        configurable: true,
        writable: true,
        value: null,
      })
    }
  })

  it('never treats a phone or tablet viewport as F11 fullscreen', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 768 })
    Object.defineProperty(window, 'outerWidth', { configurable: true, value: 768 })
    Object.defineProperty(window, 'outerHeight', { configurable: true, value: 1024 })
    Object.defineProperty(window.screen, 'width', { configurable: true, value: 768 })
    Object.defineProperty(window.screen, 'height', { configurable: true, value: 1024 })
    expect(768).toBeLessThan(DESKTOP_DASHBOARD_MIN)
    expect(getIsBrowserFullscreen()).toBe(false)
  })

  it('does not treat a maximized desktop window as fullscreen', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1600 })
    Object.defineProperty(window, 'outerWidth', { configurable: true, value: 1920 })
    Object.defineProperty(window, 'outerHeight', { configurable: true, value: 1080 })
    Object.defineProperty(window.screen, 'width', { configurable: true, value: 1920 })
    Object.defineProperty(window.screen, 'height', { configurable: true, value: 1080 })
    expect(getIsBrowserFullscreen()).toBe(false)
  })

  it('detects Fullscreen API via document.fullscreenElement', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1600 })
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => document.documentElement,
    })
    expect(getIsBrowserFullscreen()).toBe(true)
  })
})
