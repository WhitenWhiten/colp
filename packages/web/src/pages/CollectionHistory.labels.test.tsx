// @vitest-environment happy-dom
/* Version names: an unlabelled save comes back from the server as
   "Snapshot <UTC timestamp>"; the page names it by its local time instead. */
import { act } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CollectionHistory } from './CollectionHistory'
import { clearRouteCache } from '../lib/routeCache'
import { formatMediumInstant } from '../lib/formatDate'
import { cleanup, domFinishedLoading, mountTree, waitForDom } from '../test/render'
import { editorPage, version } from './CollectionHistory.test-helper'

const mocks = vi.hoisted(() => ({
  getCollectionEditorPage: vi.fn(),
  listCollectionVersions: vi.fn(),
  getCollectionVersion: vi.fn(),
}))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    isCollectionHistoryExposureEnabled: () => true,
    productClient: {
      ...actual.productClient,
      getCollectionEditorPage: mocks.getCollectionEditorPage,
      listCollectionVersions: mocks.listCollectionVersions,
      getCollectionVersion: mocks.getCollectionVersion,
    },
  }
})

vi.mock('../components/AppToast', () => ({
  useToast: () => ({ toast: vi.fn(), success: vi.fn(), error: vi.fn() }),
}))

const SAVED_AT = '2026-10-12T09:14:12.000Z'

describe('Collection history version names', () => {
  beforeEach(() => {
    clearRouteCache()
    const unlabelled = version({ label: 'Snapshot 2026-10-12T09:14:12Z', createdAt: SAVED_AT })
    mocks.getCollectionEditorPage.mockResolvedValue(editorPage('col-1'))
    mocks.listCollectionVersions.mockResolvedValue({
      items: [unlabelled, version({ versionId: 'ver-2', label: 'Before agent plan', kind: 'pre_mutation' })],
      nextCursor: null,
    })
    mocks.getCollectionVersion.mockResolvedValue(unlabelled)
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
    vi.clearAllMocks()
  })

  it('shows an unlabelled save as a snapshot at its local time, and keeps real labels', async () => {
    mountTree(
      <MemoryRouter initialEntries={['/library/col-1/history']}>
        <Routes><Route path="/library/:id/history" element={<CollectionHistory />} /></Routes>
      </MemoryRouter>,
    )
    // The selected version's name is the page's only h2.
    const detailHeading = () => document.querySelector('[data-testid="collection-history-page"] h2')
    await waitForDom(() => domFinishedLoading() && detailHeading() !== null)

    const rows = [...document.querySelectorAll('[data-testid="history-version-list"] button strong')]
      .map((node) => node.textContent)
    expect(rows).toEqual(['Snapshot', 'Before agent plan'])
    expect(detailHeading()?.textContent).toBe('Snapshot')
    expect(document.body.textContent).not.toContain('2026-10-12T09:14:12Z')

    const restore = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((node) => node.textContent?.trim() === 'Restore')
    act(() => restore!.click())
    await waitForDom(() => document.querySelector('[role="dialog"]') !== null)
    expect(document.querySelector('[role="dialog"]')?.textContent)
      .toContain(`Restore the snapshot from ${formatMediumInstant(SAVED_AT)}?`)
  })
})
