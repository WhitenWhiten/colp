// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { BookmarkIcon } from './BookmarkIcon'
import { cleanup, mountTree } from '../test/render'

const SRC = `${window.location.origin}/api/v1/favicon/01234567-89ab-4cde-8f01-23456789abcd`

describe('BookmarkIcon', () => {
  afterEach(() => cleanup())

  it('paints an icon it already showed at once when its row remounts', () => {
    const icon = <BookmarkIcon icon={{ kind: 'object', src: SRC }} letter="E" />
    const first = mountTree(icon)
    const img = first.container.querySelector('img')!
    expect(img.getAttribute('loading')).toBe('lazy')
    expect(img.getAttribute('decoding')).toBe('async')
    act(() => { img.dispatchEvent(new Event('load')) })
    first.unmount()

    // A windowed list scrolled back: the row mounts a fresh <img>.
    const again = mountTree(icon).container.querySelector('img')!
    expect(again.getAttribute('loading')).toBe('eager')
    expect(again.getAttribute('decoding')).toBe('sync')
  })
})
