// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { getResourceMeta, setResourceMeta } from './resourceMarks'

describe('resource annotation format migration', () => {
  beforeEach(() => localStorage.clear())

  it('normalizes invalid formats to plain and persists the migration', () => {
    localStorage.setItem('known.resource.meta.v1', JSON.stringify({
      old: { note: '**n**', tldr: '*t*', tldrSource: 'user', noteFormat: 'html', tldrFormat: 'json' },
    }))
    expect(getResourceMeta('old')).toMatchObject({ noteFormat: 'plain', tldrFormat: 'plain' })
    expect(JSON.parse(localStorage.getItem('known.resource.meta.v1')!).old.noteFormat).toBe('plain')
  })

  it('keeps an existing plain format while new empty records default markdown', () => {
    setResourceMeta('plain', { note: 'legacy', noteFormat: 'plain' })
    setResourceMeta('plain', { note: 'edited' })
    expect(getResourceMeta('plain').noteFormat).toBe('plain')
    setResourceMeta('new', { note: 'fresh' })
    expect(getResourceMeta('new').noteFormat).toBe('markdown')
    expect(setResourceMeta('new', { noteFormat: 'html' as never }).noteFormat).toBe('markdown')
    expect(setResourceMeta('empty', { noteFormat: 'html' as never }).noteFormat).toBe('plain')
  })
})
