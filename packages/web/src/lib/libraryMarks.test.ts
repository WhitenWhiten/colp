// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { loadMetaMap, setLinkMeta, applyLibrarySeedsOnce } from './libraryMarks'

describe('library annotation formats', () => {
  beforeEach(() => localStorage.clear())

  it('migrates legacy and invalid formats to plain and persists migration', () => {
    localStorage.setItem('known.library.meta.v1', JSON.stringify({
      old: { note: '**legacy**', tldr: 'summary', tldrSource: 'user' },
      bad: { note: 'x', tldr: 'y', tldrSource: 'ai', noteFormat: 'html', tldrFormat: 'weird' },
    }))
    const map = loadMetaMap()
    expect(map.old!.noteFormat).toBe('plain')
    expect(map.bad!.tldrFormat).toBe('plain')
    expect(JSON.parse(localStorage.getItem('known.library.meta.v1')!).bad.noteFormat).toBe('plain')
  })

  it('keeps tldr source separate from format and allows markdown edits', () => {
    const next = setLinkMeta('x', { tldr: '**takeaway**', tldrSource: 'user', tldrFormat: 'markdown' })
    expect(next).toMatchObject({ tldrSource: 'user', tldrFormat: 'markdown' })
  })

  it('applies format defaults at the store boundary', () => {
    const created = setLinkMeta('new', { note: 'new note', tldr: 'new tldr' })
    expect(created.noteFormat).toBe('markdown')
    expect(created.tldrFormat).toBe('markdown')
    const plain = setLinkMeta('plain', { note: 'legacy', noteFormat: 'plain' })
    expect(setLinkMeta('plain', { note: 'edited' }).noteFormat).toBe('plain')
    expect(setLinkMeta('plain', { note: '' }).noteFormat).toBe('plain')
    expect(plain.noteFormat).toBe('plain')
    expect(setLinkMeta('bad', { tldr: 'x', tldrFormat: 'html' as never }).tldrFormat).toBe('markdown')
    expect(setLinkMeta('bad-format-only', { noteFormat: 'html' as never, tldrFormat: 'bogus' as never })).toMatchObject({ noteFormat: 'plain', tldrFormat: 'plain' })
  })

  it('seeds demo annotations as plain text', () => {
    applyLibrarySeedsOnce([{ id: 'seed', note: '**note**', tldr: '*summary*' }])
    expect(loadMetaMap().seed!).toMatchObject({ noteFormat: 'plain', tldrFormat: 'plain' })
  })
})
