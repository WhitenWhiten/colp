// @vitest-environment happy-dom
import { act } from 'react'
import { Link, MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorSnapshot } from '../api/types'
import { ProductApiError } from '../api/errors'
import {
  createMemorySessionStorage,
  installSessionStorage,
  resetProductSession,
} from '../api/test-helpers'
import { CollectionEditor, etagForDelete, resolveEditableNode } from './CollectionEditor'
import { CollectionSettingsSheet } from './library-desk/CollectionSettingsSheet'
import { cleanup, domFinishedLoading, findButtonByName, mountTree, settled, waitForDom } from '../test/render'

const mocks = vi.hoisted(() => ({
  auth: {
    isLoggedIn: true,
    bootstrapping: false,
    refreshSession: vi.fn<() => Promise<void>>(),
  },
  toast: vi.fn<(message: string) => void>(),
  success: vi.fn<(message: string) => void>(),
  error: vi.fn<(message: string) => void>(),
  loadEditorSnapshot: vi.fn(),
  realLoadEditorSnapshot: undefined as unknown as typeof import('../api').productClient.loadEditorSnapshot,
  updateCollection: vi.fn(),
  createCollectionNode: vi.fn(),
  updateCollectionNode: vi.fn(),
  moveCollectionNode: vi.fn(),
  deleteCollectionNode: vi.fn(),
  uploadBookmarkFavicon: vi.fn(),
  deleteBookmarkFavicon: vi.fn(),
  getBookmarkFaviconSource: vi.fn(),
  setBookmarkFaviconSource: vi.fn(),
  getCollectionCatalog: vi.fn(),
  updateCollectionCatalog: vi.fn(),
  getReportCatalog: vi.fn(),
  updateReportCatalog: vi.fn(),
  loadAnnotations: vi.fn(),
  createAnnotation: vi.fn(),
  updateAnnotation: vi.fn(),
  deleteAnnotation: vi.fn(),
  abandonAnnotationIntent: vi.fn(),
}))

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => mocks.auth,
}))

vi.mock('../components/AppToast', () => ({
  useToast: () => ({
    toast: mocks.toast,
    success: mocks.success,
    error: mocks.error,
  }),
}))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  mocks.realLoadEditorSnapshot = actual.productClient.loadEditorSnapshot
  return {
    ...actual,
    productClient: {
      ...actual.productClient,
      loadEditorSnapshot: mocks.loadEditorSnapshot,
      updateCollection: mocks.updateCollection,
      createCollectionNode: mocks.createCollectionNode,
      updateCollectionNode: mocks.updateCollectionNode,
      moveCollectionNode: mocks.moveCollectionNode,
      deleteCollectionNode: mocks.deleteCollectionNode,
      uploadBookmarkFavicon: mocks.uploadBookmarkFavicon,
      deleteBookmarkFavicon: mocks.deleteBookmarkFavicon,
      getBookmarkFaviconSource: mocks.getBookmarkFaviconSource,
      setBookmarkFaviconSource: mocks.setBookmarkFaviconSource,
      getCollectionCatalog: mocks.getCollectionCatalog,
      updateCollectionCatalog: mocks.updateCollectionCatalog,
      getReportCatalog: mocks.getReportCatalog,
      updateReportCatalog: mocks.updateReportCatalog,
      loadAnnotations: mocks.loadAnnotations,
      createAnnotation: mocks.createAnnotation,
      updateAnnotation: mocks.updateAnnotation,
      deleteAnnotation: mocks.deleteAnnotation,
      abandonAnnotationIntent: mocks.abandonAnnotationIntent,
      newCommandId: () => '11111111-1111-4111-8111-111111111111',
      mutationIntentKey: (scope: string, commandId: string) => `${scope}:${commandId}`,
    },
  }
})

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function snapshot(overrides: Partial<EditorSnapshot> = {}): EditorSnapshot {
  return {
    collection: {
      id: 'col-1',
      kind: 'bookmarks',
      title: 'Reading queue',
      summary: 'Saved research',
      visibility: 'private',
      rootNodeId: 'root-1',
      revision: '1',
      etag: '"c-1"',
      contentRevision: '1',
      contentEtag: '"cc-1"',
      policyRevision: '1',
      policyEtag: '"p-1"',
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
    },
    root: {
      id: 'root-1',
      kind: 'folder',
      folderRole: 'root',
      title: 'Root',
      description: null,
      tags: [],
      visibility: 'inherit',
      revision: '1',
      etag: '"root-1"',
      childrenRevision: '1',
    },
    nodes: [
      {
        id: 'node-first',
        kind: 'bookmark',
        title: 'First page item',
        url: 'https://first.example',
        description: null,
        tags: [],
        visibility: 'inherit',
        revision: '1',
        etag: '"n-1"',
        parentId: 'root-1',
        position: 'a',
        readOnly: false,
        readOnlyReason: null,
      },
      {
        id: 'node-next',
        kind: 'bookmark',
        title: 'Continuation item',
        url: 'https://next.example',
        description: null,
        tags: [],
        visibility: 'inherit',
        revision: '1',
        etag: '"n-2"',
        parentId: 'root-1',
        position: 'b',
        readOnly: false,
        readOnlyReason: null,
      },
    ],
    capabilities: {
      updateCollection: true,
      managePublication: true,
      createNode: true,
      updateNode: true,
      moveNode: true,
      deleteNode: true,
    },
    page: {
      snapshotId: 'snap-complete',
      contentRevision: '1',
      policyRevision: '1',
      comparatorVersion: 'v1',
      expiresAt: '2026-07-22T12:00:00.000Z',
      returnedCount: 2,
      hasMore: false,
      nextCursor: null,
    },
    ...overrides,
  } as unknown as EditorSnapshot
}

function apiError(status: number, code: string, recovery: string): ProductApiError {
  return new ProductApiError({
    status,
    code,
    message: code,
    recovery,
  })
}

function setControlValue(control: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype =
    control instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  if (!setter) throw new Error('native value setter unavailable')
  act(() => {
    setter.call(control, value)
    control.dispatchEvent(new Event('input', { bubbles: true }))
    control.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function submit(controlId: string) {
  const control = document.getElementById(controlId)
  const form = control?.closest('form')
  if (!form) throw new Error(`form not found for ${controlId}`)
  act(() => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

describe('CollectionEditor component', () => {
  let restoreStorage: (() => void) | undefined
  let restoreFetch: (() => void) | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    // clearAllMocks keeps implementations (and pending once-queues), while the
    // two mocks below describe per-test endpoint state; drop the previous
    // test's behaviour so each test's mock stands on its own.
    mocks.loadEditorSnapshot.mockReset()
    mocks.updateCollection.mockReset()
    mocks.auth.isLoggedIn = true
    mocks.auth.bootstrapping = false
    mocks.auth.refreshSession.mockResolvedValue(undefined)
    mocks.loadAnnotations.mockResolvedValue([])
    mocks.abandonAnnotationIntent.mockReturnValue(undefined)
    // CG catalog fields read the collection/report catalog when the inspector
    // mounts; default to an empty catalog so editor tests never hit fetch.
    mocks.getCollectionCatalog.mockResolvedValue({ tags: [], language: null, revision: '1' })
    mocks.getReportCatalog.mockResolvedValue({ tags: [], language: null, revision: '1' })
    // The FO-01 source control reads the favicon source whenever a bookmark is
    // selected; default to inherit so inspector tests never hit fetch.
    mocks.getBookmarkFaviconSource.mockResolvedValue({
      collectionId: 'col-1',
      nodeId: 'node-first',
      revision: '1',
      policyRevision: '1',
      sourceMode: 'inherit',
      effectiveMode: 'capture',
      iconUrl: null,
      iconVersion: null,
      directUrl: null,
      status: 'missing',
      restorable: false,
      updatedAt: '2026-07-22T00:00:00.000Z',
      etag: '"favicon-source:n-1:1"',
    })
    mocks.setBookmarkFaviconSource.mockResolvedValue({})
    vi.stubEnv('VITE_MOCK_SESSION', 'false')
    restoreStorage = installSessionStorage(createMemorySessionStorage())
    resetProductSession()
    document.body.innerHTML = '<div id="test-root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
    restoreFetch?.()
    restoreFetch = undefined
    restoreStorage?.()
    restoreStorage = undefined
    resetProductSession()
    vi.unstubAllEnvs()
  })

  function renderEditor(path = '/library/col-1') {
    const host = document.getElementById('test-root')
    if (!host) throw new Error('test root missing')
    const deskPath = path.replace(/\/edit(?=\?|$)/, '')
    mountTree(
        <MemoryRouter initialEntries={[deskPath]}>
          <Routes>
            <Route path="/library/:id/edit" element={<CollectionEditor />} />
            <Route path="/library/:id" element={(
              <>
                <CollectionSettingsSheet open onClose={() => {}} />
                <Link data-testid="switch-collection" to="/library/col-2">Switch collection</Link>
              </>
            )} />
            <Route path="/library" element={<p>Library destination</p>} />
            <Route path="/login" element={<p data-testid="login-destination">Login destination</p>} />
          </Routes>
        </MemoryRouter>,
      )
  }

  it('redirects /library/:id/edit onto the desk with collection=edit, and keeps ?node=', () => {
    function Where() {
      const location = useLocation()
      return <p data-testid="where">{location.pathname}{location.search}</p>
    }
    mountTree(
      <MemoryRouter initialEntries={['/library/col-1/edit?node=node-next']}>
        <Routes>
          <Route path="/library/:id/edit" element={<CollectionEditor />} />
          <Route path="/library/:id" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    )
    expect(document.querySelector('[data-testid="where"]')?.textContent).toBe('/library/col-1?node=node-next')
    cleanup()
    mountTree(
      <MemoryRouter initialEntries={['/library/col-1/edit']}>
        <Routes>
          <Route path="/library/:id/edit" element={<CollectionEditor />} />
          <Route path="/library/:id" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    )
    expect(document.querySelector('[data-testid="where"]')?.textContent).toBe('/library/col-1?collection=edit')
  })

  it('keeps mutation controls busy and applies a successful metadata response', async () => {
    // The collection read is a steady state: every read — StrictMode mounts
    // the load effect twice — serves the same snapshot.
    mocks.loadEditorSnapshot.mockResolvedValue(snapshot())
    const mutation = deferred<{ collection: EditorSnapshot['collection'] }>()
    mocks.updateCollection.mockReturnValueOnce(mutation.promise)
    renderEditor()
    await waitForDom(domFinishedLoading)

    const title = document.getElementById('ce-title') as HTMLInputElement
    setControlValue(title, 'Updated collection')
    const writesBefore = mocks.updateCollection.mock.calls.length
    submit('ce-title')

    expect(
      document.querySelector('[data-testid="collection-settings"]')?.getAttribute('aria-busy'),
    ).toBe('true')
    expect(findButtonByName('Saving…').disabled).toBe(true)
    expect(mocks.updateCollection).toHaveBeenCalledWith(
      'col-1',
      { title: 'Updated collection', summary: 'Saved research' },
      '"c-1"',
      expect.objectContaining({ intentId: expect.stringContaining('update-collection:col-1'), signal: expect.any(AbortSignal) }),
    )
    // One activation issues exactly one write: StrictMode's double invocation
    // must not duplicate the save.
    expect(mocks.updateCollection.mock.calls.length).toBe(writesBefore + 1)

    const updated = snapshot().collection
    await act(async () => {
      mutation.resolve({
        collection: { ...updated, title: 'Updated collection', etag: '"c-2"' },
      })
      await mutation.promise
    })

    expect((document.getElementById('ce-title') as HTMLInputElement).value).toBe('Updated collection')
    expect(mocks.success).toHaveBeenCalledWith('Collection settings saved')
    expect(
      document.querySelector('[data-testid="collection-settings"]')?.getAttribute('aria-busy'),
    ).toBe('false')
  })

  it('preserves an existing public locator when a metadata response omits unchanged publication fields', async () => {
    const base = snapshot()
    const published = snapshot({
      collection: {
        ...base.collection,
        visibility: 'public',
        publicationSlug: 'research-notes',
        publishedAt: '2026-07-24T00:00:00.000Z',
      },
    })
    const { publicationSlug: _slug, publishedAt: _publishedAt, ...partialCollection } = {
      ...published.collection,
      title: 'Updated public collection',
      etag: '"c-2"',
    }
    mocks.loadEditorSnapshot.mockResolvedValue(published)
    mocks.updateCollection.mockResolvedValueOnce({
      collection: partialCollection as EditorSnapshot['collection'],
    })
    renderEditor()
    await waitForDom(domFinishedLoading)

    setControlValue(document.getElementById('ce-title') as HTMLInputElement, 'Updated public collection')
    submit('ce-title')
    await waitForDom(domFinishedLoading)

    const slug = document.getElementById('ce-publication-slug') as HTMLInputElement
    expect(slug.value).toBe('research-notes')
    expect(slug.disabled).toBe(true)
    expect(document.querySelector<HTMLAnchorElement>('[data-testid="publication-canonical"] a')?.getAttribute('href')).toBe('/c/research-notes')
  })

  it('refreshes a conflict and lets the user re-apply the change with a new fence', async () => {
    const refreshed = snapshot({
      collection: {
        ...snapshot().collection,
        title: 'Server title',
        revision: '2',
        etag: '"c-2"',
      },
    })
    // Endpoint state, not a call-index queue: the server has already moved on,
    // so the first write is fenced out, and from that point every read serves
    // the refreshed collection.
    let serverSnapshot = snapshot()
    let conflictPending = true
    mocks.loadEditorSnapshot.mockImplementation(() => Promise.resolve(serverSnapshot))
    mocks.updateCollection.mockImplementation(() => {
      if (conflictPending) {
        conflictPending = false
        serverSnapshot = refreshed
        return Promise.reject(apiError(412, 'precondition_failed', 'refresh_and_retry'))
      }
      return Promise.resolve({
        collection: { ...refreshed.collection, title: 'Re-applied title', etag: '"c-3"' },
      })
    })

    renderEditor()
    await waitForDom(domFinishedLoading)
    setControlValue(document.getElementById('ce-title') as HTMLInputElement, 'Stale edit')
    const readsBeforeConflict = mocks.loadEditorSnapshot.mock.calls.length
    submit('ce-title')
    await waitForDom(domFinishedLoading)

    expect(mocks.toast).toHaveBeenCalledWith('Conflict — refreshed. Re-apply your change.')
    // The 412 recovery issues exactly one refresh read — no retry loop — and
    // every read targets the collection under edit.
    expect(mocks.loadEditorSnapshot.mock.calls.length).toBe(readsBeforeConflict + 1)
    expect(new Set(mocks.loadEditorSnapshot.mock.calls.map(([id]) => id))).toEqual(new Set(['col-1']))
    expect((document.getElementById('ce-title') as HTMLInputElement).value).toBe('Server title')

    setControlValue(document.getElementById('ce-title') as HTMLInputElement, 'Re-applied title')
    submit('ce-title')
    await waitForDom(domFinishedLoading)

    expect(mocks.updateCollection).toHaveBeenLastCalledWith(
      'col-1',
      expect.objectContaining({ title: 'Re-applied title' }),
      '"c-2"',
      expect.any(Object),
    )
    expect(mocks.success).toHaveBeenCalledWith('Collection settings saved')
  })

  it('publishes with a canonical slug and can withdraw without changing the immutable slug', async () => {
    mocks.loadEditorSnapshot.mockResolvedValue(snapshot())
    mocks.updateCollection
      .mockResolvedValueOnce({
        collection: {
          ...snapshot().collection,
          visibility: 'public',
          publicationSlug: 'research-notes',
          publishedAt: '2026-07-24T00:00:00.000Z',
          etag: '"c-2"',
        },
      })
      .mockResolvedValueOnce({
        collection: {
          ...snapshot().collection,
          visibility: 'private',
          publicationSlug: 'research-notes',
          // The durable first-publication timestamp survives withdrawal.
          publishedAt: '2026-07-24T00:00:00.000Z',
          etag: '"c-3"',
        },
      })
    renderEditor()
    await waitForDom(domFinishedLoading)

    const publicOption = findButtonByName('Public')
    expect(publicOption.getAttribute('role')).toBe('radio')
    expect(publicOption.getAttribute('aria-checked')).toBe('false')
    act(() => publicOption.click())
    expect(publicOption.getAttribute('aria-checked')).toBe('true')
    setControlValue(
      document.getElementById('ce-publication-slug') as HTMLInputElement,
      'research-notes',
    )
    expect(document.querySelector('[data-testid="publication-canonical"]')).toBeNull()
    submit('ce-title')
    await waitForDom(domFinishedLoading)

    expect(mocks.updateCollection).toHaveBeenNthCalledWith(
      1,
      'col-1',
      expect.objectContaining({ visibility: 'public', publicationSlug: 'research-notes' }),
      '"c-1"',
      expect.objectContaining({ intentId: expect.stringContaining('update-collection:col-1') }),
    )
    const canonical = document.querySelector<HTMLAnchorElement>('[data-testid="publication-canonical"] a')
    expect(canonical?.getAttribute('href')).toBe('/c/research-notes')
    expect((document.getElementById('ce-publication-slug') as HTMLInputElement).disabled).toBe(true)
    expect(document.body.textContent).toContain("The address can't be changed once it is reserved.")

    act(() => findButtonByName('Private').click())
    submit('ce-title')
    await waitForDom(domFinishedLoading)
    expect(mocks.updateCollection).toHaveBeenNthCalledWith(
      2,
      'col-1',
      expect.not.objectContaining({ publicationSlug: expect.anything() }),
      '"c-2"',
      expect.any(Object),
    )
    expect(mocks.updateCollection.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ visibility: 'private' }))
    expect(document.querySelector('[data-testid="publication-canonical"] a')).toBeNull()
    expect(document.querySelector('[data-testid="publication-canonical"]')?.textContent).toContain('Published at (currently private)')
    expect(document.getElementById('ce-publication-slug')).toBeNull()
  })

  it('hides the address while private, previews it before it is reserved, and does not put Refresh next to Save', async () => {
    mocks.loadEditorSnapshot.mockResolvedValue(snapshot())
    renderEditor()
    await waitForDom(domFinishedLoading)

    expect(document.getElementById('ce-publication-slug')).toBeNull()
    expect(
      [...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'Refresh'),
    ).toBe(false)
    expect(findButtonByName('Save collection').textContent?.trim()).toBe('Save collection')

    act(() => findButtonByName('Public').click())
    expect(document.body.textContent).toContain('Will be live at /c/your-address after you save.')
    setControlValue(document.getElementById('ce-publication-slug') as HTMLInputElement, 'research-notes')
    expect(document.body.textContent).toContain('Will be live at /c/research-notes after you save.')
    expect(document.body.textContent).not.toContain('Will be live at /c/your-address after you save.')
    expect((document.getElementById('ce-publication-slug') as HTMLInputElement).disabled).toBe(false)

    act(() => findButtonByName('Private').click())
    expect(document.getElementById('ce-publication-slug')).toBeNull()
    expect(document.body.textContent).not.toContain('Will be live at /c/research-notes after you save.')
    act(() => findButtonByName('Unlisted').click())
    expect((document.getElementById('ce-publication-slug') as HTMLInputElement).value).toBe('research-notes')
    expect(document.body.textContent).toContain('Will be live at /c/research-notes after you save.')
  })

  it('commits tags and language with Save collection instead of a second save button', async () => {
    const base = snapshot()
    mocks.loadEditorSnapshot.mockResolvedValue(base)
    mocks.updateCollection.mockResolvedValueOnce({ collection: { ...base.collection, etag: '"c-2"' } })
    mocks.updateCollectionCatalog.mockResolvedValueOnce({ tags: ['design', 'systems'], language: 'en', revision: '2' })
    renderEditor()
    await waitForDom(domFinishedLoading)
    await waitForDom(() => document.getElementById('collection-catalog-tags') !== null)

    expect(
      [...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'Save tags and language'),
    ).toBe(false)
    setControlValue(document.getElementById('collection-catalog-tags') as HTMLInputElement, 'design, systems')
    act(() => {
      const language = document.getElementById('collection-catalog-language') as HTMLSelectElement
      language.value = 'en'
      language.dispatchEvent(new Event('change', { bubbles: true }))
    })
    submit('ce-title')
    await waitForDom(() => mocks.updateCollectionCatalog.mock.calls.length > 0)

    expect(mocks.updateCollection).toHaveBeenCalledTimes(1)
    expect(mocks.updateCollectionCatalog).toHaveBeenCalledWith(
      'col-1',
      { tags: ['design', 'systems'], language: 'en' },
      '"1"',
      expect.objectContaining({ maxRetries: 0 }),
    )
  })

  it('ignores an aborted route load that rejects after the next collection is ready', async () => {
    const oldLoad = deferred<EditorSnapshot>()
    const newLoad = deferred<EditorSnapshot>()
    // Endpoint state keyed by resource, not by call index: col-1's read is
    // stalled (and later rejected after its route was abandoned), col-2's
    // resolves. StrictMode's second mount read hits the same stalled read.
    mocks.loadEditorSnapshot.mockImplementation((id: string) => (
      id === 'col-2' ? newLoad.promise : oldLoad.promise
    ))
    renderEditor()

    act(() => {
      ;(document.querySelector('[data-testid="switch-collection"]') as HTMLAnchorElement).click()
    })
    await settled()
    await act(async () => {
      newLoad.resolve(snapshot({
        collection: { ...snapshot().collection, id: 'col-2', title: 'Newest collection', etag: '"c-2"' },
      }))
      await newLoad.promise
    })
    expect((document.getElementById('ce-title') as HTMLInputElement).value).toBe('Newest collection')

    await act(async () => {
      oldLoad.reject(new Error('stale failure'))
      await oldLoad.promise.catch(() => undefined)
    })
    expect((document.getElementById('ce-title') as HTMLInputElement).value).toBe('Newest collection')
    expect(document.querySelector('[data-testid="collection-settings-error"]')).toBeNull()
  })

  function mountSheet(onClose: () => void) {
    mountTree(
      <MemoryRouter initialEntries={['/library/col-1']}>
        <Routes>
          <Route path="/library/:id" element={<CollectionSettingsSheet open onClose={onClose} />} />
        </Routes>
      </MemoryRouter>,
    )
  }

  it('asks before discarding edited collection settings and stays until Discard', async () => {
    mocks.loadEditorSnapshot.mockResolvedValue(snapshot())
    const onClose = vi.fn()
    mountSheet(onClose)
    await waitForDom(domFinishedLoading)
    setControlValue(document.getElementById('ce-title') as HTMLInputElement, 'Half-renamed')

    const dialog = () => document.querySelector('[role="dialog"][aria-label="Discard changes?"]')
    const dialogButton = (name: string) => {
      const button = [...(dialog()?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
        .find((candidate) => candidate.textContent?.trim() === name)
      if (!button) throw new Error(`missing button ${name}`)
      return button
    }
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    await waitForDom(() => dialog() != null)
    expect(dialog()?.textContent).toContain('unsaved changes')
    expect(onClose).not.toHaveBeenCalled()
    expect(document.querySelector('[data-testid="collection-settings"]')).not.toBeNull()

    act(() => { dialogButton('Cancel').click() })
    await waitForDom(() => dialog() == null)
    expect(document.querySelector('[data-testid="collection-settings"]')).not.toBeNull()
    expect(onClose).not.toHaveBeenCalled()

    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    await waitForDom(() => dialog() != null)
    await act(async () => { dialogButton('Discard').click() })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes an untouched settings sheet without asking', async () => {
    mocks.loadEditorSnapshot.mockResolvedValue(snapshot())
    const onClose = vi.fn()
    mountSheet(onClose)
    await waitForDom(domFinishedLoading)
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[aria-label="Discard changes?"]')).toBeNull()
  })

  it('keeps publication and metadata drafts after CSRF recovery and retries against the fresh fence', async () => {
    const fresh = snapshot({ collection: { ...snapshot().collection, etag: '"c-fresh"' } })
    // Endpoint state: the session's CSRF token is rejected once, and the
    // session refresh the editor performs against it re-reads the collection
    // with the fresh fence; the retry then applies the same draft.
    let serverSnapshot = snapshot()
    let csrfRejected = false
    mocks.loadEditorSnapshot.mockImplementation(() => Promise.resolve(serverSnapshot))
    mocks.updateCollection.mockImplementation(() => {
      if (!csrfRejected) {
        csrfRejected = true
        serverSnapshot = fresh
        return Promise.reject(apiError(403, 'csrf_failed', 'user_action'))
      }
      return Promise.resolve({
        collection: {
          ...fresh.collection,
          title: 'Unsaved title',
          visibility: 'unlisted',
          publicationSlug: 'kept-slug',
          publishedAt: '2026-07-24T00:00:00.000Z',
        },
      })
    })
    renderEditor()
    await waitForDom(domFinishedLoading)

    setControlValue(document.getElementById('ce-title') as HTMLInputElement, 'Unsaved title')
    act(() => findButtonByName('Unlisted').click())
    setControlValue(document.getElementById('ce-publication-slug') as HTMLInputElement, 'kept-slug')
    submit('ce-title')
    await waitForDom(domFinishedLoading)

    expect(mocks.auth.refreshSession).toHaveBeenCalledTimes(1)
    expect((document.getElementById('ce-title') as HTMLInputElement).value).toBe('Unsaved title')
    expect((document.getElementById('ce-publication-slug') as HTMLInputElement).value).toBe('kept-slug')
    expect(document.body.textContent).toContain('Session refreshed. Your unsaved form values were kept')

    submit('ce-title')
    await waitForDom(domFinishedLoading)
    const expectedBody = expect.objectContaining({
      title: 'Unsaved title', visibility: 'unlisted', publicationSlug: 'kept-slug',
    })
    expect(mocks.updateCollection).toHaveBeenNthCalledWith(1, 'col-1', expectedBody, '"c-1"', expect.any(Object))
    expect(mocks.updateCollection).toHaveBeenNthCalledWith(2, 'col-1', expectedBody, '"c-fresh"', expect.any(Object))
  })

  it('aborts and ignores a collection mutation that resolves after route navigation', async () => {
    const update = deferred<{ collection: EditorSnapshot['collection'] }>()
    const second = snapshot({
      collection: { ...snapshot().collection, id: 'col-2', title: 'Second collection', rootNodeId: 'root-2' },
      root: { ...snapshot().root, id: 'root-2', collectionId: 'col-2' },
      nodes: [],
    })
    mocks.loadEditorSnapshot.mockImplementation((id: string) => Promise.resolve(id === 'col-2' ? second : snapshot()))
    mocks.updateCollection.mockReturnValueOnce(update.promise)
    renderEditor(); await waitForDom(domFinishedLoading)
    setControlValue(document.getElementById('ce-title') as HTMLInputElement, 'Late title from first collection')
    submit('ce-title')
    const signal = mocks.updateCollection.mock.calls[0]![3].signal as AbortSignal
    act(() => document.querySelector<HTMLAnchorElement>('[data-testid="switch-collection"]')!.click())
    await waitForDom(domFinishedLoading)
    expect(signal.aborted).toBe(true)
    expect((document.getElementById('ce-title') as HTMLInputElement).value).toBe('Second collection')
    await act(async () => {
      update.resolve({ collection: { ...snapshot().collection, title: 'Late title from first collection' } })
      await update.promise
    })
    expect((document.getElementById('ce-title') as HTMLInputElement).value).toBe('Second collection')
    expect(mocks.success).not.toHaveBeenCalledWith('Collection settings saved')
    // The route switch reads the collection it navigated to exactly once —
    // StrictMode's second mount read of col-1 is the only duplicate — so a
    // refetch of the abandoned or the new collection fails here.
    const requestedIds = mocks.loadEditorSnapshot.mock.calls.map(([id]) => id)
    expect(new Set(requestedIds)).toEqual(new Set(['col-1', 'col-2']))
    expect(requestedIds.filter((id) => id === 'col-2')).toHaveLength(1)
    expect(requestedIds.at(-1)).toBe('col-2')
  })

  it('binds publication field errors to the slug input, focuses it, and clears on edit', async () => {
    mocks.loadEditorSnapshot.mockResolvedValue(snapshot())
    mocks.updateCollection.mockRejectedValueOnce(new ProductApiError({
      status: 422,
      code: 'invalid_document',
      message: 'Slug is already claimed',
      recovery: 'user_action',
      fieldErrors: [{ path: '/publicationSlug', code: 'conflict', message: 'This slug is already in use.' }],
    }))
    renderEditor()
    await waitForDom(domFinishedLoading)
    act(() => findButtonByName('Public').click())
    const slug = document.getElementById('ce-publication-slug') as HTMLInputElement
    setControlValue(slug, 'claimed-slug')
    submit('ce-title')
    await waitForDom(domFinishedLoading)

    expect(slug.getAttribute('aria-invalid')).toBe('true')
    expect(slug.getAttribute('aria-describedby')).toBe('ce-publication-slug-error')
    expect(document.getElementById('ce-publication-slug-error')?.getAttribute('role')).toBe('alert')
    expect(document.getElementById('ce-publication-slug-error')?.textContent).toContain('already in use')
    expect(document.activeElement).toBe(slug)
    expect(slug.value).toBe('claimed-slug')

    setControlValue(slug, 'available-slug')
    expect(slug.hasAttribute('aria-invalid')).toBe(false)
    expect(document.getElementById('ce-publication-slug-error')).toBeNull()
  })

  it('validates publication slugs locally and hides owner controls without update capability', async () => {
    // Endpoint state: the collection is served with publication capability
    // until the account loses it for the remount below — no dependence on how
    // many times a mount reads.
    let canManagePublication = true
    mocks.loadEditorSnapshot.mockImplementation(() => Promise.resolve(snapshot({
      // An editor can still update ordinary metadata without managing publication.
      capabilities: { ...snapshot().capabilities, updateCollection: true, managePublication: canManagePublication },
    })))
    renderEditor()
    await waitForDom(domFinishedLoading)
    act(() => findButtonByName('Unlisted').click())
    setControlValue(document.getElementById('ce-publication-slug') as HTMLInputElement, 'bad slug')
    submit('ce-title')
    expect(mocks.updateCollection).not.toHaveBeenCalled()
    expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining('lowercase slug'))

    cleanup()
        document.body.innerHTML = '<div id="test-root"></div>'
    canManagePublication = false
    renderEditor()
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('fieldset')).toBeNull()
  })

  it('fails closed and routes to the login page when authentication is lost during loading', async () => {
    // Every read of the collection is rejected as unauthenticated.
    mocks.loadEditorSnapshot.mockRejectedValue(
      apiError(401, 'authentication_required', 'user_action'),
    )
    renderEditor()
    await waitForDom(domFinishedLoading)

    // F3: the legacy OIDC navigation symbol is gone; the auth-required load
    // failure routes to the Better Auth login page with the same-origin
    // returnTo (the editor route unmounts — the tree never renders).
    expect(document.querySelector('[data-testid="login-destination"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="collection-settings-tree"]')).toBeNull()
    expect(document.querySelector('[data-testid="collection-settings-auth-required"]')).toBeNull()
    // Fail closed must not become a retry loop: every read targets the one
    // collection and none is issued after the 401 routed the editor away.
    expect(new Set(mocks.loadEditorSnapshot.mock.calls.map(([id]) => id))).toEqual(new Set(['col-1']))
    const readsAtRedirect = mocks.loadEditorSnapshot.mock.calls.length
    await settled()
    expect(mocks.loadEditorSnapshot).toHaveBeenCalledTimes(readsAtRedirect)
  })

  it('offers explicit error recovery and retries the load on activation', async () => {
    const retry = deferred<EditorSnapshot>()
    // Endpoint state: unreachable until the visitor activates Retry, which
    // starts the one read that then serves the snapshot.
    let reachable = false
    mocks.loadEditorSnapshot.mockImplementation(() => (
      reachable ? retry.promise : Promise.reject(new Error('network unavailable'))
    ))
    renderEditor()
    await waitForDom(domFinishedLoading)

    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Try again in a moment.')
    const readsBeforeRetry = mocks.loadEditorSnapshot.mock.calls.length
    reachable = true
    act(() => findButtonByName('Try again').click())
    expect(document.querySelector('[data-testid="collection-settings-loading"]')).not.toBeNull()
    await act(async () => {
      retry.resolve(snapshot())
      await retry.promise
    })

    // Activation issues exactly one more read — recovery is not an automatic
    // retry loop — and it renders the recovered snapshot.
    expect(mocks.loadEditorSnapshot.mock.calls.length).toBe(readsBeforeRetry + 1)
    expect(document.querySelector('[data-testid="collection-settings"]')).not.toBeNull()
  })

  it('resolves delete targets from the live snapshot, not a captured node', () => {
    const snap = snapshot()
    expect(resolveEditableNode(snap, 'node-first')?.etag).toBe('"n-1"')
    expect(resolveEditableNode(snap, 'root-1')).toBeNull()
    const live = snapshot({
      collection: { ...snap.collection, contentEtag: '"cc-99"' },
      nodes: snap.nodes.map((n) => n.id === 'node-first' ? { ...n, etag: '"n-99"' } : n),
    })
    expect(etagForDelete(live, resolveEditableNode(live, 'node-first')!)).toEqual({
      nodeEtag: '"n-99"', contentEtag: '"cc-99"',
    })
  })

  it('exposes session and signed-out states without issuing editor reads', () => {
    mocks.auth.bootstrapping = true
    renderEditor()
    expect(document.querySelector('[data-testid="collection-settings-loading"]')?.textContent).toContain(
      'Checking session',
    )
    expect(mocks.loadEditorSnapshot).not.toHaveBeenCalled()
  })

  it('provides an operable sign-in action when the user is signed out', () => {
    mocks.auth.isLoggedIn = false
    renderEditor()

    // F3: the legacy OIDC entry is gone; the sign-in action is the login
    // route Link carrying the same-origin returnTo.
    expect(document.querySelector('[data-testid="collection-settings-auth-required"]')).not.toBeNull()
    const login = document.querySelector<HTMLAnchorElement>(
      'a[href="/login?returnTo=%2Flibrary%2Fcol-1%3Fcollection%3Dedit"]',
    )
    expect(login).not.toBeNull()
    expect(login?.textContent).toContain('Sign in')
    expect(document.body.textContent).not.toContain('Continue with OIDC')
    expect(mocks.loadEditorSnapshot).not.toHaveBeenCalled()
  })
})
