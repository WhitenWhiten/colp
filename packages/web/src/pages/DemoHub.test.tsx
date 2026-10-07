// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DemoHub } from './DemoHub'
import { cleanup, mountTree } from '../test/render'

describe('DemoHub', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })
  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  /* Directory rows are the only links inside the labelled directory section. */
  function directoryRows(): Element[] {
    return [...document.querySelectorAll('[aria-label="Product demo directory"] a')]
  }

  function hrefFor(title: string): string | null {
    const row = directoryRows().find(
      (node) => node.querySelector('strong')?.textContent === title,
    )
    return row?.getAttribute('href') ?? null
  }

  it('inserts workflow group headings when the filter is All', () => {
    mountTree(<MemoryRouter><DemoHub /></MemoryRouter>)
    const headings = [...document.querySelectorAll('[aria-label="Product demo directory"] h2')]
      .map((node) => node.textContent)
    expect(headings).toEqual(['Capture', 'Organize', 'Publish', 'Follow', 'System'])
    const capture = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Capture')
    act(() => capture?.click())
    expect(document.querySelector('[aria-label="Product demo directory"] h2')).toBeNull()
  })

  it('points Hub entries at live product routes instead of seed slugs', () => {
    mountTree(<MemoryRouter><DemoHub /></MemoryRouter>)

    expect(hrefFor('Reading view')).toBe('/explore')
    expect(hrefFor('Collection editor')).toBe('/library')
    expect(hrefFor('Collaborators and permissions')).toBe('/library')
    expect(hrefFor('Collection version history')).toBe('/library')
    expect(hrefFor('Grounded collection chat')).toBe('/demo/ai/chat')
    expect(hrefFor('Share and embed')).toBe('/explore')
    expect(hrefFor('Permission roles')).toBe('/explore')
    expect(hrefFor('Guided reading path')).toBe('/explore')
    expect(hrefFor('Curator profile')).toBe('/explore')

    const walkthrough = [...document.querySelectorAll('[aria-label="Recommended walkthrough"] a')]
      .map((node) => node.getAttribute('href'))
    expect(walkthrough).toEqual(['/extension/popup', '/classify', '/explore'])

    expect(document.body.textContent).not.toContain('llm-learning-path')
    expect(document.body.textContent).not.toContain('seeded demo')
    const liveHrefs = [
      hrefFor('Collection editor'),
      hrefFor('Collection version history'),
      hrefFor('Collaborators and permissions'),
      hrefFor('Share and embed'),
      hrefFor('Guided reading path'),
      hrefFor('Permission roles'),
      hrefFor('Reading view'),
    ]
    for (const href of liveHrefs) {
      expect(href).not.toContain('llm-learning-path')
      expect(href).not.toContain('interface-systems')
      expect(href).not.toContain('/library/col-')
    }
    const historyRow = directoryRows().find(
      (node) => node.querySelector('strong')?.textContent === 'Collection version history',
    )
    /* The row body span follows the title <strong> inside the copy wrapper. */
    expect(historyRow?.querySelector('strong')?.nextElementSibling?.textContent).toBe(
      'Compare change sets and restore an earlier release.',
    )
    expect(historyRow?.textContent).not.toContain('as a new draft')
  })

  it('describes classify inbox without semantic or AI copy', () => {
    mountTree(<MemoryRouter><DemoHub /></MemoryRouter>)
    const row = directoryRows().find(
      (node) => node.querySelector('strong')?.textContent === 'Classify inbox',
    )
    expect(row).toBeTruthy()
    expect(hrefFor('Classify inbox')).toBe('/classify')
    expect(row?.querySelector('strong')?.nextElementSibling?.textContent).not.toMatch(/semantic|\bAI\b/i)
  })

  it('describes library JSON export without demo-only copy', () => {
    mountTree(<MemoryRouter><DemoHub /></MemoryRouter>)
    const row = directoryRows().find(
      (node) => node.querySelector('strong')?.textContent === 'Data export and migration',
    )
    expect(row).toBeTruthy()
    expect(row?.getAttribute('href')).toBe('/export')
    expect(row?.textContent).not.toContain('Demo only')
    expect(row?.textContent).not.toContain('No Product export API')
    expect(row?.textContent).not.toMatch(/Markdown/i)
    /* The meta span is the parent of the group <em>. */
    expect(row?.querySelector('em')?.parentElement?.textContent).toContain('JSON export')
    expect(row?.querySelector('strong')?.nextElementSibling?.textContent).toMatch(/owned live library/i)
  })
})
