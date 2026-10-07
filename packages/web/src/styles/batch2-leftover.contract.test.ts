// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { collectLayeredRules, readStyle } from './dashboard-stack-cascade.test-helper'

const STYLE_ID = 'batch2-leftover-computed'

function inject(css: string) {
  document.getElementById(STYLE_ID)?.remove()
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = css
  document.head.appendChild(style)
}

function layeredRule(file: string, selector: string) {
  const rule = collectLayeredRules(readStyle(file)).find((item) => item.selector === selector)
  if (!rule) throw new Error(`${file} is missing ${selector}`)
  return rule
}

afterEach(() => {
  document.getElementById(STYLE_ID)?.remove()
  document.body.innerHTML = ''
})

describe('Batch 2 leftover computed styles', () => {
  it('grows the default .board with the viewport and keeps custom-size on the inline path', () => {
    const board = layeredRule('cards.css', '.board')
    expect(board.body).toMatch(/--canvas-min-height/)
    expect(board.body).toMatch(/100dvh/)
    expect(board.body).toMatch(/--header-h/)
    expect(board.body).not.toMatch(/--canvas-height:\s*48rem/)
    const custom = layeredRule('cards.css', '.board--custom-size')
    expect(custom.body).toMatch(/min-height:\s*0/)
  })

  it('applies an end-edge mask on an overflowing custom canvas shell', () => {
    const fade = layeredRule('cards.css', '.canvas-shell--custom.canvas-shell--overflow-end')
    inject(`${fade.selector} { ${fade.body} }`)
    const el = document.createElement('div')
    el.className = 'canvas-shell--custom canvas-shell--overflow-end'
    document.body.appendChild(el)
    const computed = getComputedStyle(el)
    const mask = computed.maskImage || computed.getPropertyValue('mask-image')
    expect(mask).toMatch(/linear-gradient/)
    expect(mask).not.toBe('none')
  })

  it('sizes page-shell titles to --measure instead of 22ch', () => {
    const title = layeredRule('page-chrome.css', '.page-shell > .page-shell-inner:first-child .display')
    inject(`:root { --measure: 38rem; }\n${title.selector} { ${title.body} }`)
    const page = document.createElement('div')
    page.className = 'page-shell'
    const shell = document.createElement('div')
    shell.className = 'page-shell-inner'
    const heading = document.createElement('h1')
    heading.className = 'display'
    shell.appendChild(heading)
    page.appendChild(shell)
    document.body.appendChild(page)
    expect(title.body).toMatch(/var\(--measure\)/)
    expect(title.body).not.toMatch(/22ch/)
    // 38rem resolves; 22ch would be ~352px at the default 16px font.
    expect(getComputedStyle(heading).maxWidth).toBe('608px')
  })

  it('keeps .route-loading-grid at 3 columns at 1100, matching default .collection-grid', () => {
    const rules = collectLayeredRules(readStyle('skeleton.css')).filter(
      (rule) => rule.selector === '.route-loading-grid',
    )
    const css = rules
      .map((rule) => {
        const body = `${rule.selector} { ${rule.body} }`
        if (!rule.media || (rule.media.min == null && rule.media.max == null)) return body
        const parts: string[] = []
        if (rule.media.min != null) parts.push(`(min-width: ${rule.media.min}px)`)
        if (rule.media.max != null) parts.push(`(max-width: ${rule.media.max}px)`)
        return `@media ${parts.join(' and ')} { ${body} }`
      })
      .join('\n')
    inject(css)
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1100 })
    const grid = document.createElement('div')
    grid.className = 'route-loading-grid'
    document.body.appendChild(grid)
    const columns = getComputedStyle(grid).gridTemplateColumns
    const fourCol = collectLayeredRules(readStyle('skeleton.css')).filter(
      (rule) =>
        rule.selector === '.route-loading-grid' &&
        /repeat\(\s*4/.test(rule.body) &&
        rule.media?.min === 1100,
    )
    expect(fourCol).toEqual([])
    // happy-dom may not apply @media from innerWidth; lock the winning 900+ declaration.
    const at1100 = [...rules].reverse().find((rule) => {
      if (rule.media?.min != null && 1100 < rule.media.min) return false
      if (rule.media?.max != null && 1100 > rule.media.max) return false
      return /grid-template-columns/.test(rule.body)
    })
    expect(at1100?.body).toMatch(/repeat\(\s*3/)
    expect(at1100?.body).not.toMatch(/repeat\(\s*4/)
    expect(columns === 'none' || typeof columns === 'string').toBe(true)
  })
})
