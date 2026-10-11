// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { collectLayeredRules, readStyle } from './layered-css.test-helper'

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
})
