// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CollectionExportMenu, filenameFromContentDisposition } from './CollectionExportMenu'
import { cleanup, mountTree } from '../test/render'

describe('collection export menu', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })
  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  it('offers HTML and JSON and downloads the chosen format', async () => {
    const download = vi.fn(async () => undefined)
    mountTree(<CollectionExportMenu collectionId="col-1" slug="reading" download={download} />)
    const opener = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Export')
    expect(opener).toBeDefined()
    await act(async () => {
      opener?.click()
    })
    const html = [...document.querySelectorAll('[role="menuitem"]')].find((button) => button.textContent === 'HTML')
    const json = [...document.querySelectorAll('[role="menuitem"]')].find((button) => button.textContent === 'JSON')
    expect(html).toBeDefined()
    expect(json).toBeDefined()
    await act(async () => {
      html?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(download).toHaveBeenCalledWith('col-1', 'reading', 'html')
    await act(async () => {
      json?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(download).toHaveBeenCalledWith('col-1', 'reading', 'json')
  })

  it('reads a quoted content-disposition filename and falls back otherwise', () => {
    expect(filenameFromContentDisposition('attachment; filename="reading.html"', 'x.html')).toBe('reading.html')
    expect(filenameFromContentDisposition(null, 'reading.json')).toBe('reading.json')
  })
})
