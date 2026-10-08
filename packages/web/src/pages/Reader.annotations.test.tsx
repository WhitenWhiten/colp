// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductApiError } from '../api/errors'
import type { AnnotationView, EditorSnapshot } from '../api/types'
import { Reader } from './Reader'
import { cleanup, domFinishedLoading, mountTree, settled, waitForDom } from '../test/render'

const NODE_ID = 'nd-col-u01-01-001'
const NEXT_ID = 'nd-col-u01-01-002'

const mocks = vi.hoisted(() => ({
  loadAnnotations: vi.fn(),
  getAnnotation: vi.fn(),
  createAnnotation: vi.fn(),
  updateAnnotation: vi.fn(),
  deleteAnnotation: vi.fn(),
  abandonAnnotationIntent: vi.fn(),
  loadEditorSnapshot: vi.fn(),
  toast: vi.fn(),
}))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    isLive: (flag: string) => flag === 'annotations',
    isReadableReplicaExposureEnabled: () => false,
    productClient: {
      ...actual.productClient,
      loadAnnotations: mocks.loadAnnotations,
      getAnnotation: mocks.getAnnotation,
      createAnnotation: mocks.createAnnotation,
      updateAnnotation: mocks.updateAnnotation,
      deleteAnnotation: mocks.deleteAnnotation,
      abandonAnnotationIntent: mocks.abandonAnnotationIntent,
      loadEditorSnapshot: mocks.loadEditorSnapshot,
    },
  }
})

vi.mock('../components/AppToast', () => ({
  useToast: () => ({ toast: mocks.toast, success: mocks.toast, error: mocks.toast }),
}))

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ isLoggedIn: true, bootstrapping: false }),
}))

type Deferred<T> = {
  promise: Promise<T>
  resolve(value: T): void
  reject(reason: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function annotation(overrides: Partial<AnnotationView> = {}): AnnotationView {
  return {
    id: 'annotation-note-1',
    collectionId: 'collection-1',
    subject: { type: 'node', id: 'nd-col-u01-01-001' },
    type: 'note',
    format: 'plain',
    value: 'Server note',
    visibility: 'private',
    creator: { id: 'https://known.test/profiles/mira', name: 'Mira' },
    provenance: { kind: 'human' },
    revision: 'revision-1',
    createdAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-07-25T00:00:00.000Z',
    extensions: {},
    ...overrides,
  }
}

/* The annotations endpoint answers per subject resource. The StrictMode mount
   invokes the load effect twice for the SAME resource and a later navigation
   asks for another one, so the fixture is keyed on the request rather than on
   an invocation count. */
function serveAnnotations(
  byResource: Record<string, AnnotationView[] | Promise<AnnotationView[]>>,
): void {
  mocks.loadAnnotations.mockImplementation(
    async (_collectionId: string, subject: { resourceId: string }) => byResource[subject.resourceId] ?? [],
  )
}

function byButton(name: string): HTMLButtonElement {
  const result = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === name)
  if (!result) throw new Error(`missing button: ${name}`)
  return result
}

/* The confirm action now names the same verb as the trigger ("Delete note"),
   so the click must be scoped to the open dialog. */
function dialogButton(name: string): HTMLButtonElement {
  const result = [...(document.querySelector('[role="dialog"]')?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    .find((button) => button.textContent?.trim() === name)
  if (!result) throw new Error(`missing dialog button: ${name}`)
  return result
}

/* Highlight controls are icon-only: their accessible name lives on aria-label
   ("Highlight paragraph" / "Remove highlight"), so match by role + name. */
function highlightControls(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('button')]
    .filter((button) => /highlight/i.test(button.getAttribute('aria-label') ?? button.textContent ?? ''))
}

function setValue(control: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  setter?.call(control, value)
  control.dispatchEvent(new Event('input', { bubbles: true }))
}

function editor(): EditorSnapshot {
  return {
    collection: {
      id: 'collection-1', title: 'Reader collection', kind: 'bookmarks', summary: '',
      visibility: 'private', allowSearchIndexing: false, rootNodeId: 'root', publicationSlug: 'reader-notes',
      publishedAt: null, revision: 'c1', etag: '"c1"', contentRevision: 'cc1', contentEtag: '"cc1"',
      policyRevision: 'p1', policyEtag: '"p1"', createdAt: '', updatedAt: '',
    },
    root: {
      id: 'root', collectionId: 'collection-1', kind: 'folder', folderRole: 'root', parentId: null,
      position: null, title: 'Root', description: null, tags: [], visibility: 'inherit', revision: 'rr',
      etag: '"rr"', readOnly: false, readOnlyReason: null, childrenRevision: 'cr', childrenEtag: '"cr"',
      createdAt: '2026-07-25T00:00:00.000Z', updatedAt: '2026-07-25T00:00:00.000Z',
    },
    nodes: [
      {
        id: NODE_ID, collectionId: 'collection-1', kind: 'bookmark', title: '3Blue1Brown · 神经网络可视化',
        url: 'https://www.youtube.com/@3blue1brown', description: 'Course entry', tags: ['youtube'],
        visibility: 'inherit', revision: 'n1', etag: '"n1"', parentId: 'root', position: 'a',
        readOnly: false, readOnlyReason: null, createdAt: '2026-07-25T00:00:00.000Z',
        updatedAt: '2026-07-25T00:00:00.000Z',
      },
      {
        id: NEXT_ID, collectionId: 'collection-1', kind: 'bookmark', title: 'Next bookmark',
        url: 'https://example.test/next', description: null, tags: [], visibility: 'inherit',
        revision: 'n2', etag: '"n2"', parentId: 'root', position: 'b', readOnly: false, readOnlyReason: null,
        createdAt: '2026-07-25T00:00:00.000Z', updatedAt: '2026-07-25T00:00:00.000Z',
      },
    ],
    capabilities: {
      updateCollection: true, managePublication: true, createNode: true,
      updateNode: true, moveNode: true, deleteNode: true,
    },
    page: {
      snapshotId: 's', contentRevision: 'cc1', policyRevision: 'p1', comparatorVersion: 'v1',
      expiresAt: '', returnedCount: 2, hasMore: false, nextCursor: null,
    },
  } as EditorSnapshot
}

describe('Reader canonical Annotation workflow', () => {

  beforeEach(() => {
    vi.clearAllMocks()
    document.body.innerHTML = '<div id="test-root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    mocks.loadAnnotations.mockResolvedValue([])
    mocks.loadEditorSnapshot.mockResolvedValue(editor())
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  function renderReader(path = `/read/${NODE_ID}?collectionId=collection-1&subjectType=node`): void {
    const host = document.getElementById('test-root')
    if (!host) throw new Error('test host missing')
    mountTree(
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/read/:resourceId" element={<Reader />} />
          </Routes>
        </MemoryRouter>,
      )
  }

  it('loads every note/highlight through the generated client and renders untrusted values as text', async () => {
    mocks.loadAnnotations.mockResolvedValue([
      annotation({ value: '<img src=x onerror=alert(1)>', format: 'html' }),
      annotation({ id: 'highlight-1', type: 'highlight', value: 'orientation-0', revision: 'revision-h1' }),
    ])
    renderReader()
    await waitForDom(domFinishedLoading)

    expect(mocks.loadAnnotations).toHaveBeenCalledWith(
      'collection-1',
      { resourceType: 'node', resourceId: NODE_ID },
      expect.objectContaining({ maxRetries: 0, signal: expect.any(AbortSignal) }),
    )
    const note = document.querySelector<HTMLTextAreaElement>('[aria-label="Private note"]')
    expect(note?.value).toBe('<img src=x onerror=alert(1)>')
    expect(document.querySelector('img[src="x"]')).toBeNull()
    expect(document.querySelector('[data-testid="annotation-workspace"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="annotation-save-state"]')?.getAttribute('aria-live')).toBe('polite')
    expect(document.querySelector('h1')?.textContent).toBe('3Blue1Brown · 神经网络可视化')
    expect(document.body.textContent).not.toContain('Spacing as a system')
    expect(document.querySelector('[data-testid="reader-paragraph"]')).toBeNull()
    expect(highlightControls()).toEqual([])
    // Exposure is off in this suite: the article column says so instead of
    // rendering an empty body.
    expect(document.querySelector('[data-testid="reader-replica-state"]')?.getAttribute('data-replica-status')).toBe('flag-off')
  })

  it('keeps one intent and command allocation across an unknown update replay', async () => {
    mocks.loadAnnotations.mockResolvedValue([annotation()])
    mocks.updateAnnotation
      .mockRejectedValueOnce(new ProductApiError({
        status: 0, code: 'transport_error', message: 'commit outcome unknown',
        recovery: 'same_request', sameRequestRetrySafe: true,
      }))
      .mockResolvedValueOnce(annotation({ value: 'Draft after network loss', revision: 'revision-2' }))
    renderReader()
    await waitForDom(domFinishedLoading)

    const note = document.querySelector<HTMLTextAreaElement>('[aria-label="Private note"]')!
    act(() => setValue(note, 'Draft after network loss'))
    act(() => byButton('Save note').click())
    await waitForDom(domFinishedLoading)

    expect(document.querySelector('[data-save-state="unknown"]')?.textContent).toContain('save may not have completed')
    expect(note.disabled).toBe(true)
    act(() => byButton('Retry save').click())
    await waitForDom(domFinishedLoading)

    const firstOptions = mocks.updateAnnotation.mock.calls[0]?.[4]
    const replayOptions = mocks.updateAnnotation.mock.calls[1]?.[4]
    expect(replayOptions.intentId).toBe(firstOptions.intentId)
    expect(mocks.updateAnnotation).toHaveBeenNthCalledWith(
      2, 'collection-1', 'annotation-note-1', { value: 'Draft after network loss', format: 'plain' },
      '"revision-1"', expect.objectContaining({ clearIntentOnSuccess: false, maxRetries: 0 }),
    )
    expect(document.querySelector('[data-save-state="saved"]')?.textContent).toContain('Saved')
    expect(note.disabled).toBe(false)
  })

  it('never edits a public annotation through the private note editor', async () => {
    mocks.loadAnnotations.mockResolvedValue([annotation({ id: 'public-note', visibility: 'public', value: 'Published' })])
    mocks.createAnnotation.mockResolvedValue(annotation({ value: 'Only for me' }))
    renderReader()
    await waitForDom(domFinishedLoading)
    const note = document.querySelector<HTMLTextAreaElement>('[aria-label="Private note"]')!
    expect(note.value).toBe('')
    act(() => setValue(note, 'Only for me'))
    act(() => byButton('Save note').click())
    await waitForDom(domFinishedLoading)
    expect(mocks.updateAnnotation).not.toHaveBeenCalled()
    expect(mocks.createAnnotation).toHaveBeenCalledWith(
      'collection-1', expect.anything(),
      expect.objectContaining({ type: 'note', value: 'Only for me', visibility: 'private' }),
      expect.anything(),
    )
  })

  it('keeps a private draft private when conflict refresh reveals a published note', async () => {
    mocks.loadAnnotations.mockResolvedValue([annotation()])
    mocks.updateAnnotation.mockRejectedValueOnce(new ProductApiError({
      status: 412, code: 'precondition_failed', message: 'The note changed',
      recovery: 'refresh', sameRequestRetrySafe: false,
    }))
    mocks.getAnnotation.mockResolvedValue(annotation({ visibility: 'public', revision: 'published' }))
    mocks.createAnnotation.mockResolvedValue(annotation({ id: 'new-private', value: 'Private draft' }))
    renderReader()
    await waitForDom(domFinishedLoading)
    const note = document.querySelector<HTMLTextAreaElement>('[aria-label="Private note"]')!
    act(() => setValue(note, 'Private draft'))
    act(() => byButton('Save note').click())
    await waitForDom(domFinishedLoading)
    act(() => byButton('Save my version').click())
    await waitForDom(domFinishedLoading)
    expect(mocks.updateAnnotation).toHaveBeenCalledTimes(1)
    expect(mocks.createAnnotation).toHaveBeenCalledWith('collection-1', expect.anything(),
      expect.objectContaining({ value: 'Private draft', visibility: 'private' }), expect.anything())
  })

  it('preserves markdown when updating an existing note', async () => {
    mocks.loadAnnotations.mockResolvedValue([annotation({ format: 'markdown', value: '## Existing' })])
    mocks.updateAnnotation.mockResolvedValueOnce(annotation({ format: 'markdown', value: '## Edited' }))
    renderReader()
    await waitForDom(domFinishedLoading)
    const note = document.querySelector<HTMLTextAreaElement>('[aria-label="Private note"]')!
    act(() => setValue(note, '## Edited'))
    act(() => byButton('Save note').click())
    await waitForDom(domFinishedLoading)
    expect(mocks.updateAnnotation.mock.calls[0]?.[2]).toMatchObject({ value: '## Edited', format: 'markdown' })
  })

  it('uses markdown when creating a new note', async () => {
    mocks.loadAnnotations.mockResolvedValue([])
    mocks.createAnnotation.mockResolvedValueOnce(annotation({ format: 'markdown', value: '## New' }))
    renderReader()
    await waitForDom(domFinishedLoading)
    const fresh = document.querySelector<HTMLTextAreaElement>('[aria-label="Private note"]')!
    act(() => setValue(fresh, '## New'))
    act(() => byButton('Save note').click())
    await waitForDom(domFinishedLoading)
    expect(mocks.createAnnotation.mock.calls[0]?.[2]).toMatchObject({ value: '## New', format: 'markdown' })
  })

  it('does not offer Highlight controls without in-app article paragraphs', async () => {
    renderReader()
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="reader-paragraph"]')).toBeNull()
    expect(highlightControls()).toEqual([])
    expect(mocks.createAnnotation).not.toHaveBeenCalled()
  })

  it('refreshes a stale Annotation before offering an explicit merge as a new intent', async () => {
    mocks.loadAnnotations.mockResolvedValue([annotation()])
    mocks.updateAnnotation
      .mockRejectedValueOnce(new ProductApiError({
        status: 412, code: 'precondition_failed', message: 'stale',
        recovery: 'refresh_and_retry', currentEtag: '"revision-server"',
      }))
      .mockResolvedValueOnce(annotation({ value: 'My draft', revision: 'revision-3' }))
    mocks.getAnnotation.mockResolvedValueOnce(annotation({ value: 'Concurrent server note', revision: 'revision-2' }))
    renderReader()
    await waitForDom(domFinishedLoading)

    const note = document.querySelector<HTMLTextAreaElement>('[aria-label="Private note"]')!
    act(() => setValue(note, 'My draft'))
    act(() => byButton('Save note').click())
    await waitForDom(domFinishedLoading)

    expect(mocks.getAnnotation).toHaveBeenCalledWith(
      'collection-1', 'annotation-note-1', expect.objectContaining({ signal: expect.any(AbortSignal), maxRetries: 0 }),
    )
    expect(note.value).toBe('My draft')
    expect(document.querySelector('[data-save-state="stale"]')?.textContent).toContain('server version changed')
    const firstIntent = mocks.updateAnnotation.mock.calls[0]?.[4]?.intentId
    act(() => byButton('Save my version').click())
    await waitForDom(domFinishedLoading)
    expect(mocks.updateAnnotation.mock.calls[1]?.[3]).toBe('"revision-2"')
    expect(mocks.updateAnnotation.mock.calls[1]?.[4]?.intentId).not.toBe(firstIntent)
  })

  it('blocks blind command-reuse retries until the user starts a new intent', async () => {
    mocks.loadAnnotations.mockResolvedValue([annotation()])
    mocks.updateAnnotation
      .mockRejectedValueOnce(new ProductApiError({
        status: 409, code: 'command_id_reused', message: 'reused', recovery: 'user_action',
      }))
      .mockResolvedValueOnce(annotation({ value: 'Changed', revision: 'revision-2' }))
    renderReader()
    await waitForDom(domFinishedLoading)
    const note = document.querySelector<HTMLTextAreaElement>('[aria-label="Private note"]')!
    act(() => setValue(note, 'Changed'))
    act(() => byButton('Save note').click())
    await waitForDom(domFinishedLoading)

    expect(document.querySelector('[data-save-state="conflict"]')?.textContent).toContain('could not be completed')
    expect(document.querySelector('button')?.textContent).not.toBe('Retry save')
    const firstIntent = mocks.updateAnnotation.mock.calls[0]?.[4]?.intentId
    act(() => byButton('Start new save').click())
    await waitForDom(domFinishedLoading)
    expect(mocks.abandonAnnotationIntent).toHaveBeenCalledWith(firstIntent)
    expect(mocks.updateAnnotation.mock.calls[1]?.[4]?.intentId).not.toBe(firstIntent)
  })

  it('uses stable delete intents and restores focus after deletion', async () => {
    mocks.loadAnnotations.mockResolvedValue([annotation()])
    mocks.deleteAnnotation.mockResolvedValueOnce({
      receipt: {
        resourceType: 'annotation', targetId: 'annotation-note-1', collectionId: 'collection-1', scope: 'single',
        deletedAt: '2026-07-25T00:10:00.000Z', deleteRevision: 'revision-2', operationId: 'operation-1',
        affectedCount: 1, purgeAfter: '2026-08-24T00:10:00.000Z',
      },
      fence: { contentRevision: 'content-2', policyRevision: 'policy-1' },
    })
    renderReader()
    await waitForDom(domFinishedLoading)

    const deleteButton = byButton('Delete note')
    deleteButton.focus()
    act(() => deleteButton.click())
    // R9-19: the shared destructive confirm (Modal tone="danger") gates the
    // delete instead of window.confirm.
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog?.textContent).toContain('Delete this private note?')
    expect(dialog?.textContent).toContain("This can't be undone.")
    act(() => dialogButton('Delete note').click())
    await waitForDom(domFinishedLoading)
    expect(mocks.deleteAnnotation).toHaveBeenCalledWith(
      'collection-1', 'annotation-note-1', '"revision-1"',
      expect.objectContaining({ clearIntentOnSuccess: false, maxRetries: 0, signal: expect.any(AbortSignal) }),
    )
    expect((document.querySelector('[aria-label="Private note"]') as HTMLTextAreaElement).value).toBe('')
    expect(document.activeElement).toBe(document.querySelector('[aria-label="Private note"]'))
  })

  it('replays an unknown delete with the same frozen revision and intent', async () => {
    mocks.loadAnnotations.mockResolvedValue([annotation()])
    mocks.deleteAnnotation
      .mockRejectedValueOnce(new ProductApiError({
        status: 0, code: 'transport_error', message: 'delete outcome unknown',
        recovery: 'same_request', sameRequestRetrySafe: true,
      }))
      .mockResolvedValueOnce({
        receipt: {
          resourceType: 'annotation', targetId: 'annotation-note-1', collectionId: 'collection-1', scope: 'single',
          deletedAt: '2026-07-25T00:10:00.000Z', deleteRevision: 'revision-2', operationId: 'operation-1',
          affectedCount: 1, purgeAfter: '2026-08-24T00:10:00.000Z',
        },
        fence: { contentRevision: 'content-2', policyRevision: 'policy-1' },
      })
    renderReader()
    await waitForDom(domFinishedLoading)

    act(() => byButton('Delete note').click())
    act(() => dialogButton('Delete note').click())
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-save-state="unknown"]')?.textContent).toContain('delete may not have completed')
    act(() => byButton('Retry delete').click())
    await waitForDom(domFinishedLoading)
    const first = mocks.deleteAnnotation.mock.calls[0]
    const replay = mocks.deleteAnnotation.mock.calls[1]
    expect(replay![2]).toBe(first![2])
    expect(replay![3].intentId).toBe(first![3].intentId)
  })

  it('aborts all old resource work, ignores late results, and protects dirty browser/site navigation', async () => {
    const oldLoad = deferred<AnnotationView[]>()
    const nextLoad = deferred<AnnotationView[]>()
    serveAnnotations({ [NODE_ID]: oldLoad.promise, [NEXT_ID]: nextLoad.promise })
    renderReader()
    await waitForDom(() => [...document.querySelectorAll('a')].some((link) => link.getAttribute('href')?.startsWith('/read/')))
    // The request genuinely in flight at navigation time is the last one issued
    // for this resource. StrictMode already aborted the first mount invocation
    // in its own cleanup, so asserting on calls[0] would pass for free.
    const issued = mocks.loadAnnotations.mock.calls
    const oldSignal = issued[issued.length - 1]?.[2]?.signal as AbortSignal
    expect(oldSignal.aborted).toBe(false)

    const next = [...document.querySelectorAll<HTMLAnchorElement>('a')]
      .find((link) => link.getAttribute('href')?.startsWith('/read/'))
    if (!next) throw new Error('adjacent resource link missing')
    act(() => next.click())
    // Not dirty yet: navigation proceeds without the leave-confirm modal.
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await settled()
    expect(oldSignal.aborted).toBe(true)
    await act(async () => nextLoad.resolve([annotation({ subject: { type: 'node', id: NEXT_ID }, value: 'New resource note' })]))
    expect((document.querySelector('[aria-label="Private note"]') as HTMLTextAreaElement).value).toBe('New resource note')
    await act(async () => oldLoad.resolve([annotation({ value: 'Late old note' })]))
    expect((document.querySelector('[aria-label="Private note"]') as HTMLTextAreaElement).value).not.toBe('Late old note')

    const note = document.querySelector<HTMLTextAreaElement>('[aria-label="Private note"]')!
    act(() => setValue(note, 'Unsaved navigation draft'))
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    const library = document.querySelector<HTMLAnchorElement>('a[href="/library"]')!
    act(() => library.click())
    // R9-19: the guard opens the shared confirm modal instead of
    // window.confirm — and the click stays blocked until it resolves.
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog?.textContent).toContain('unsaved changes on this page')
    const leave = [...(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
      .find((candidate) => candidate.textContent?.trim() === 'Discard')
    expect(leave?.className).toContain('btn-danger')
  })

  it('aborts an in-flight save on resource navigation and rejects its late completion', async () => {
    const save = deferred<AnnotationView>()
    serveAnnotations({ [NODE_ID]: [annotation()], [NEXT_ID]: [] })
    mocks.updateAnnotation.mockReturnValueOnce(save.promise)
    renderReader()
    await waitForDom(domFinishedLoading)

    const note = document.querySelector<HTMLTextAreaElement>('[aria-label="Private note"]')!
    act(() => setValue(note, 'Pending old-resource save'))
    act(() => byButton('Save note').click())
    await waitForDom(domFinishedLoading)
    const saveSignal = mocks.updateAnnotation.mock.calls[0]?.[4]?.signal as AbortSignal
    const adjacent = [...document.querySelectorAll<HTMLAnchorElement>('a')]
      .find((link) => link.getAttribute('href')?.startsWith('/read/'))
    if (!adjacent) throw new Error('adjacent resource link missing')
    act(() => adjacent.click())
    // The leave guard holds the click behind the shared confirm modal.
    await act(async () => byButton('Discard').click())
    await waitForDom(domFinishedLoading)
    expect(saveSignal.aborted).toBe(true)
    expect((document.querySelector('[aria-label="Private note"]') as HTMLTextAreaElement).value).toBe('')

    await act(async () => save.resolve(annotation({ value: 'Late save must not win', revision: 'revision-late' })))
    expect((document.querySelector('[aria-label="Private note"]') as HTMLTextAreaElement).value).toBe('')
  })

  it('ignores a late stale-refresh result after navigating to another resource', async () => {
    const staleRefresh = deferred<AnnotationView>()
    serveAnnotations({ [NODE_ID]: [annotation()], [NEXT_ID]: [] })
    mocks.updateAnnotation.mockRejectedValueOnce(new ProductApiError({
      status: 412, code: 'precondition_failed', message: 'stale', recovery: 'refresh_and_retry',
    }))
    mocks.getAnnotation.mockReturnValueOnce(staleRefresh.promise)
    renderReader()
    await waitForDom(domFinishedLoading)

    const note = document.querySelector<HTMLTextAreaElement>('[aria-label="Private note"]')!
    act(() => setValue(note, 'Old-resource draft'))
    act(() => byButton('Save note').click())
    await waitForDom(domFinishedLoading)
    const refreshSignal = mocks.getAnnotation.mock.calls[0]?.[2]?.signal as AbortSignal
    const adjacent = [...document.querySelectorAll<HTMLAnchorElement>('a')]
      .find((link) => link.getAttribute('href')?.startsWith('/read/'))
    if (!adjacent) throw new Error('adjacent resource link missing')
    act(() => adjacent.click())
    await act(async () => byButton('Discard').click())
    await waitForDom(domFinishedLoading)
    expect(refreshSignal.aborted).toBe(true)

    await act(async () => staleRefresh.resolve(annotation({ value: 'Late stale value', revision: 'revision-late' })))
    expect(document.querySelector('[data-save-state="saved"]')).not.toBeNull()
    expect((document.querySelector('[aria-label="Private note"]') as HTMLTextAreaElement).value).toBe('')
  })
})
