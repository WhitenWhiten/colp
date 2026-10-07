// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearRouteCache } from '../lib/routeCache'
import type { EditorSnapshot, PublicCollectionSnapshot, RelationView } from '../api/types'
import { ProductApiError } from '../api/errors'
import { ResourceDetail } from './ResourceDetail'
import { cleanup, domFinishedLoading, findButtonByName, mountTree, waitForDom } from '../test/render'

const NODE_ID = 'nd-col-u01-01-001'
const mocks = vi.hoisted(() => ({
  loadEditorSnapshot: vi.fn(), loadPublicCollectionSnapshot: vi.fn(), loadRelations: vi.fn(), createRelation: vi.fn(),
  updateRelation: vi.fn(), deleteRelation: vi.fn(), abandonRelationIntent: vi.fn(),
  sequence: 0,
  auth: { isLoggedIn: true, bootstrapping: false },
}))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, isCommunityExposureEnabled: () => false, isLive: (flag: string) => flag === 'relations', productClient: {
    ...actual.productClient, loadEditorSnapshot: mocks.loadEditorSnapshot, loadPublicCollectionSnapshot: mocks.loadPublicCollectionSnapshot, loadRelations: mocks.loadRelations,
    createRelation: mocks.createRelation, updateRelation: mocks.updateRelation,
    deleteRelation: mocks.deleteRelation, abandonRelationIntent: mocks.abandonRelationIntent,
    newCommandId: () => `intent-${++mocks.sequence}`,
    mutationIntentKey: (scope: string, id: string) => `${scope}:${id}`,
  } }
})
vi.mock('../components/AppToast', () => ({ useToast: () => ({ toast: vi.fn(), success: vi.fn(), error: vi.fn() }) }))
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: { name: 'Dev', handle: 'dev', email: 'dev@test', initials: 'D', accountId: 'a', profileId: 'p' },
    isLoggedIn: mocks.auth.isLoggedIn,
    bootstrapping: mocks.auth.bootstrapping,
    logout: async () => {},
  }),
}))

const relation = (overrides: Partial<RelationView> = {}): RelationView => ({
  id: 'relation-out', collectionId: 'collection-detail', fromNodeId: 'nd-col-u01-01-001', toNodeId: 'same-title-b',
  type: 'related', label: '<img src=x onerror=alert(1)>', visibility: 'private', revision: 'r1',
  createdAt: '2026-07-25T00:00:00.000Z', updatedAt: '2026-07-25T00:00:00.000Z', extensions: {}, ...overrides,
})
const editor = (): EditorSnapshot => ({
  collection: { id: 'collection-detail', title: 'Relations', kind: 'bookmarks', summary: '', visibility: 'private', allowSearchIndexing: false, rootNodeId: 'root', publicationSlug: null, publishedAt: null, revision: 'c1', etag: '"c1"', contentRevision: 'cc1', contentEtag: '"cc1"', policyRevision: 'p1', policyEtag: '"p1"', createdAt: '', updatedAt: '' },
  root: { id: 'root', collectionId: 'collection-detail', kind: 'folder', folderRole: 'root', parentId: null, position: null, title: 'Root', description: null, tags: [], visibility: 'inherit', revision: 'rr', etag: '"rr"', readOnly: false, readOnlyReason: null, childrenRevision: 'cr', childrenEtag: '"cr"', createdAt: '2026-07-25T00:00:00.000Z', updatedAt: '2026-07-25T00:00:00.000Z' },
  nodes: [
    { id: 'nd-col-u01-01-001', collectionId: 'collection-detail', kind: 'bookmark', title: 'Current', url: 'https://current.test', description: null, tags: [], visibility: 'inherit', revision: 'n1', etag: '"n1"', parentId: 'root', position: 'a', readOnly: false, readOnlyReason: null, createdAt: '2026-07-25T00:00:00.000Z', updatedAt: '2026-07-25T00:00:00.000Z' },
    { id: 'same-title-a', collectionId: 'collection-detail', kind: 'bookmark', title: 'Same title', url: 'https://a.test', description: null, tags: [], visibility: 'inherit', revision: 'n2', etag: '"n2"', parentId: 'root', position: 'b', readOnly: false, readOnlyReason: null, createdAt: '2026-07-25T00:00:00.000Z', updatedAt: '2026-07-25T00:00:00.000Z' },
    { id: 'same-title-b', collectionId: 'collection-detail', kind: 'bookmark', title: 'Same title', url: 'https://b.test', description: null, tags: [], visibility: 'inherit', revision: 'n3', etag: '"n3"', parentId: 'root', position: 'c', readOnly: false, readOnlyReason: null, createdAt: '2026-07-25T00:00:00.000Z', updatedAt: '2026-07-25T00:00:00.000Z' },
  ], capabilities: { updateCollection: true, managePublication: true, createNode: true, updateNode: true, moveNode: true, deleteNode: true },
  page: { snapshotId: 's', contentRevision: 'cc1', policyRevision: 'p1', comparatorVersion: 'v1', expiresAt: '', returnedCount: 3, hasMore: false, nextCursor: null },
} as EditorSnapshot)

function published(): PublicCollectionSnapshot {
  return {
    collection: {
      id: 'collection-detail', slug: 'relations-path', title: 'Relations', summary: '',
      kind: 'bookmarks', rootNodeId: 'root',
      owner: { profileId: 'p', handle: 'dev', displayName: 'Dev', avatarUrl: null },
      updatedAt: '2026-07-25T00:00:00.000Z', access: 'public',
    },
    nodes: [
      { id: 'root', parentId: null, kind: 'root', title: 'Root', description: null, url: null, position: null },
      { id: NODE_ID, parentId: 'root', kind: 'bookmark', title: 'Current', url: 'https://current.test', description: null, position: 'a' },
      { id: 'same-title-a', parentId: 'root', kind: 'bookmark', title: 'Same title', url: 'https://a.test', description: null, position: 'b' },
      { id: 'same-title-b', parentId: 'root', kind: 'bookmark', title: 'Same title', url: 'https://b.test', description: null, position: 'c' },
    ],
    page: { cursor: null, hasMore: false, sequence: 1 },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

function change(select: HTMLSelectElement, value: string) { act(() => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })) }) }
function input(field: HTMLInputElement, value: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
function click(name: string) { const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.includes(name)); if (!button) throw new Error(`missing ${name}`); act(() => (button as HTMLButtonElement).click()) }
/* R9-19: destructive actions open the shared confirm modal (the render
   helper mounts its provider); click its button to resolve the promise. */
async function confirmModalClick(label: string) {
  await act(async () => {
    const dialog = document.querySelector('[role="dialog"]')
    const button = [...(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
      .find((candidate) => candidate.textContent?.trim() === label)
    if (!button) throw new Error(`confirm button missing: ${label}`)
    button.click()
    await Promise.resolve()
  })
}
/** The create form is a disclosure: open it before touching the endpoint select. */
async function openCreateForm() { click('Add relation'); await waitForDom(() => document.querySelector('[aria-label="Create relation"]') !== null) }

describe('Resource Detail Relation workflow', () => {
  beforeEach(() => {
    clearRouteCache()
    vi.clearAllMocks(); mocks.sequence = 0; mocks.auth.isLoggedIn = true; mocks.auth.bootstrapping = false; document.body.innerHTML = '<div id="test-root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    mocks.loadEditorSnapshot.mockResolvedValue(editor())
    mocks.loadRelations.mockImplementation((_c: string, query: { direction: string }) => Promise.resolve(query.direction === 'incoming'
      ? [relation({ id: 'relation-in', fromNodeId: 'same-title-a', toNodeId: NODE_ID, label: 'Incoming' })]
      : [relation()]))
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(published())
  })
  afterEach(() => { cleanup(); document.body.innerHTML = '' })
  function render() { mountTree(<MemoryRouter initialEntries={[`/r/${NODE_ID}?collectionId=collection-detail&subjectType=node&slug=relations-path`]}><Routes><Route path="/r/:id" element={<ResourceDetail />} /></Routes></MemoryRouter>) }

  it('shows both directions, binds duplicate titles by id, navigates endpoints, and renders label as text', async () => {
    render(); await waitForDom(domFinishedLoading)
    expect(mocks.loadRelations).toHaveBeenCalledWith('collection-detail', { nodeId: NODE_ID, direction: 'incoming' }, expect.any(Object))
    expect(mocks.loadRelations).toHaveBeenCalledWith('collection-detail', { nodeId: NODE_ID, direction: 'outgoing' }, expect.any(Object))
    expect(document.body.textContent).toContain('Incoming'); expect(document.body.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(document.querySelector('img[src="x"]')).toBeNull()
    expect(document.querySelector('a[href="/r/same-title-a?collectionId=collection-detail&subjectType=node"]')).not.toBeNull()
    await openCreateForm()
    const endpoint = document.querySelector<HTMLSelectElement>('[aria-label="Linked bookmark"]')!
    const sameTitleOptions = [...endpoint.options].filter((option) => option.text.includes('Same title'))
    expect(sameTitleOptions.map((option) => option.value)).toEqual(['same-title-a', 'same-title-b'])
    expect(sameTitleOptions.map((option) => option.text)).toEqual(['Same title (a.test)', 'Same title (b.test)'])
    expect(document.querySelector('input[aria-label="Linked bookmark"]')).toBeNull()
  })

  it('keeps the create form behind an Add relation disclosure and hands focus back on cancel', async () => {
    render(); await waitForDom(domFinishedLoading)
    const disclosure = findButtonByName('Add relation')
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('[aria-label="Create relation"]')).toBeNull()
    await openCreateForm()
    expect(disclosure.getAttribute('aria-expanded')).toBe('true')
    const form = document.querySelector<HTMLFormElement>('[aria-label="Create relation"]')!
    expect(disclosure.getAttribute('aria-controls')).toBe(form.id)
    expect(document.activeElement).toBe(document.querySelector('[aria-label="Linked bookmark"]'))
    click('Cancel')
    await waitForDom(() => document.querySelector('[aria-label="Create relation"]') === null)
    await waitForDom(() => document.activeElement === disclosure)
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
  })

  it('shows one quiet empty line when neither direction has relations', async () => {
    mocks.loadRelations.mockResolvedValue([])
    render(); await waitForDom(domFinishedLoading)
    expect(document.body.textContent).toContain('No relations yet.')
    expect(document.body.textContent).not.toContain('Outgoing relations')
    expect(document.body.textContent).not.toContain('Incoming relations')
    expect(document.querySelector('[data-relation-state]')?.textContent).toBe('0 relations')
  })

  it('performs create, patch, and delete while endpoint replacement uses two command intents', async () => {
    mocks.createRelation.mockResolvedValue(relation()); mocks.updateRelation.mockResolvedValue(relation({ revision: 'r2' })); mocks.deleteRelation.mockResolvedValue({})
    render(); await waitForDom(domFinishedLoading); await openCreateForm()
    change(document.querySelector('[aria-label="Linked bookmark"]')!, 'same-title-b'); click('Create relation'); await waitForDom(domFinishedLoading)
    expect(mocks.createRelation).toHaveBeenCalledWith('collection-detail', expect.objectContaining({ fromNodeId: NODE_ID, toNodeId: 'same-title-b' }), expect.objectContaining({ intentId: expect.stringContaining('create-relation') }))
    click('Edit relation'); await waitForDom(domFinishedLoading); input(document.querySelector<HTMLInputElement>('[aria-label="Relation label"]')!, 'Patched'); await waitForDom(domFinishedLoading); click('Save relation'); await waitForDom(domFinishedLoading)
    expect(mocks.updateRelation).toHaveBeenCalledWith('collection-detail', 'relation-out', expect.objectContaining({ label: 'Patched' }), '"r1"', expect.any(Object))
    change(document.querySelector('[aria-label="Replace with"]')!, 'same-title-a'); click('Replace linked bookmark')
    await confirmModalClick('Replace')
    await waitForDom(domFinishedLoading)
    expect(mocks.deleteRelation).toHaveBeenCalledWith('collection-detail', 'relation-out', '"r1"', expect.objectContaining({ intentId: expect.stringContaining('replace-delete') }))
    expect(mocks.createRelation).toHaveBeenLastCalledWith('collection-detail', expect.objectContaining({ toNodeId: 'same-title-a' }), expect.objectContaining({ intentId: expect.stringContaining('replace-create') }))
    const deleteIntent = mocks.deleteRelation.mock.calls.at(-1)?.[3].intentId
    const createIntent = mocks.createRelation.mock.calls.at(-1)?.[2].intentId
    expect(deleteIntent).not.toBe(createIntent)
  })

  it('refreshes after 412, preserves same intent after unknown outcome, and requires explicit 409 recovery', async () => {
    mocks.updateRelation
      .mockRejectedValueOnce(new ProductApiError({ status: 412, code: 'precondition_failed', message: 'stale', recovery: 'refresh_and_retry' }))
      .mockRejectedValueOnce(new ProductApiError({ status: 0, code: 'transport_error', message: 'lost', recovery: 'same_request', sameRequestRetrySafe: true }))
      .mockRejectedValueOnce(new ProductApiError({ status: 409, code: 'command_id_reused', message: 'reuse', recovery: 'user_action' }))
      .mockResolvedValue(relation({ revision: 'r3' }))
    render(); await waitForDom(domFinishedLoading); click('Edit relation'); click('Save relation'); await waitForDom(domFinishedLoading)
    expect(document.body.textContent).toContain('changed on the server'); expect(mocks.loadRelations.mock.calls.length).toBeGreaterThan(2)
    click('Save relation'); await waitForDom(domFinishedLoading); expect(document.body.textContent).toContain('may not have been saved')
    click('Retry save'); await waitForDom(domFinishedLoading); expect(document.body.textContent).toContain('conflicts with an earlier request')
    click('Start new change'); await waitForDom(domFinishedLoading); expect(document.body.textContent).toContain('Relation saved')
    expect(mocks.updateRelation.mock.calls[1]![4].intentId).toBe(mocks.updateRelation.mock.calls[2]![4].intentId)
    expect(mocks.updateRelation.mock.calls[3]![4].intentId).not.toBe(mocks.updateRelation.mock.calls[2]![4].intentId)
  })

  it('aborts an in-flight mutation and fences its late result when navigation switches resources', async () => {
    let resolveCreate: ((value: RelationView) => void) | undefined
    mocks.createRelation.mockImplementation((_collection, _body, options) => new Promise<RelationView>((resolve, reject) => {
      resolveCreate = resolve
      options.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }))
    render(); await waitForDom(domFinishedLoading); await openCreateForm()
    change(document.querySelector('[aria-label="Linked bookmark"]')!, 'same-title-b'); click('Create relation'); await waitForDom(domFinishedLoading)
    const signal = mocks.createRelation.mock.calls[0]![2].signal as AbortSignal
    const endpointLink = document.querySelector<HTMLAnchorElement>('a[href^="/r/same-title-a"]')!
    act(() => endpointLink.click())
    // The leave guard holds the navigation behind the shared confirm modal.
    await confirmModalClick('Discard')
    await waitForDom(domFinishedLoading)
    expect(signal.aborted).toBe(true)
    expect(mocks.loadRelations).toHaveBeenCalledWith('collection-detail', { nodeId: 'same-title-a', direction: 'incoming' }, expect.any(Object))
    await act(async () => { resolveCreate?.(relation()); await Promise.resolve() })
    expect(document.body.textContent).not.toContain('Relation created')
  })

  it('replays the exact replacement phase and command after an unknown create outcome', async () => {
    mocks.deleteRelation.mockResolvedValue({})
    mocks.createRelation
      .mockRejectedValueOnce(new ProductApiError({ status: 0, code: 'transport_error', message: 'lost', recovery: 'same_request', sameRequestRetrySafe: true }))
      .mockResolvedValueOnce(relation({ toNodeId: 'same-title-a' }))
    render(); await waitForDom(domFinishedLoading); click('Edit relation'); await waitForDom(domFinishedLoading)
    change(document.querySelector('[aria-label="Replace with"]')!, 'same-title-a'); click('Replace linked bookmark')
    await confirmModalClick('Replace')
    await waitForDom(domFinishedLoading)
    expect(document.body.textContent).toContain('The replacement may not have finished')
    click('Retry save'); await waitForDom(domFinishedLoading)
    expect(mocks.deleteRelation).toHaveBeenCalledTimes(1)
    expect(mocks.createRelation).toHaveBeenCalledTimes(2)
    expect(mocks.createRelation.mock.calls[1]![2].intentId).toBe(mocks.createRelation.mock.calls[0]![2].intentId)
    expect(document.body.textContent).toContain('Linked bookmark replaced')
  })

  it('keeps mutation controls locked until the post-mutation reload completes', async () => {
    const reload = deferred<EditorSnapshot>()
    mocks.createRelation.mockResolvedValue(relation())
    render(); await waitForDom(domFinishedLoading); await openCreateForm()
    mocks.loadEditorSnapshot.mockReturnValueOnce(reload.promise)
    change(document.querySelector('[aria-label="Linked bookmark"]')!, 'same-title-b')
    click('Create relation'); await waitForDom(domFinishedLoading)
    /* The grant survives a post-mutation reload so the controls stay mounted;
       the mutation lock is what actually fences the in-flight refresh. */
    expect(findButtonByName('Add relation').disabled).toBe(true)
    expect(document.querySelector('[aria-label="Create relation"]')).toBeNull()
    expect(mocks.createRelation).toHaveBeenCalledTimes(1)
    await act(async () => { reload.resolve(editor()); await reload.promise; await Promise.resolve(); await Promise.resolve() })
    expect(findButtonByName('Add relation').disabled).toBe(false)
    expect(document.body.textContent).toContain('Relation created')
  })

  it('keeps the open edit form mounted while the post-save reload is in flight', async () => {
    const reload = deferred<RelationView[]>()
    mocks.updateRelation.mockResolvedValue(relation({ revision: 'r2' }))
    render(); await waitForDom(domFinishedLoading)
    click('Edit relation'); await waitForDom(domFinishedLoading)
    mocks.loadRelations.mockReturnValue(reload.promise)
    click('Save relation'); await waitForDom(domFinishedLoading)
    expect(document.querySelector('form[aria-label="Edit relation"]')).not.toBeNull()
    expect(document.querySelector<HTMLInputElement>('[aria-label="Relation label"]')?.disabled).toBe(true)
    await act(async () => { reload.resolve([relation({ revision: 'r2' })]); await Promise.resolve(); await Promise.resolve() })
    expect(document.body.textContent).toContain('Relation saved')
    expect(document.querySelector<HTMLInputElement>('[aria-label="Relation label"]')?.disabled).toBe(false)
  })

  it('hides write forms for signed-out visitors and asks them to log in', async () => {
    mocks.auth.isLoggedIn = false
    mocks.auth.bootstrapping = false
    render(); await waitForDom(domFinishedLoading)
    expect(document.querySelector('[aria-label="Create relation"]')).toBeNull()
    expect(() => findButtonByName('Add relation')).toThrow(/button not found/u)
    expect(document.body.textContent).toContain('Sign in to see notes, highlights and relations on this bookmark.')
    expect(document.querySelector('[data-testid="relation-workspace"]')).toBeNull()
    expect(document.querySelector('a[href^="/login?returnTo="]')).not.toBeNull()
    expect(mocks.loadRelations).not.toHaveBeenCalled()
  })
  it('returns graph-origin edits to the same collection and selected node', async () => {
    mountTree(<MemoryRouter initialEntries={[`/r/${NODE_ID}?collectionId=collection-detail&subjectType=node&slug=relations-path&fromGraph=1`]}><Routes><Route path="/r/:id" element={<ResourceDetail />} /></Routes></MemoryRouter>)
    await waitForDom(domFinishedLoading)
    const back = [...document.querySelectorAll('a')].find((link) => link.textContent === 'Back to graph')!
    expect(back.getAttribute('href')).toBe(`/graph/relations-path?node=${NODE_ID}`)
  })

  it('retains graph context when navigating relation endpoints', async () => {
    mountTree(<MemoryRouter initialEntries={[`/r/${NODE_ID}?collectionId=collection-detail&subjectType=node&slug=relations-path&fromGraph=1`]}><Routes><Route path="/r/:id" element={<ResourceDetail />} /></Routes></MemoryRouter>)
    await waitForDom(domFinishedLoading)
    const endpoint = document.querySelector<HTMLAnchorElement>('a[aria-label="Same title (a.test)"]')!
    expect(endpoint.getAttribute('href')).toContain('slug=relations-path&fromGraph=1')
    act(() => endpoint.click())
    await waitForDom(() => [...document.querySelectorAll('a')].some((link) => link.textContent === 'Back to graph' && link.getAttribute('href') === '/graph/relations-path?node=same-title-a'))
  })

  it('scrolls to the relations section when the workspace link carries its hash', async () => {
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    mountTree(<MemoryRouter initialEntries={[`/r/${NODE_ID}?collectionId=collection-detail&subjectType=node&slug=relations-path&fromGraph=1#resource-relations-heading`]}><Routes><Route path="/r/:id" element={<ResourceDetail />} /></Routes></MemoryRouter>)
    await waitForDom(domFinishedLoading)
    expect(scroll).toHaveBeenCalled()
    expect((scroll.mock.instances[0] as Element | undefined)?.id).toBe('resource-relations-heading')
  })
  it('opens the root relation workspace without offering bookmark reading actions', async () => {
    mountTree(<MemoryRouter initialEntries={['/r/root?collectionId=collection-detail&subjectType=node&slug=relations-path&fromGraph=1']}><Routes><Route path="/r/:id" element={<ResourceDetail />} /></Routes></MemoryRouter>)
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="relation-workspace"]')).not.toBeNull()
    expect(document.body.textContent).not.toContain('Read in Know-N')
    expect(document.querySelector('a[href="/graph/relations-path?node=root"]')).not.toBeNull()
    await openCreateForm()
    expect(document.querySelector('[aria-label="Linked bookmark"] option[value="same-title-a"]')).not.toBeNull()
  })
  it('does not replace a failed post-save reload with a success message', async () => {
    render(); await waitForDom(domFinishedLoading)
    click('Edit relation')
    mocks.updateRelation.mockResolvedValue(relation({ revision: 'r2' }))
    mocks.loadRelations.mockRejectedValue(new Error('Reload failed'))
    click('Save relation'); await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-relation-state]')?.textContent).toBe("Couldn't load relations")
    expect(document.querySelector('[data-relation-state]')?.getAttribute('data-relation-state')).toBe('error')
  })

  it('guards a new relation draft and clears it after confirming an endpoint change', async () => {
    render(); await waitForDom(domFinishedLoading); await openCreateForm()
    change(document.querySelector('[aria-label="Linked bookmark"]')!, 'same-title-b')
    input(document.querySelector('[aria-label="New relation label"]')!, 'Unsaved draft')
    const endpoint = document.querySelector<HTMLAnchorElement>('a[aria-label="Same title (a.test)"]')!
    act(() => endpoint.click())
    await confirmModalClick('Cancel')
    expect(document.querySelector<HTMLInputElement>('[aria-label="New relation label"]')?.value).toBe('Unsaved draft')
    act(() => endpoint.click())
    await confirmModalClick('Discard')
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[aria-label="Create relation"]')).toBeNull()
    await openCreateForm()
    expect(document.querySelector<HTMLInputElement>('[aria-label="New relation label"]')?.value).toBe('')
    expect(mocks.createRelation).not.toHaveBeenCalled()
  })

  it('renders relations without mutation controls for a signed-in read-only member', async () => {
    const value = editor()
    value.capabilities.updateNode = false
    mocks.loadEditorSnapshot.mockResolvedValue(value)
    render(); await waitForDom(domFinishedLoading)
    expect(document.body.textContent).toContain('Incoming')
    for (const name of ['Add relation', 'Edit relation', 'Delete relation']) {
      expect([...document.querySelectorAll('button')].some((button) => button.textContent === name)).toBe(false)
    }
    expect(mocks.createRelation).not.toHaveBeenCalled()
    expect(mocks.updateRelation).not.toHaveBeenCalled()
    expect(mocks.deleteRelation).not.toHaveBeenCalled()
  })

  it('flags a dirty edit as stale when a reload reveals a newer server revision', async () => {
    mocks.createRelation.mockResolvedValue(relation({ id: 'relation-new' }))
    render(); await waitForDom(domFinishedLoading)
    click('Edit relation'); await waitForDom(domFinishedLoading)
    input(document.querySelector<HTMLInputElement>('[aria-label="Relation label"]')!, 'My draft')
    /* The relation moved on the server; the post-create reload must surface
       the divergence instead of silently re-arming save with the fresh etag. */
    mocks.loadRelations.mockImplementation((_c: string, query: { direction: string }) => Promise.resolve(query.direction === 'incoming'
      ? [relation({ id: 'relation-in', fromNodeId: 'same-title-a', toNodeId: NODE_ID, label: 'Incoming' })]
      : [relation({ revision: 'r2' })]))
    await openCreateForm()
    change(document.querySelector('[aria-label="Linked bookmark"]')!, 'same-title-a')
    click('Create relation'); await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-relation-state]')?.getAttribute('data-relation-state')).toBe('stale')
    expect(document.body.textContent).toContain('changed on the server')
    mocks.updateRelation.mockResolvedValue(relation({ revision: 'r3' }))
    click('Save relation'); await waitForDom(domFinishedLoading)
    expect(mocks.updateRelation).toHaveBeenCalledWith('collection-detail', 'relation-out', expect.objectContaining({ label: 'My draft' }), '"r2"', expect.any(Object))
  })

  it('syncs a clean edit draft when the server revision advances', async () => {
    mocks.createRelation.mockResolvedValue(relation({ id: 'relation-new' }))
    render(); await waitForDom(domFinishedLoading)
    click('Edit relation'); await waitForDom(domFinishedLoading)
    mocks.loadRelations.mockImplementation((_c: string, query: { direction: string }) => Promise.resolve(query.direction === 'incoming'
      ? [relation({ id: 'relation-in', fromNodeId: 'same-title-a', toNodeId: NODE_ID, label: 'Incoming' })]
      : [relation({ revision: 'r2', label: 'Server label' })]))
    await openCreateForm()
    change(document.querySelector('[aria-label="Linked bookmark"]')!, 'same-title-a')
    click('Create relation'); await waitForDom(domFinishedLoading)
    expect(document.querySelector<HTMLInputElement>('[aria-label="Relation label"]')?.value).toBe('Server label')
    expect(document.querySelector('[data-relation-state]')?.getAttribute('data-relation-state')).toBe('ready')
  })

})
