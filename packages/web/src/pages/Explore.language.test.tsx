// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearRouteCache } from '../lib/routeCache'
import { Explore } from './Explore'
import { cleanup, mountTree, settled } from '../test/render'

const mocks = vi.hoisted(() => ({
  getExploreCollections: vi.fn(),
  getPublicReportsPage: vi.fn(async (_query?: { language?: string }) => ({ items: [], nextCursor: null })),
  getCommunityRanking: vi.fn(async (_query?: { language?: string }) => ({
    items: [], nextCursor: null, scoreVersion: 'hot-v1', asOf: null,
  })),
}))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    getExploreCollections: mocks.getExploreCollections,
    productClient: {
      ...actual.productClient,
      getPublicReportsPage: mocks.getPublicReportsPage,
      getCommunityRanking: mocks.getCommunityRanking,
    },
    FEATURE_FLAGS: { ...actual.FEATURE_FLAGS, explore: true },
  }
})

const ENGLISH_ITEM = {
  id: 'col-en',
  title: 'English collection',
  summary: null,
  kind: 'collection',
  tags: [],
  nodeCount: 3,
  updatedAt: '2026-09-01T00:00:00.000Z',
  publicationSlug: 'english-collection',
  visibility: 'public',
  creators: [],
  viewCount: 0,
  language: 'en',
}

function pickSelect(testId: string, value: string) {
  const select = document.querySelector<HTMLSelectElement>(`[data-testid="${testId}"] select`)!
  act(() => {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function menuSelect(testId: string) {
  return document.querySelector<HTMLSelectElement>(`[data-testid="${testId}"] select`)!
}

async function pickLanguage(label: string) {
  const value = [...menuSelect('explore-language').options].find((o) => o.textContent?.trim() === label)!.value
  pickSelect('explore-language', value)
  await settled()
}

describe('Explore language filter community exposure', () => {
  beforeEach(() => {
    mocks.getExploreCollections.mockResolvedValue({ items: [ENGLISH_ITEM], nextCursor: null })
    mocks.getCommunityRanking.mockResolvedValue({
      items: [], nextCursor: null, scoreVersion: 'hot-v1', asOf: null,
    })
  })
  afterEach(() => {
    cleanup()
    clearRouteCache()
    mocks.getExploreCollections.mockReset()
    mocks.getCommunityRanking.mockReset()
    delete (window as { __KNOWN_FLAGS__?: unknown }).__KNOWN_FLAGS__
  })

  it('sends the language query to Explore', async () => {
    mountTree(
      <MemoryRouter>
        <Explore />
      </MemoryRouter>,
    )
    await settled()
    const menu = document.querySelector('[data-testid="explore-language"]')
    expect(menu).not.toBeNull()
    const optionLabels = [...menuSelect('explore-language').options].map((o) => o.textContent)
    expect(optionLabels[0]).toBe('Any language')
    expect(optionLabels).toContain('English')
    // No BCP-format guidance: options are the directory's own tags.
    expect(menu!.textContent).not.toMatch(/BCP/i)
    await pickLanguage('English')
    expect(mocks.getExploreCollections.mock.calls.some((call) => call[0]?.language === 'en')).toBe(true)
    expect(mocks.getPublicReportsPage.mock.calls.some((call) => call[0]?.language === 'en')).toBe(true)
  })

  it('hides the language filter when community exposure is off', async () => {
    window.__KNOWN_FLAGS__ = { community: false }
    mountTree(
      <MemoryRouter>
        <Explore />
      </MemoryRouter>,
    )
    await settled()
    expect(document.querySelector('[data-testid="explore-language"]')).toBeNull()
  })

  it('forwards language to the Hot ranking board', async () => {
    window.__KNOWN_FLAGS__ = { community: true }
    mountTree(
      <MemoryRouter>
        <Explore />
      </MemoryRouter>,
    )
    await settled()
    const hot = [...menuSelect('explore-sort').options].find((o) => o.textContent?.trim() === 'Hot')
    expect(hot).toBeTruthy()
    pickSelect('explore-sort', hot!.value)
    await settled()
    expect(document.querySelector('[data-testid="explore-language"]')).not.toBeNull()
    await pickLanguage('English')
    expect(mocks.getCommunityRanking.mock.calls.some((call) => call[0]?.language === 'en')).toBe(true)
  })
})
