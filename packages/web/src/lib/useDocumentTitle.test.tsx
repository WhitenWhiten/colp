// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useDocumentTitle } from './useDocumentTitle'
import { cleanup, mountTree } from '../test/render'

function Probe({ title }: { title: string }) {
  useDocumentTitle(title)
  return null
}

describe('useDocumentTitle', () => {

  beforeEach(() => {
    document.title = 'COLP Server'
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
  })

  it('sets `{title} — COLP Server` and restores the previous title on unmount', () => {
    mountTree(<Probe title="Library" />)
    expect(document.title).toBe('Library — COLP Server')
    cleanup()
    expect(document.title).toBe('COLP Server')
  })

  it('updates when the title changes', () => {
    mountTree(<Probe title="Agents" />)
    expect(document.title).toBe('Agents — COLP Server')
    mountTree(<Probe title="Write approvals" />)
    expect(document.title).toBe('Write approvals — COLP Server')
  })
})
