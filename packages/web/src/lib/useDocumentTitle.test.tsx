// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useDocumentTitle } from './useDocumentTitle'
import { cleanup, mountTree } from '../test/render'

function Probe({ title }: { title: string }) {
  useDocumentTitle(title)
  return null
}

describe('useDocumentTitle', () => {

  beforeEach(() => {
    document.title = 'Know-N'
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
  })

  it('sets `{title} — Know-N` and restores the previous title on unmount', () => {
    mountTree(<Probe title="Dashboard" />)
    expect(document.title).toBe('Dashboard — Know-N')
    cleanup()
    expect(document.title).toBe('Know-N')
  })

  it('updates when the title changes', () => {
    mountTree(<Probe title="Profile" />)
    expect(document.title).toBe('Profile — Know-N')
    mountTree(<Probe title="@mira" />)
    expect(document.title).toBe('@mira — Know-N')
  })
})
