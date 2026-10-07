// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinkHealthItem } from '../api'
import { ProductApiError } from '../api/errors'
import { LibraryHealth } from './LibraryHealth'
import { clearRouteCache } from '../lib/routeCache'
import { cleanup, domFinishedLoading, mountTree, waitForDom } from '../test/render'

const mocks = vi.hoisted(() => ({
  enabled: true,
  getMyLinkHealth: vi.fn(),
  enqueueMyLinkHealthChecks: vi.fn(),
  createRelation: vi.fn(),
  deleteRelation: vi.fn(),
  deleteNode: vi.fn(async () => { throw new Error('deleteNode must not be called') }),
  moveNode: vi.fn(async () => { throw new Error('moveNode must not be called') }),
  abandonRelationIntent: vi.fn(),
  toast: vi.fn(),
}))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    isLinkHealthExposureEnabled: () => mocks.enabled,
    productClient: {
      ...actual.productClient,
      getMyLinkHealth: mocks.getMyLinkHealth,
      enqueueMyLinkHealthChecks: mocks.enqueueMyLinkHealthChecks,
      createRelation: mocks.createRelation,
      deleteRelation: mocks.deleteRelation,
      deleteNode: mocks.deleteNode,
      moveNode: mocks.moveNode,
      abandonRelationIntent: mocks.abandonRelationIntent,
    },
  }
})

vi.mock('../components/AppToast', () => ({
  useToast: () => ({ toast: mocks.toast, success: vi.fn(), error: vi.fn() }),
}))

function item(overrides: Partial<LinkHealthItem> = {}): LinkHealthItem {
  return {
    nodeId: 'node-dup',
    collectionId: 'col-1',
    collectionTitle: 'Reading list',
    title: 'Later copy',
    url: 'https://example.test/shared',
    status: 'healthy',
    duplicateOfNodeId: 'node-original',
    host: 'example.test',
    membership: 'owner',
    ...overrides,
  }
}

function render() {
  mountTree(
    <MemoryRouter>
      <LibraryHealth />
    </MemoryRouter>,
  )
}

function buttonNamed(name: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => node.textContent?.trim() === name)
  if (!button) throw new Error(`missing button ${name}`)
  return button
}

describe('LibraryHealth duplicate review and cannot-probe display', () => {
  beforeEach(() => {
    clearRouteCache()
    vi.clearAllMocks()
    mocks.enabled = true
    mocks.getMyLinkHealth.mockResolvedValue({ items: [item()], nextCursor: null })
    mocks.enqueueMyLinkHealthChecks.mockResolvedValue({ queued: 1 })
    mocks.createRelation.mockResolvedValue({
      id: 'rel-1', collectionId: 'col-1', fromNodeId: 'node-dup', toNodeId: 'node-original',
      type: 'duplicate_of', visibility: 'private', revision: 'rel-r1',
    })
    mocks.deleteRelation.mockResolvedValue({})
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
    clearRouteCache()
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('marks a candidate as a private duplicate_of without merging nodes', async () => {
    const original = item({
      nodeId: 'node-original', title: 'Original copy', duplicateOfNodeId: null,
    })
    const later = item()
    const otherParent = item({
      nodeId: 'node-folder', title: 'Same URL other folder', duplicateOfNodeId: 'node-original',
    })
    /* Stateful endpoint, not a call queue: StrictMode mounts the loader twice
       (the first pass is aborted), so a scripted per-call answer would be spent
       on the discarded request. The relation exists only once this review has
       created it, and every read reports that same state. */
    let reviewed = false
    mocks.getMyLinkHealth.mockImplementation(async () => ({
      items: [
        original,
        reviewed
          ? { ...later, duplicateRelationId: 'rel-1', duplicateRelationEtag: '"rel-r1"' }
          : later,
        otherParent,
      ],
      nextCursor: null,
    }))
    mocks.createRelation.mockImplementation(async () => {
      reviewed = true
      return {
        id: 'rel-1', collectionId: 'col-1', fromNodeId: 'node-dup', toNodeId: 'node-original',
        type: 'duplicate_of', visibility: 'private', revision: 'rel-r1',
      }
    })
    render()
    await waitForDom(domFinishedLoading)
    expect(document.body.textContent).toContain('Possible duplicate of another bookmark')
    expect(document.body.textContent).not.toContain('Apply suggested fixes')
    const loadsBeforeReview = mocks.getMyLinkHealth.mock.calls.length
    act(() => buttonNamed('Mark as duplicate').click())
    await waitForDom(domFinishedLoading)
    expect(mocks.createRelation).toHaveBeenCalledWith(
      'col-1',
      {
        fromNodeId: 'node-dup',
        toNodeId: 'node-original',
        type: 'duplicate_of',
        visibility: 'private',
      },
      expect.objectContaining({ intentId: expect.stringContaining('link-health-duplicate-review'), maxRetries: 0 }),
    )
    // One review write: the suggestion must never be applied twice.
    expect(mocks.createRelation).toHaveBeenCalledTimes(1)
    // The review issues exactly one further read (its reload); no extra one.
    expect(mocks.getMyLinkHealth.mock.calls.length).toBe(loadsBeforeReview + 1)
    expect(mocks.deleteNode).not.toHaveBeenCalled()
    expect(mocks.moveNode).not.toHaveBeenCalled()
    expect(mocks.deleteRelation).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Reviewed as a duplicate')
    expect(document.body.textContent).toContain('Original copy')
    expect(document.body.textContent).toContain('Same URL other folder')
    expect(document.body.textContent).toContain('Later copy')
  })

  it('reloads on already-exists instead of creating another relation', async () => {
    /* The server already holds the relation, so the create attempt conflicts
       and the reload must show the reviewed row. Both are modelled as endpoint
       state: StrictMode's double mount cannot drain a one-shot answer. */
    let relationExists = false
    mocks.getMyLinkHealth.mockImplementation(async () => ({
      items: [item(relationExists
        ? { duplicateRelationId: 'rel-1', duplicateRelationEtag: '"rel-r1"' }
        : {})],
      nextCursor: null,
    }))
    mocks.createRelation.mockImplementation(async () => {
      relationExists = true
      throw new ProductApiError({
        status: 409,
        code: 'mutation_conflict',
        message: 'The directed semantic Relation already exists.',
        recovery: 'user_action',
      })
    })
    render()
    await waitForDom(domFinishedLoading)
    const loadsBeforeReview = mocks.getMyLinkHealth.mock.calls.length
    act(() => buttonNamed('Mark as duplicate').click())
    await waitForDom(domFinishedLoading)
    // One create attempt: the 409 must reload, never retry the write.
    expect(mocks.createRelation).toHaveBeenCalledTimes(1)
    expect(mocks.getMyLinkHealth.mock.calls.length).toBe(loadsBeforeReview + 1)
    expect(mocks.deleteNode).not.toHaveBeenCalled()
    expect(mocks.moveNode).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Reviewed as a duplicate')
    expect(document.body.textContent).not.toContain('Could not save the duplicate review')
  })

  it('keeps the row and reports the failure in place when the review save fails', async () => {
    mocks.createRelation.mockRejectedValue(new Error('network down'))
    render()
    await waitForDom(domFinishedLoading)
    act(() => buttonNamed('Mark as duplicate').click())
    await waitForDom(domFinishedLoading)
    expect(document.body.textContent).toContain("Couldn't mark this as a duplicate. Try again.")
    expect(document.body.textContent).toContain('Later copy')
    expect(document.body.textContent).not.toContain("Couldn't start the link check")
  })

  it('undoes a review with the current relation ETag', async () => {
    /* The relation exists until this undo deletes it: every read (both mount
       passes and the post-delete reload) reflects that one piece of state. */
    let relationExists = true
    mocks.getMyLinkHealth.mockImplementation(async () => ({
      items: [item(relationExists
        ? { duplicateRelationId: 'rel-1', duplicateRelationEtag: '"rel-r1"' }
        : {})],
      nextCursor: null,
    }))
    mocks.deleteRelation.mockImplementation(async () => {
      relationExists = false
      return {}
    })
    render()
    await waitForDom(domFinishedLoading)
    act(() => buttonNamed('Undo review').click())
    await waitForDom(domFinishedLoading)
    expect(mocks.deleteRelation).toHaveBeenCalledWith(
      'col-1',
      'rel-1',
      '"rel-r1"',
      expect.objectContaining({ intentId: expect.stringContaining('link-health-duplicate-undo'), maxRetries: 0 }),
    )
    expect(document.body.textContent).toContain('Possible duplicate of another bookmark')
  })

  it('reloads and asks to undo again on a stale ETag', async () => {
    mocks.getMyLinkHealth.mockResolvedValue({
      items: [item({ duplicateRelationId: 'rel-1', duplicateRelationEtag: '"rel-old"' })],
      nextCursor: null,
    })
    mocks.deleteRelation.mockRejectedValueOnce(new ProductApiError({
      status: 412,
      code: 'precondition_failed',
      message: 'changed',
      recovery: 'refresh_and_retry',
    }))
    render()
    await waitForDom(domFinishedLoading)
    act(() => buttonNamed('Undo review').click())
    await waitForDom(domFinishedLoading)
    expect(mocks.abandonRelationIntent).toHaveBeenCalled()
    expect(document.body.textContent).toContain('This review changed. Refresh, then undo again.')
  })

  it('does not treat timeout or TLS failures as broken and offers retry copy', async () => {
    mocks.getMyLinkHealth.mockResolvedValue({
      items: [
        item({
          nodeId: 'node-timeout',
          title: 'Timed out bookmark',
          status: 'broken',
          errorClass: 'timeout',
          duplicateOfNodeId: null,
        }),
        item({
          nodeId: 'node-tls',
          title: 'TLS bookmark',
          status: 'broken',
          errorClass: 'http',
          duplicateOfNodeId: null,
        }),
        item({
          nodeId: 'node-404',
          title: 'Gone bookmark',
          status: 'broken',
          errorClass: 'http',
          httpStatus: 404,
          duplicateOfNodeId: null,
        }),
        item({
          nodeId: 'node-503',
          title: 'Remote 503 bookmark',
          status: 'broken',
          errorClass: 'http',
          httpStatus: 503,
          duplicateOfNodeId: null,
        }),
      ],
      nextCursor: null,
    })
    render()
    await waitForDom(domFinishedLoading)
    const labels = [...document.querySelectorAll('[data-testid="health-status"]')].map((node) => node.textContent)
    expect(labels).toContain('Could not check')
    expect(labels).toContain('Broken')
    expect(labels).toContain('Remote error')
    expect(labels.filter((label) => label === 'Could not check')).toHaveLength(2)
    expect(labels.filter((label) => /broken/i.test(label ?? ''))).toEqual(['Broken'])
    expect(document.body.textContent).toContain('The checker could not reach this link. Retry the check.')
    expect(document.body.textContent).toContain('The remote server returned 503. Retry the check.')
    expect(document.body.textContent).toContain('Could not check')
    act(() => buttonNamed('Retry check').click())
    await waitForDom(domFinishedLoading)
    expect(mocks.enqueueMyLinkHealthChecks).toHaveBeenCalledWith(
      { collectionId: 'col-1', nodeIds: ['node-timeout'] },
      expect.objectContaining({ intentId: expect.stringContaining('link-health-retry'), maxRetries: 0 }),
    )
  })

  it('hides review actions from viewers', async () => {
    mocks.getMyLinkHealth.mockResolvedValue({
      items: [item({ membership: 'viewer' })],
      nextCursor: null,
    })
    render()
    await waitForDom(domFinishedLoading)
    expect(document.body.textContent).toContain('Possible duplicate of another bookmark')
    expect([...document.querySelectorAll('button')].some((node) => node.textContent?.includes('Mark as duplicate')))
      .toBe(false)
  })
})
