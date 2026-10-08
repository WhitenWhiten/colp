// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FEATURE_FLAGS,
  ProductApiError,
  type ClassifyInboxItem,
} from '../api'
import { Classify } from './Classify'
import classifySource from './Classify.tsx?raw'
import { clearRouteCache } from '../lib/routeCache'
import { cleanup, domFinishedLoading, findButtonByName, mountTree, waitForDom } from '../test/render'

const MOCK_TITLE = 'Spacing as a system, not decoration'

const mocks = vi.hoisted(() => ({
  enabled: true,
  classificationEnabled: false,
  loadEditorSnapshot: vi.fn(),
  getClassificationSettings: vi.fn(),
  getMyCredits: vi.fn(),
  previewBookmarkClassification: vi.fn(),
  confirmBookmarkClassification: vi.fn(),
  getMyClassifyInbox: vi.fn(),
  skipMyClassifyInboxItem: vi.fn(),
  acceptMyClassifyInboxItem: vi.fn(),
  success: vi.fn(),
}))

vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: { accountId: 'classify-owner' } }) }))

vi.mock('../components/AppToast', () => ({
  useToast: () => ({ toast: vi.fn(), success: mocks.success, error: vi.fn() }),
}))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    isClassifyInboxExposureEnabled: () => mocks.enabled,
    isClassificationExposureEnabled: () => mocks.classificationEnabled,
    productClient: {
      ...actual.productClient,
      loadEditorSnapshot: mocks.loadEditorSnapshot,
      getClassificationSettings: mocks.getClassificationSettings,
      getMyCredits: mocks.getMyCredits,
      previewBookmarkClassification: mocks.previewBookmarkClassification,
      confirmBookmarkClassification: mocks.confirmBookmarkClassification,
      getMyClassifyInbox: mocks.getMyClassifyInbox,
      skipMyClassifyInboxItem: mocks.skipMyClassifyInboxItem,
      acceptMyClassifyInboxItem: mocks.acceptMyClassifyInboxItem,
    },
  }
})

function item(overrides: Partial<ClassifyInboxItem> = {}): ClassifyInboxItem {
  return {
    nodeId: 'node-1',
    collectionId: 'col-1',
    collectionTitle: 'Reading list',
    title: 'Root bookmark',
    url: 'https://example.test/path',
    host: 'example.test',
    etag: '"etag-1"',
    createdAt: '2026-08-24T00:00:00.000Z',
    suggestions: [
      {
        suggestionId: 'folder-1',
        folderId: 'folder-1',
        folderTitle: 'Design systems',
        score: 92,
        reason: 'Title/host overlap with "Design systems".',
        kind: 'existing',
      },
    ],
    ...overrides,
  }
}

function buttonNamed(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => node.textContent?.replace(/\s+/g, ' ').trim().startsWith(label))
  if (!button) throw new Error(`missing button ${label}`)
  return button
}

async function requestClassification() {
  await waitForDom(() => document.querySelector<HTMLInputElement>('input[type="checkbox"]')?.disabled === false)
  await act(async () => document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
  await act(async () => buttonNamed('Suggest a folder').click())
}

/* Two different kinds of claim live in this file and they are kept apart:
 *
 * 1. Behaviour — the page GETs the inbox through the Product client with the
 *    caller's abort signal, wraps Skip/File in intents with the GET's etag and
 *    suggestionId, maps 404/AbortError to the documented states, and never
 *    falls back to mock rows. Driven through the real page with the client and
 *    the exposure switch mocked.
 *
 * 2. Architecture — the *absence* of mock classify data, of a direct node-move
 *    call from the browser, and of a private Product transport import. None of
 *    those is falsifiable by running code: an unused import or an untaken
 *    fallback branch renders nothing, so no probe can distinguish it from the
 *    module not containing it at all. They are kept, anchored on identifiers
 *    and module specifiers rather than on formatting.
 */
describe('Classify Product wiring behaviour', () => {

  function render() {
    mountTree(
        <MemoryRouter>
          <Classify />
        </MemoryRouter>,
      )
  }

  beforeEach(() => {
    vi.clearAllMocks()
    clearRouteCache()
    mocks.success.mockReset()
    mocks.enabled = true
    mocks.classificationEnabled = false
    mocks.getClassificationSettings.mockResolvedValue({ settings: { executionMode: 'server_managed' } })
    mocks.getMyCredits.mockResolvedValue({ accountId: 'classify-owner', managedClassificationBillingMode: 'managed',
      balance: { available: 20 }, prices: [{ operationType: 'bookmark.classify', priceVersion: 'bookmark-classify.v1', unitPoints: 1 }] })
    mocks.previewBookmarkClassification.mockResolvedValue({ folder: { folderId: 'manual-folder', decision: 'l1_root', confidence: 0.8 },
      candidateCoverage: { l1Included: 1, l1Total: 1, descendantIncluded: 0, descendantTotal: 0 },
      tags: { mode: 'suggest', maxAutoTags: 3, candidates: [{ tag: 'AI', noul: 0.9, selected: true }] } })
    mocks.confirmBookmarkClassification.mockResolvedValue({ nodeId: 'node-1', etag: '"etag-2"', parentId: 'root', tags: ['AI'], operationIds: ['operation'] })
    mocks.loadEditorSnapshot.mockResolvedValue({ nodes: [{ id: 'manual-folder', kind: 'folder', title: 'Manual folder', parentId: 'root' }] })
    mocks.getMyClassifyInbox.mockResolvedValue({ items: [item()], nextCursor: null })
    mocks.skipMyClassifyInboxItem.mockResolvedValue({ nodeId: 'node-1', decision: 'skipped' })
    mocks.acceptMyClassifyInboxItem.mockResolvedValue({
      nodeId: 'node-1',
      decision: 'accepted',
      folderId: 'folder-1',
    })
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('allows a manually chosen authoritative folder even when lexical suggestions are empty', async () => {
    mocks.classificationEnabled = true
    mocks.getMyClassifyInbox.mockResolvedValue({ items: [item({ suggestions: [] })], nextCursor: null })
    render()
    await waitForDom(() => document.querySelectorAll('#classification-folder option').length === 2)
    expect(mocks.previewBookmarkClassification).not.toHaveBeenCalled()
    const select = document.querySelector<HTMLSelectElement>('#classification-folder')!
    await act(async () => { select.value = 'manual-folder'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    await act(async () => buttonNamed('File to Manual folder').click())
    expect(mocks.acceptMyClassifyInboxItem).toHaveBeenCalledWith('node-1', { suggestionId: 'manual-folder' }, '"etag-1"', expect.any(Object))
  })

  it('adds reviewed tags without moving or removing the inbox item', async () => {
    mocks.classificationEnabled = true; render()
    await waitForDom(() => Boolean(document.querySelector('#classification-folder')))
    await requestClassification()
    expect(buttonNamed('File to').textContent).toContain('and add 1 tag')
    await act(async () => buttonNamed('Add 1 selected tag only').click())
    expect(mocks.confirmBookmarkClassification).toHaveBeenCalledWith('col-1', 'node-1', { folderId: null, addTags: ['AI'] }, '"etag-1"', expect.objectContaining({ maxRetries: 0 }))
    expect(mocks.acceptMyClassifyInboxItem).not.toHaveBeenCalled()
    expect(mocks.skipMyClassifyInboxItem).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Root bookmark')
  })

  it('wraps the File label so a long folder name ellipsizes instead of covering Skip', async () => {
    /* ≤899px the docked bar is nowrap: unwrapped button text would paint
       over Skip. classify.css clips .classify-file-label — keep the span. */
    mocks.classificationEnabled = true
    render()
    await waitForDom(() => Boolean(document.querySelector('#classification-folder')))
    const button = buttonNamed('File to')
    const label = button.querySelector('span')
    expect(label).not.toBeNull()
    expect(label!.classList.contains('classify-file-label')).toBe(true)
    expect(label!.textContent).toContain('File to')
  })

  it('requires explicit refresh and review after a stale confirmation without replaying the old choice', async () => {
    mocks.classificationEnabled = true
    mocks.acceptMyClassifyInboxItem.mockRejectedValueOnce(new ProductApiError({ status: 412, code: 'precondition_failed', message: 'stale', recovery: 'refresh_and_retry' }))
    render(); await waitForDom(() => Boolean(document.querySelector('#classification-folder')))
    await requestClassification()
    await act(async () => buttonNamed('File to').click())
    expect(mocks.acceptMyClassifyInboxItem.mock.calls[0]?.[1]).toEqual({ suggestionId: 'folder-1', addTags: ['AI'] })
    expect(buttonNamed('File to').disabled).toBe(true)
    mocks.getMyClassifyInbox.mockResolvedValue({ items: [item({ etag: '"etag-2"' })], nextCursor: null })
    await act(async () => buttonNamed('Refresh and review').click())
    expect(mocks.acceptMyClassifyInboxItem).toHaveBeenCalledTimes(1)
    expect(buttonNamed('File to').textContent).not.toContain('add 1 tag')
    await act(async () => buttonNamed('File to').click())
    expect(mocks.acceptMyClassifyInboxItem.mock.calls[1]?.[2]).toBe('"etag-2"')
  })

  it('keeps compile-time classify exposure on', () => {
    expect(FEATURE_FLAGS.classify).toBe(true)
  })

  it('keeps flag-off inert and does not call GET or POST', async () => {
    mocks.enabled = false
    render()
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="classify-inbox-flag-off"]')).not.toBeNull()
    expect(document.body.textContent).toContain('Classify inbox is not available yet')
    expect(document.body.textContent).toContain('It will appear here when it is ready.')
    expect(document.body.textContent).not.toContain('This workspace has not enabled')
    expect(document.body.textContent).not.toMatch(/semantic|\bAI\b/i)
    expect(document.body.textContent).not.toContain(MOCK_TITLE)
    expect(document.querySelector('div.confidence-track')).toBeNull()
    expect(document.querySelector('[data-testid="classify-queue"]')).toBeNull()
    expect(document.body.textContent).not.toContain('File to')
    expect(mocks.getMyClassifyInbox).not.toHaveBeenCalled()
    expect(mocks.skipMyClassifyInboxItem).not.toHaveBeenCalled()
    expect(mocks.acceptMyClassifyInboxItem).not.toHaveBeenCalled()
  })

  it('shows the owning collection on each queue entry', async () => {
    mocks.getMyClassifyInbox.mockResolvedValue({
      items: [
        item(),
        item({ nodeId: 'node-2', title: 'Second root bookmark', collectionTitle: 'Design shelf', etag: '"etag-2"' }),
      ],
      nextCursor: null,
    })
    render()
    await waitForDom(domFinishedLoading)
    const entries = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="classify-queue"] button')]
    expect(entries).toHaveLength(2)
    expect(entries[0]?.textContent).toContain('Reading list')
    expect(entries[1]?.textContent).toContain('Design shelf')
  })

  it('GETs the inbox when exposure is on and renders existing-folder suggestions', async () => {
    render()
    await waitForDom(domFinishedLoading)
    expect(mocks.getMyClassifyInbox).toHaveBeenCalledWith(
      { limit: 20 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(document.body.textContent).toContain('Root bookmark')
    expect(document.body.textContent).toContain('example.test')
    expect(document.body.textContent).toContain('Design systems')
    expect(document.body.textContent).toContain('Review bookmarks that are still sitting in a collection root.')
    expect(document.body.textContent).not.toMatch(/semantic|\bAI\b/i)
    expect(document.querySelector('[data-testid="classify-inbox-layout"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="classify-queue"]')).not.toBeNull()
    expect(document.querySelector('div.confidence-track')).not.toBeNull()
    expect(document.body.textContent).not.toContain(MOCK_TITLE)
  })

  it('wraps Skip in a Product command and removes the item from the server receipt', async () => {
    mocks.getMyClassifyInbox.mockResolvedValue({
      items: [
        item(),
        item({ nodeId: 'node-2', title: 'Second root bookmark', etag: '"etag-2"' }),
      ],
      nextCursor: null,
    })
    render()
    await waitForDom(domFinishedLoading)
    act(() => buttonNamed('Skip').click())
    await waitForDom(domFinishedLoading)
    expect(mocks.skipMyClassifyInboxItem).toHaveBeenCalledWith(
      'node-1',
      expect.objectContaining({ intentId: expect.any(String), maxRetries: 0 }),
    )
    expect(document.body.textContent).not.toContain('Root bookmark')
    expect(document.body.textContent).toContain('Second root bookmark')
    expect(document.body.textContent).not.toContain(MOCK_TITLE)
  })

  it('wraps File in accept with If-Match etag and suggestionId from GET', async () => {
    render()
    await waitForDom(domFinishedLoading)
    act(() => buttonNamed('File to').click())
    await waitForDom(domFinishedLoading)
    expect(mocks.acceptMyClassifyInboxItem).toHaveBeenCalledWith(
      'node-1',
      { suggestionId: 'folder-1' },
      '"etag-1"',
      expect.objectContaining({ intentId: expect.any(String), maxRetries: 0 }),
    )
    expect(document.body.textContent).not.toContain('Root bookmark')
    // The move is permanent, so the follow-up is a real link to the destination
    // folder, not an Undo the server cannot honour.
    expect(mocks.success).toHaveBeenCalledWith('Filed to Design systems', {
      action: { label: 'View in folder', to: '/library/col-1?folder=folder-1' },
    })
  })

  it('maps 404 resource_not_found to the not-available empty copy', async () => {
    mocks.getMyClassifyInbox.mockRejectedValue(new ProductApiError({
      status: 404,
      code: 'resource_not_found',
      message: 'Classify inbox is not enabled',
    }))
    render()
    await waitForDom(domFinishedLoading)
    expect(document.body.textContent).toContain('Classify inbox is not available yet')
    expect(document.body.textContent).toContain('It will appear here when it is ready.')
    expect(document.body.textContent).not.toContain('This workspace has not enabled')
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(document.body.textContent).not.toContain(MOCK_TITLE)
    expect(document.body.textContent).not.toContain('File to')
    expect(document.querySelector('[data-testid="classify-queue"]')).toBeNull()
  })

  it('clears items on other failures and never falls back to the mock title', async () => {
    mocks.getMyClassifyInbox.mockRejectedValue(new Error('network'))
    render()
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[role="alert"]')).not.toBeNull()
    expect(document.body.textContent).toContain("Couldn't load your classify inbox")
    expect(document.body.textContent).not.toContain(MOCK_TITLE)
    expect(document.body.textContent).not.toContain('Root bookmark')
    expect(document.querySelector('[data-testid="classify-queue"]')).toBeNull()
  })

  it('does not treat AbortError as a load failure', async () => {
    mocks.getMyClassifyInbox.mockRejectedValue(new DOMException('Aborted', 'AbortError'))
    render()
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(document.body.textContent).not.toContain("Couldn't load your classify inbox")
    expect(document.body.textContent).not.toContain(MOCK_TITLE)
  })

  it('disables File without suggestions and still allows Skip', async () => {
    mocks.getMyClassifyInbox.mockResolvedValue({
      items: [item({ suggestions: [], title: 'Unmatched bookmark' })],
      nextCursor: null,
    })
    render()
    await waitForDom(domFinishedLoading)
    expect(buttonNamed('File to').disabled).toBe(true)
    expect(buttonNamed('Skip').disabled).toBe(false)
    act(() => buttonNamed('Skip').click())
    await waitForDom(domFinishedLoading)
    expect(mocks.skipMyClassifyInboxItem).toHaveBeenCalledTimes(1)
    expect(mocks.acceptMyClassifyInboxItem).not.toHaveBeenCalled()
  })

  it('offers a manual folder when there is no suggestion and files to it', async () => {
    mocks.getMyClassifyInbox.mockResolvedValue({
      items: [item({ suggestions: [], title: 'Unmatched bookmark' })],
      nextCursor: null,
    })
    mocks.loadEditorSnapshot.mockResolvedValue({
      root: { id: 'root' },
      nodes: [{ id: 'manual-folder', kind: 'folder', title: 'Manual folder', parentId: 'root', position: 'a0' }],
    })
    render()
    await waitForDom(domFinishedLoading)
    expect(document.body.textContent).toContain('No folder suggestion for this bookmark yet.')
    expect(document.body.textContent).not.toContain('overlap')
    // The selected bookmark heads the decision card; no separate Incoming card.
    expect([...document.querySelectorAll('h2')].map((heading) => heading.textContent)).toContain('Unmatched bookmark')
    expect(document.body.textContent).not.toContain('Incoming')
    await act(async () => buttonNamed('Choose a folder…').click())
    await waitForDom(() => [...document.querySelectorAll('button')].some((button) => button.textContent?.includes('Manual folder')))
    const folder = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Manual folder'))!
    await act(async () => folder.click())
    expect(document.body.textContent).toContain('Selected: Manual folder')
    const file = buttonNamed('File to Manual folder')
    expect(file.disabled).toBe(false)
    await act(async () => file.click())
    expect(mocks.acceptMyClassifyInboxItem).toHaveBeenCalledWith('node-1', { suggestionId: 'manual-folder' }, '"etag-1"', expect.any(Object))
  })

  it('uses radiogroup and radio semantics instead of aria-pressed', async () => {
    render()
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="classify-queue"]')?.getAttribute('role')).toBe('radiogroup')
    const queueRadio = document.querySelector('[data-testid="classify-queue"] button')
    expect(queueRadio?.getAttribute('role')).toBe('radio')
    expect(queueRadio?.getAttribute('aria-checked')).toBe('true')
    expect(document.querySelectorAll('[role="radiogroup"]').length).toBe(2)
    const radio = document.querySelector('button.suggestion')
    expect(radio?.getAttribute('role')).toBe('radio')
    expect(radio?.getAttribute('aria-checked')).toBe('true')
    expect(radio?.querySelector('h4')).toBeNull()
    expect(radio?.querySelector('strong')?.textContent).toBe('Design systems')
  })

  it('confirms a skip without a fake Undo and offers Retry after an action error', async () => {
    mocks.getMyClassifyInbox.mockResolvedValue({
      items: [
        item(),
        item({ nodeId: 'node-2', title: 'Second root bookmark', etag: '"etag-2"' }),
      ],
      nextCursor: null,
    })
    render()
    await waitForDom(domFinishedLoading)
    act(() => buttonNamed('Skip').click())
    await waitForDom(domFinishedLoading)
    expect(document.body.textContent).not.toContain('Root bookmark')
    // Skip is permanent on the server (no revert endpoint), so the toast must
    // not pretend the row can come back.
    expect(mocks.success).toHaveBeenCalledTimes(1)
    expect(mocks.success.mock.calls[0]?.[0]).toMatch(/^Skipped/)
    const skipAction = mocks.success.mock.calls[0]?.[1]?.action
    expect(skipAction).toBeUndefined()
    expect(document.body.textContent).toContain('Second root bookmark')

    mocks.skipMyClassifyInboxItem.mockRejectedValueOnce(new Error('network'))
    act(() => buttonNamed('Skip').click())
    await waitForDom(domFinishedLoading)
    expect(document.body.textContent).toContain('Classify inbox action failed')
    mocks.skipMyClassifyInboxItem.mockResolvedValueOnce({ nodeId: 'node-1', decision: 'skipped' })
    act(() => findButtonByName('Try again').click())
    await waitForDom(domFinishedLoading)
    expect(mocks.skipMyClassifyInboxItem).toHaveBeenCalledTimes(3)
  })
})

describe('architecture invariants that cannot be behaviour tested', () => {
  it('keeps the Product HTTP boundary, mock classify data and node mutations out of the page', () => {
    /* The reachable half of this claim is proven behaviourally above: every
       request the page makes lands on the `../api` barrel mock, and the
       absence of `moveCollectionNode` / `createCollectionNode` calls is
       visible as the exact client argument lists. What a render cannot show is
       an *unused* import or an untaken fallback branch — the page importing
       mock classify rows, a hand-rolled transport, or node-mutation helpers
       changes nothing until the branch that uses them runs, and then it shows
       up as a silent success rather than a failure. Asserted on module
       specifiers and identifiers, so renaming an unrelated symbol cannot break
       it. */
    expect(classifySource.length).toBeGreaterThan(8_000)
    expect(classifySource).toMatch(/from '\.\.\/api'/)
    expect(classifySource).not.toContain('classifyInbox')
    expect(classifySource).not.toContain("mockOrLive('classify'")
    expect(classifySource).not.toContain('moveCollectionNode')
    expect(classifySource).not.toContain('createCollectionNode')
    expect(classifySource).not.toMatch(
      /from ['"]\.\.\/api\/(?:productClient|product-client|product-transport|mock-data)['"]/,
    )
  })
})
