// @vitest-environment happy-dom
import { act, createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CatalogFields, type CatalogCommit } from './CatalogFields'
import { cleanup, mountTree, settled } from '../../test/render'

function setSelect(id: string, value: string) {
  const control = document.getElementById(id) as HTMLSelectElement
  act(() => {
    control.value = value
    control.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function saveButton() {
  return [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Save tags and language')
}

function setInput(id: string, value: string) {
  const control = document.getElementById(id) as HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) throw new Error('native value setter unavailable')
  act(() => {
    setter.call(control, value)
    control.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const mocks = vi.hoisted(() => ({
  getCollectionCatalog: vi.fn(),
  updateCollectionCatalog: vi.fn(),
}))

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>()
  return {
    ...actual,
    isLive: () => true,
    productClient: {
      ...actual.productClient,
      getCollectionCatalog: mocks.getCollectionCatalog,
      updateCollectionCatalog: mocks.updateCollectionCatalog,
      mutationIntentKey: actual.productClient.mutationIntentKey,
      newCommandId: actual.productClient.newCommandId,
    },
  }
})

vi.mock('../../components/AppToast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}))

describe('CatalogFields metadata editor', () => {
  afterEach(() => {
    cleanup()
    mocks.getCollectionCatalog.mockReset()
    mocks.updateCollectionCatalog.mockReset()
  })

  it('loads catalog metadata and PATCHes tags through the catalog endpoint', async () => {
    mocks.getCollectionCatalog.mockResolvedValue({ tags: ['design'], language: 'en', revision: 'rev-1' })
    mocks.updateCollectionCatalog.mockResolvedValue({ tags: ['systems'], language: 'en', revision: 'rev-2' })
    mountTree(<CatalogFields kind="collection" resourceId="col-1" />)
    await settled()
    // Tags are chips; the language is a select of known languages.
    expect([...document.querySelectorAll('[data-testid="tag-chip"]')].map((chip) => chip.textContent)).toEqual(['design'])
    expect((document.getElementById('collection-catalog-language') as HTMLSelectElement).value).toBe('en')
    expect(saveButton()?.disabled).toBe(true)
    setInput('collection-catalog-tags', 'systems')
    act(() => {
      const button = saveButton()
      if (!button) throw new Error('catalog save button missing')
      button.click()
    })
    await settled()
    expect(mocks.updateCollectionCatalog).toHaveBeenCalledWith(
      'col-1',
      { tags: ['design', 'systems'], language: 'en' },
      '"rev-1"',
      expect.objectContaining({ maxRetries: 0 }),
    )
  })

  it('folds into a host form: no own save button, commits only edited values', async () => {
    mocks.getCollectionCatalog.mockResolvedValue({ tags: ['design'], language: 'en', revision: 'rev-1' })
    mocks.updateCollectionCatalog.mockResolvedValue({ tags: ['design'], language: 'de', revision: 'rev-2' })
    const commit = createRef<CatalogCommit | null>() as { current: CatalogCommit | null }
    mountTree(<CatalogFields kind="collection" resourceId="col-1" commitRef={commit} />)
    await settled()
    expect(saveButton()).toBeUndefined()
    await act(async () => { expect(await commit.current?.()).toBe(true) })
    expect(mocks.updateCollectionCatalog).not.toHaveBeenCalled()
    setSelect('collection-catalog-language', 'de')
    await act(async () => { expect(await commit.current?.()).toBe(true) })
    expect(mocks.updateCollectionCatalog).toHaveBeenCalledWith(
      'col-1',
      { tags: ['design'], language: 'de' },
      '"rev-1"',
      expect.objectContaining({ maxRetries: 0 }),
    )
  })
})
