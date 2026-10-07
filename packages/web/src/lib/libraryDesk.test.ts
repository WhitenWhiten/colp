import { describe, expect, it } from 'vitest'
import { collectionEditorRedirectPath, isLibraryDeskPath, isLibraryDeskToDesk, libraryDeskKey } from './libraryDesk'

describe('libraryDesk', () => {
  it('treats the collections desk as one page, including a selected collection', () => {
    expect(isLibraryDeskPath('/library')).toBe(true)
    expect(isLibraryDeskPath('/library/col-1')).toBe(true)
    expect(libraryDeskKey('/library/col-1')).toBe('/library')
    expect(isLibraryDeskToDesk('/library', '/library/col-2?folder=later')).toBe(true)
  })

  it('leaves create, health, and nested collection routes as other pages', () => {
    expect(isLibraryDeskPath('/library/new')).toBe(false)
    expect(isLibraryDeskPath('/library/health')).toBe(false)
    expect(isLibraryDeskPath('/library/col-1/edit')).toBe(false)
    expect(libraryDeskKey('/library/col-1/edit')).toBe('/library/col-1/edit')
    expect(isLibraryDeskToDesk('/library/col-1', '/library/col-1/edit')).toBe(false)
  })

  it('redirects the retired editor onto the desk sheet or node drawer', () => {
    expect(collectionEditorRedirectPath('col-1', null)).toBe('/library/col-1?collection=edit')
    expect(collectionEditorRedirectPath('col-1', 'node-2')).toBe('/library/col-1?node=node-2')
  })
})
