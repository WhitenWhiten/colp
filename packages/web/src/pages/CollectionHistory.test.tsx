// @vitest-environment happy-dom
/* Collection-history page boundary.
 *
 * Behaviour — the real page driven with the Product client mocked: the exposure
 * flag-off shell, the empty-state first save, auto-select of the newest version,
 * labels painted from the HTTP list, get-by-id on selection, save/restore
 * If-Match carrying the refreshed contentEtag, the restore block on removals,
 * the 404-means-unavailable copy, the non-404 error state, AbortError silence
 * and the published-slug link.
 *
 * Architecture — the page's module graph: it reaches the API through the public
 * barrel and carries no mock version list, no `mockOrLive` fallback and no
 * private-locator template. An unused deep import or a fallback in a branch no
 * test renders changes no observable behaviour, so those are asserted on module
 * specifiers and symbols. The exposure flag is a runtime value on the
 * production flag module.
 */
import { act } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FEATURE_FLAGS } from '../api/featureFlags'
import { ProductApiError, type CollectionVersion } from '../api'
import { CollectionHistory } from './CollectionHistory'
import collectionHistorySource from './CollectionHistory.tsx?raw'
import { clearRouteCache } from '../lib/routeCache'
import { cleanup, domFinishedLoading, mountTree, waitForDom } from '../test/render'
import { changeCounts, editorPage, version } from './CollectionHistory.test-helper'

const mocks = vi.hoisted(() => ({
  enabled: false,
  getOwnedCollectionsPage: vi.fn(),
  getCollectionEditorPage: vi.fn(),
  listCollectionVersions: vi.fn(),
  getCollectionVersion: vi.fn(),
  createCollectionVersion: vi.fn(),
  restoreCollectionVersion: vi.fn(),
  toast: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    isCollectionHistoryExposureEnabled: () => mocks.enabled,
    productClient: {
      ...actual.productClient,
      getOwnedCollectionsPage: mocks.getOwnedCollectionsPage,
      getCollectionEditorPage: mocks.getCollectionEditorPage,
      listCollectionVersions: mocks.listCollectionVersions,
      getCollectionVersion: mocks.getCollectionVersion,
      createCollectionVersion: mocks.createCollectionVersion,
      restoreCollectionVersion: mocks.restoreCollectionVersion,
    },
  }
})

vi.mock('../components/AppToast', () => ({
  useToast: () => ({ toast: mocks.toast, success: mocks.success, error: mocks.error }),
}))

/**
 * `useRouteData` passes its AbortController's signal on every editor-meta read,
 * so a StrictMode remount leaves the read it superseded aborted. The guarantee
 * is about the request, not the invocation: exactly `times` live reads, each
 * asking for the same editor meta.
 */
function expectEditorMetaRead(times = 1) {
  expect(mocks.getOwnedCollectionsPage).not.toHaveBeenCalled()
  const live = mocks.getCollectionEditorPage.mock.calls.filter((call) => {
    const options = call[2] as { signal?: AbortSignal } | undefined
    return options?.signal?.aborted !== true
  })
  expect(live).toHaveLength(times)
  for (const call of mocks.getCollectionEditorPage.mock.calls) {
    expect(call[0]).toBe('col-1')
    expect(call[1]).toEqual({ limit: 1 })
    expect(call[2]).toEqual(expect.objectContaining({ maxRetries: 0 }))
  }
}

function restoreButtons() {
  return [...document.querySelectorAll<HTMLButtonElement>('button')]
    .filter((node) => /restore|duplicate draft/i.test(node.textContent ?? ''))
}

function namedButton(pattern: RegExp) {
  return [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => pattern.test(node.textContent ?? ''))
}

function versionRow(label: string) {
  return [...document.querySelectorAll<HTMLButtonElement>('[data-testid="history-version-list"] button')]
    .find((node) => node.textContent?.includes(label))
}

const notFound = () => new ProductApiError({
  status: 404,
  code: 'resource_not_found',
  message: 'not found',
})

describe('Collection history Product wiring', () => {
  describe('collection history behaviour', () => {

    function render(path = '/library/col-1/history') {
      mountTree(
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path="/library/:id/history" element={<CollectionHistory />} />
            </Routes>
          </MemoryRouter>,
        )
    }

    beforeEach(() => {
      vi.clearAllMocks()
      clearRouteCache()
      mocks.enabled = false
      mocks.getCollectionEditorPage.mockResolvedValue(editorPage('col-1'))
      mocks.listCollectionVersions.mockResolvedValue({ items: [], nextCursor: null })
      mocks.getCollectionVersion.mockResolvedValue(version({
        changes: [{ type: 'added', nodeId: 'n1', title: 'Inbox notes' }],
      }))
      mocks.createCollectionVersion.mockResolvedValue(version({ versionId: 'ver-new', label: 'Saved now' }))
      mocks.restoreCollectionVersion.mockResolvedValue({
        versionId: 'ver-1',
        noop: false,
        updatedNodeIds: [],
        movedNodeIds: [],
        deletedNodeIds: [],
        preRestoreVersionId: null,
      })
      ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    })

    afterEach(() => {
      cleanup()
      document.body.innerHTML = ''
      vi.restoreAllMocks()
    })

    it('renders one centred empty state when the collection has no versions', async () => {
      mocks.enabled = true
      mocks.listCollectionVersions.mockResolvedValue({ items: [], nextCursor: null })
      render()
      await waitForDom(domFinishedLoading)

      // No two-column shell, and no second "nothing selected" state beside it.
      expect(document.querySelector('[data-testid="history-version-list"]')).toBeNull()
      expect(document.body.textContent).toContain('No versions yet')
      expect(document.body.textContent).toContain('Save a version to keep a restorable copy of this collection as it is now.')
      expect(document.body.textContent).not.toContain('Snapshots of this collection tree will appear here.')
      expect(document.body.textContent).not.toContain('No snapshot selected')
      expect(document.body.textContent).not.toContain('Back to library')
      expect(namedButton(/save first version/i)).toBeTruthy()
      expect(namedButton(/^\s*Save version\s*$/)).toBeUndefined()
      expect(document.querySelector('[data-testid="history-empty-versions"]')).not.toBeNull()
      expect(document.querySelector('[data-testid="history-empty-detail"]')).toBeNull()
    })

    it('saves the first version from the empty state', async () => {
      mocks.enabled = true
      mocks.listCollectionVersions.mockResolvedValue({ items: [], nextCursor: null })
      render()
      await waitForDom(domFinishedLoading)
      const saveFirst = namedButton(/save first version/i)
      expect(saveFirst?.classList.contains('btn-primary')).toBe(true)
      const primaries = [...document.querySelectorAll<HTMLButtonElement>('button')]
        .filter((button) => button.classList.contains('btn-primary'))
      expect(primaries).toHaveLength(1)
      act(() => saveFirst!.click())
      await waitForDom(domFinishedLoading)
      expect(mocks.createCollectionVersion).toHaveBeenCalledWith(
        'col-1',
        {},
        expect.objectContaining({ ifMatch: '"content-1"' }),
      )
      expect(mocks.success).toHaveBeenCalledWith('Version saved')
      expect(mocks.success).not.toHaveBeenCalledWith('Version saved.')
    })

    it('keeps the version list and describes a version that matches the collection now', async () => {
      mocks.enabled = true
      mocks.getCollectionVersion.mockResolvedValue(version({ changes: [] }))
      mocks.listCollectionVersions.mockResolvedValue({ items: [version()], nextCursor: null })
      render()
      await waitForDom(() => domFinishedLoading()
        && (document.body.textContent?.includes('This version matches the collection as it is now.') ?? false))

      expect(document.querySelector('[data-testid="history-version-list"]')).not.toBeNull()
      expect(versionRow('Live snapshot A')).not.toBeUndefined()
      expect(document.querySelector('[data-testid="history-empty-detail"]')).toBeNull()
      expect(document.querySelector('[data-testid="history-empty-versions"]')).toBeNull()
      expect(document.body.textContent).not.toContain('No changes compared with the version before it.')
      expect(document.body.textContent).not.toContain('No snapshot selected')
      expect(document.body.textContent).not.toContain('No versions yet')
    })

    it('selects the newest version on load', async () => {
      mocks.enabled = true
      mocks.listCollectionVersions.mockResolvedValue({
        items: [
          version({ versionId: 'ver-new', label: 'Newest snapshot', createdAt: '2026-08-18T00:00:00.000Z' }),
          version({ versionId: 'ver-old', label: 'Older snapshot', createdAt: '2026-08-01T00:00:00.000Z' }),
        ],
        nextCursor: null,
      })
      mocks.getCollectionVersion.mockImplementation(async (_collectionId: string, versionId: string) => version({
        versionId,
        label: versionId === 'ver-new' ? 'Newest snapshot' : 'Older snapshot',
        createdAt: versionId === 'ver-new' ? '2026-08-18T00:00:00.000Z' : '2026-08-01T00:00:00.000Z',
        kind: 'manual',
        changes: [{ type: 'renamed', nodeId: 'n1', title: 'Renamed bookmark' }],
      }))
      render()
      await waitForDom(() => domFinishedLoading()
        && (document.body.textContent?.includes('Renamed bookmark') ?? false))

      const list = document.querySelector('[data-testid="history-version-list"]')
      expect(list?.getAttribute('role')).toBe('group')
      expect(list?.tagName).not.toBe('NAV')
      const pressed = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="history-version-list"] button')]
        .filter((button) => button.getAttribute('aria-pressed') === 'true')
      expect(pressed).toHaveLength(1)
      expect(pressed[0]?.textContent).toContain('Newest snapshot')
      expect(mocks.getCollectionVersion).toHaveBeenCalledWith(
        'col-1',
        'ver-new',
        expect.objectContaining({ maxRetries: 0 }),
      )
      expect(mocks.getCollectionVersion.mock.calls.some((call) => call[1] === 'ver-old')).toBe(false)
      expect(document.body.textContent).toContain('Renamed')
      expect(document.body.textContent).toContain('Saved by you')
      expect([...document.querySelectorAll('dt')].map((node) => node.textContent)).toContain('Type')
      expect([...document.querySelectorAll('dt')].map((node) => node.textContent)).not.toContain('Kind')
      expect(document.body.textContent).not.toContain('No snapshot selected')
    })

    it('keeps production FEATURE_FLAGS.collectionHistory true', () => {
      expect(FEATURE_FLAGS.collectionHistory).toBe(true)
    })

    it('keeps flag-off EmptyState on history-page and does not render mock versions', async () => {
      render('/library/interface-systems/history')
      await waitForDom(domFinishedLoading)
      const page = document.querySelector('[data-testid="collection-history-flag-off"]')
      expect(page).not.toBeNull()
      expect(page?.className).toContain('page-shell')
      expect(page?.className).toContain('page-shell--grid')
      expect(page?.className).not.toContain('miss-page')
      expect(page?.className).not.toContain('p0-page')
      expect(document.querySelector('[data-testid="collection-history-flag-off"]')).not.toBeNull()
      expect(document.querySelector('[data-testid="collection-history-flag-off"]')?.closest('.page-shell')).not.toBeNull()
      expect(document.body.textContent).toContain('It will appear here when it is ready.')
      expect(document.body.textContent).not.toContain('This workspace has not enabled')
      expect(document.body.textContent).toContain('not available yet')
      expect(document.querySelector('input[type="search"]')).toBeNull()
      expect(restoreButtons()).toHaveLength(0)
      expect(document.body.textContent).not.toContain('Version 18')
      expect(document.body.textContent).not.toContain('Version 17')
      expect(document.body.textContent).not.toContain('Draft 19')
      expect(document.body.textContent).not.toContain('Alex Chen')
      expect(document.body.textContent).not.toContain('Restore as draft')
      expect(mocks.toast).not.toHaveBeenCalled()
      expect(mocks.success).not.toHaveBeenCalled()
      expect(mocks.getOwnedCollectionsPage).not.toHaveBeenCalled()
      expect(mocks.getCollectionEditorPage).not.toHaveBeenCalled()
      expect(mocks.listCollectionVersions).not.toHaveBeenCalled()
      expect(mocks.getCollectionVersion).not.toHaveBeenCalled()
      expect(mocks.createCollectionVersion).not.toHaveBeenCalled()
      expect(mocks.restoreCollectionVersion).not.toHaveBeenCalled()
    })

    it('paints version labels from HTTP and keeps mock titles out', async () => {
      mocks.enabled = true
      mocks.listCollectionVersions.mockResolvedValue({
        items: [
          version({ versionId: 'ver-1', label: 'Live snapshot A' }),
          version({ versionId: 'ver-2', label: 'Before organize', kind: 'pre_mutation' }),
        ],
        nextCursor: null,
      })
      render()
      await waitForDom(() => domFinishedLoading()
        && versionRow('Live snapshot A')?.getAttribute('aria-pressed') === 'true')
      expect(document.querySelector('[data-testid="collection-history-flag-off"]')).toBeNull()
      expect(document.querySelector('[data-testid="collection-history-page"]')?.className).toContain('page-shell--grid')
      expect(document.querySelector('input[type="search"]')).toBeNull()
      expect(document.body.textContent).toContain('Live snapshot A')
      expect(document.body.textContent).toContain('Before organize')
      expect(document.body.textContent).toContain('Collection col-1')
      expect(document.querySelector('h1')?.textContent).toBe('Version history')
      expect(document.body.textContent).not.toContain('Back to library')
      expect(namedButton(/^\s*Save version\s*$/)?.classList.contains('btn-primary')).toBe(true)
      expect(namedButton(/save first version/i)).toBeUndefined()
      expect(document.body.textContent).not.toContain('2026-08-01T00:00:00.000Z')
      expect(document.querySelector('[data-testid="history-version-list"]')?.getAttribute('role')).toBe('group')
      expect(document.querySelector('[role="listbox"]')).toBeNull()
      expect(document.querySelector('[role="option"]')).toBeNull()
      expect(document.querySelector('[aria-selected="true"]')).toBeNull()
      expect(versionRow('Live snapshot A')?.getAttribute('aria-pressed')).toBe('true')
      expect(document.body.textContent).not.toContain('Version 18')
      expect(document.body.textContent).not.toContain('Version 17')
      expect(document.body.textContent).not.toContain('Draft 19')
      expect(document.body.textContent).not.toContain('Alex Chen')
      expect(document.body.textContent).not.toContain('Restore as draft')
      expectEditorMetaRead(1)
      expect(mocks.listCollectionVersions.mock.calls[0]?.[0]).toBe('col-1')
      expect(mocks.getCollectionVersion).toHaveBeenCalledWith(
        'col-1',
        'ver-1',
        expect.objectContaining({ maxRetries: 0 }),
      )
    })

    it('loads get-by-id changes when a timeline row is selected', async () => {
      mocks.enabled = true
      mocks.listCollectionVersions.mockResolvedValue({
        items: [version({ changes: undefined })],
        nextCursor: null,
      })
      mocks.getCollectionVersion.mockResolvedValue(version({
        kind: 'pre_mutation',
        changes: [{ type: 'retargeted', nodeId: 'n2', title: 'Design tokens' }],
      }))
      render()
      await waitForDom(domFinishedLoading)
      act(() => versionRow('Live snapshot A')!.click())
      await waitForDom(() => domFinishedLoading()
        && (document.body.textContent?.includes('Design tokens') ?? false))
      expect(mocks.getCollectionVersion).toHaveBeenCalledWith(
        'col-1',
        'ver-1',
        expect.objectContaining({ maxRetries: 0 }),
      )
      expect(document.body.textContent).toContain('Design tokens')
      expect(document.body.textContent).toContain('Link changed')
      expect(document.body.textContent).toContain('Automatic, before a change')
      expect(document.body.textContent).not.toContain('retargeted')
      expect(document.body.textContent).not.toContain('pre_mutation')
      expect(document.querySelector('article')).not.toBeNull()
    })

    it('saves a version with collection contentEtag and not version or collection etag', async () => {
      mocks.enabled = true
      mocks.listCollectionVersions.mockResolvedValue({ items: [version()], nextCursor: null })
      render()
      await waitForDom(domFinishedLoading)
      act(() => versionRow('Live snapshot A')!.click())
      await waitForDom(domFinishedLoading)
      act(() => namedButton(/save version/i)!.click())
      await waitForDom(domFinishedLoading)
      expect(mocks.createCollectionVersion).toHaveBeenCalledWith(
        'col-1',
        {},
        expect.objectContaining({ ifMatch: '"content-1"' }),
      )
      const options = mocks.createCollectionVersion.mock.calls[0]?.[2] as { ifMatch: string }
      expect(options.ifMatch).toBe('"content-1"')
      expect(options.ifMatch).not.toBe('"version-etag-1"')
      expect(options.ifMatch).not.toBe('"collection-etag-1"')
      expect(mocks.success).toHaveBeenCalledWith('Version saved')
      expectEditorMetaRead(2)
    })

    it('keeps the version list and shows an inline error when saving a version fails', async () => {
      mocks.enabled = true
      mocks.listCollectionVersions.mockResolvedValue({ items: [version()], nextCursor: null })
      mocks.createCollectionVersion.mockRejectedValueOnce(new ProductApiError({ status: 500, code: 'internal', message: 'boom' }))
      render()
      await waitForDom(domFinishedLoading)
      act(() => namedButton(/save version/i)!.click())
      await waitForDom(domFinishedLoading)
      expect(document.body.textContent).toContain('Live snapshot A')
      expect(document.querySelector('[data-testid="history-action-error"]')?.textContent).toContain("Couldn't save the version. Try again.")
      expect(document.body.textContent).not.toContain("Couldn't load collection history")
    })

    it('restores the selected version with the same contentEtag', async () => {
      mocks.enabled = true
      mocks.listCollectionVersions.mockResolvedValue({ items: [version()], nextCursor: null })
      render()
      await waitForDom(domFinishedLoading)
      act(() => versionRow('Live snapshot A')!.click())
      await waitForDom(domFinishedLoading)
      const restore = namedButton(/^\s*Restore\s*$/i)
      expect(restore?.disabled).toBe(false)
      act(() => restore!.click())
      await waitForDom(domFinishedLoading)
      expect(document.body.textContent).toContain('Restore “Live snapshot A”?')
      const confirmBtn = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
        .find((btn) => btn.textContent?.trim() === 'Restore version')
      expect(confirmBtn).toBeTruthy()
      act(() => confirmBtn!.click())
      await waitForDom(domFinishedLoading)
      expect(mocks.restoreCollectionVersion).toHaveBeenCalledWith(
        'col-1',
        'ver-1',
        {},
        expect.objectContaining({ ifMatch: '"content-1"' }),
      )
      const options = mocks.restoreCollectionVersion.mock.calls[0]?.[3] as { ifMatch: string }
      expect(options.ifMatch).not.toBe('"version-etag-1"')
      expect(options.ifMatch).not.toBe('"collection-etag-1"')
      expectEditorMetaRead(2)
    })

    it('disables Restore when changeCounts.removed is greater than zero', async () => {
      mocks.enabled = true
      const blocked = version({ changeCounts: changeCounts({ removed: 2 }) })
      mocks.listCollectionVersions.mockResolvedValue({ items: [blocked], nextCursor: null })
      mocks.getCollectionVersion.mockResolvedValue(blocked)
      render()
      await waitForDom(domFinishedLoading)
      act(() => versionRow('Live snapshot A')!.click())
      await waitForDom(domFinishedLoading)
      const restoreBtn = namedButton(/^\s*Restore\s*$/i)
      expect(restoreBtn?.disabled).toBe(true)
      expect(restoreBtn?.getAttribute('aria-describedby')).toBe('history-restore-disabled-reason')
      const reason = document.getElementById('history-restore-disabled-reason')
      expect(reason).not.toBeNull()
      act(() => restoreBtn?.click())
      await waitForDom(domFinishedLoading)
      expect(mocks.restoreCollectionVersion).not.toHaveBeenCalled()
      expect(document.body.textContent).toContain('Restore isn\'t available for this version')
      expect(document.body.textContent).toContain('2 bookmarks or folders from this version are no longer in the collection, and restoring can\'t bring deleted items back yet.')
      expect(document.body.textContent).not.toContain('Cannot restore this snapshot')
      expect(document.body.textContent).not.toContain('Some bookmarks or folders from this snapshot are no longer on the tree.')
      expect(document.body.textContent).not.toContain('快照中的节点已不在树上')
    })

    it.each([
      ['list', () => {
        mocks.getCollectionEditorPage.mockResolvedValue(editorPage('col-1'))
        // The list endpoint is broken, not merely on the first read: StrictMode
        // remounts, and the second read must fail the same way.
        mocks.listCollectionVersions.mockRejectedValue(notFound())
      }],
      ['editor page', () => {
        mocks.getCollectionEditorPage.mockRejectedValue(notFound())
      }],
    ])('shows the library unavailable copy when %s returns 404 resource_not_found', async (_name, setup) => {
      mocks.enabled = true
      setup()
      render()
      await waitForDom(domFinishedLoading)
      expect(document.body.textContent).toContain('It will appear here when it is ready.')
      expect(document.body.textContent).not.toContain('This workspace has not enabled')
      expect(document.body.textContent).not.toContain('尚未开放')
      expect(document.body.textContent).not.toContain('Version 18')
      expect(document.body.textContent).not.toContain('Live snapshot A')
      expect(document.body.textContent).not.toContain('Draft 19')
      expect(document.body.textContent).not.toContain('Alex Chen')
      expect(mocks.restoreCollectionVersion).not.toHaveBeenCalled()
      expect(mocks.getOwnedCollectionsPage).not.toHaveBeenCalled()
    })

    it('does not fall back to mock versions on a non-404 Product error', async () => {
      mocks.enabled = true
      mocks.listCollectionVersions.mockRejectedValue(new ProductApiError({
        status: 500,
        code: 'transport_error',
        message: 'upstream failed',
      }))
      render()
      await waitForDom(domFinishedLoading)
      expect(document.body.textContent).toContain("Couldn't load collection history")
      expect(document.body.textContent).not.toContain('It will appear here when it is ready.')
      expect(document.body.textContent).not.toContain('尚未开放')
      expect(document.body.textContent).not.toContain('Version 18')
      expect(document.body.textContent).not.toContain('Version 17')
      expect(document.body.textContent).not.toContain('Draft 19')
      expect(document.body.textContent).not.toContain('Alex Chen')
      expect(document.body.textContent).not.toContain('Live snapshot A')
      expect(mocks.restoreCollectionVersion).not.toHaveBeenCalled()
    })

    it('ignores AbortError without an error banner or mock versions', async () => {
      mocks.enabled = true
      // Every read aborts, including StrictMode's remount read — an abort must
      // never surface as an error state.
      mocks.listCollectionVersions.mockRejectedValue(new DOMException('Aborted', 'AbortError'))
      render()
      await waitForDom(domFinishedLoading)
      expect(document.querySelector('[role="alert"]')).toBeNull()
      expect(document.body.textContent).not.toContain('Version 18')
      expect(document.body.textContent).not.toContain('Live snapshot A')
      expect(document.body.textContent).not.toMatch(
        /It will appear here when it is ready.|尚未开放|Could not/,
      )
    })

    it('links View published to /c/{slug} only when a publication slug exists', async () => {
      mocks.enabled = true
      mocks.getCollectionEditorPage.mockResolvedValue(editorPage('col-1', { slug: 'systems-notes' }))
      render()
      await waitForDom(domFinishedLoading)
      const published = document.querySelector('a[href="/c/systems-notes"]')
      expect(published).not.toBeNull()
      expect(published?.classList.contains('btn-ghost')).toBe(true)
      expect(published?.classList.contains('btn-primary')).toBe(false)
      expect(document.body.textContent).not.toContain('Back to library')
      expect(document.querySelector('a[href="/c/col-1"]')).toBeNull()
      expect(mocks.getOwnedCollectionsPage).not.toHaveBeenCalled()

      cleanup()
          document.body.innerHTML = ''
      mocks.getCollectionEditorPage.mockResolvedValue(editorPage('col-1', { slug: null }))
      render()
      await waitForDom(domFinishedLoading)
      expect(document.querySelector('a[href="/c/systems-notes"]')).toBeNull()
      expect(document.querySelector('a[href^="/c/"]')).toBeNull()
      expect(mocks.getOwnedCollectionsPage).not.toHaveBeenCalled()
    })

    it('uses the refreshed editor contentEtag after save for restore If-Match', async () => {
      mocks.enabled = true
      // Server state: each successful mutation advances the collection's content
      // revision, so the editor read that follows must observe the revision the
      // mutation wrote. A per-mount call queue would hand StrictMode's remount
      // the wrong etag and make the next If-Match stale.
      let contentEtag = '"content-1"'
      mocks.getCollectionEditorPage.mockImplementation(() => Promise.resolve(
        editorPage('col-1', { contentEtag }),
      ))
      mocks.createCollectionVersion.mockImplementation(() => {
        contentEtag = '"content-2"'
        return Promise.resolve(version({ versionId: 'ver-new', label: 'Saved now' }))
      })
      mocks.restoreCollectionVersion.mockImplementation(() => {
        contentEtag = '"content-3"'
        return Promise.resolve({
          versionId: 'ver-1',
          noop: false,
          updatedNodeIds: [],
          movedNodeIds: [],
          deletedNodeIds: [],
          preRestoreVersionId: null,
        })
      })
      mocks.listCollectionVersions.mockResolvedValue({ items: [version()], nextCursor: null })
      render()
      await waitForDom(domFinishedLoading)
      act(() => versionRow('Live snapshot A')!.click())
      await waitForDom(domFinishedLoading)
      act(() => namedButton(/save version/i)!.click())
      await waitForDom(domFinishedLoading)
      expect(mocks.createCollectionVersion).toHaveBeenCalledWith(
        'col-1',
        {},
        expect.objectContaining({ ifMatch: '"content-1"' }),
      )
      act(() => namedButton(/^\s*Restore\s*$/i)!.click())
      await waitForDom(domFinishedLoading)
      const confirmBtn = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
        .find((btn) => btn.textContent?.trim() === 'Restore version')
      expect(confirmBtn).toBeTruthy()
      act(() => confirmBtn!.click())
      await waitForDom(domFinishedLoading)
      expect(mocks.restoreCollectionVersion).toHaveBeenCalledWith(
        'col-1',
        'ver-1',
        {},
        expect.objectContaining({ ifMatch: '"content-2"' }),
      )
      expectEditorMetaRead(3)
    })
  })

  describe('architecture invariants that cannot be behaviour tested', () => {
    it('keeps collection history on the public api surface with no mock or private-client fallback', () => {
      /* The behaviour suite above proves the reachable half: versions come from
         productClient, a 404 renders the unavailable copy, a non-404 renders the
         error state, and no mock row is ever painted. What running code cannot
         show is an unused deep import, a dormant `mockOrLive` fallback or a
         private-locator template in a branch no test renders - all of which ship
         silently - so those absences are asserted on module specifiers and
         symbols rather than on formatted import lines. */
      expect(collectionHistorySource).toContain("from '../api'")
      expect(collectionHistorySource).toContain('isCollectionHistoryExposureEnabled')
      expect(collectionHistorySource).toContain('productClient')
      expect(collectionHistorySource).not.toContain('collectionVersions')
      expect(collectionHistorySource).not.toContain('mockOrLive')
      /* The reachable half of this one is the "View published" probe above
         (no /c/col-1 link renders); keeping the template out of the module
         covers the branches that probe never enters. */
      expect(collectionHistorySource).not.toContain('`/c/${id}`')
      expect(collectionHistorySource).not.toMatch(
        /from ['"]\.\.\/api\/(?:productClient|product-client|product-transport|types|errors|mock-data)['"]/,
      )
    })
  })
})
