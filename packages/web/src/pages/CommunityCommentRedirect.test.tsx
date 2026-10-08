// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommunityComment } from '@known/product-v1-client'
import { ProductApiError } from '../api/errors'
import { CommunityCommentRedirect } from './CommunityCommentRedirect'
import { cleanup, mountTree, waitForDom } from '../test/render'

const mocks = vi.hoisted(() => ({
  getCommunityComment: vi.fn(),
  resolveCommunityTarget: vi.fn(),
}))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, productClient: { ...actual.productClient, ...mocks } }
})

const COLLECTION = 'cccccccccccccccccccccA'

function comment(id: string, overrides: Partial<CommunityComment> = {}): CommunityComment {
  return {
    id,
    target: {
      kind: 'collection', id: COLLECTION,
      collectionId: null, seriesId: null, generation: 'static-v1',
    },
    rootId: id,
    replyToId: null,
    depth: 0,
    body: `body-${id}`,
    state: 'visible',
    revision: '1',
    createdAt: '2026-01-02T03:04:05.000Z',
    updatedAt: '2026-01-02T03:04:05.000Z',
    ...overrides,
  } as CommunityComment
}

function TargetProbe() {
  const location = useLocation()
  return <div data-testid="page-target">{location.pathname}{location.hash}</div>
}

describe('CommunityCommentRedirect', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    mocks.resolveCommunityTarget.mockResolvedValue({
      target: comment('c-1').target,
      title: 'Curated list',
      href: '/collections/curated',
      canVote: true,
      canComment: true,
      canCurateComments: false,
      votes: { up: 1, down: 0, myVote: null },
    })
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  function render(path = '/community/comments/c-1') {
    mountTree(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/community/comments/:commentId" element={<CommunityCommentRedirect />} />
          <Route path="/collections/:id" element={<TargetProbe />} />
        </Routes>
      </MemoryRouter>,
    )
  }

  it('redirects to the canonical target page anchored on the comment', async () => {
    mocks.getCommunityComment.mockResolvedValue(comment('c-1'))
    render()
    await waitForDom(() => document.querySelector('[data-testid="page-target"]') !== null)
    expect(document.querySelector('[data-testid="page-target"]')?.textContent)
      .toBe('/collections/curated#comment-c-1')
    expect(mocks.resolveCommunityTarget).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'collection', id: COLLECTION }),
      expect.anything(),
    )
  })

  it('anchors a reply on its thread root', async () => {
    mocks.getCommunityComment.mockResolvedValue(
      comment('c-reply', { depth: 2, rootId: 'c-root', replyToId: 'c-parent' }),
    )
    render('/community/comments/c-reply')
    await waitForDom(() => document.querySelector('[data-testid="page-target"]') !== null)
    expect(document.querySelector('[data-testid="page-target"]')?.textContent)
      .toBe('/collections/curated#comment-c-root')
  })

  it('shows the concealed note for a missing or concealed comment, without a retry', async () => {
    mocks.getCommunityComment.mockRejectedValue(
      new ProductApiError({ status: 404, code: 'resource_not_found', message: 'Not found.' }),
    )
    render()
    await waitForDom(() => document.body.textContent?.includes('Comment unavailable') === true)
    expect(document.querySelector('[data-testid="community-comment-redirect"]')).not.toBeNull()
    expect([...document.querySelectorAll('button')].some((button) => button.textContent === 'Retry')).toBe(false)
    expect(document.querySelector('a[href="/explore"]')?.textContent).toContain('Back to Explore')
    // A concealed read never resolves the target — no existence leak.
    expect(mocks.resolveCommunityTarget).not.toHaveBeenCalled()
  })

  it('shows a generic failure with retry for a server error', async () => {
    // The endpoint fails until the retry succeeds. A one-shot rejection would be
    // consumed by the first of StrictMode's two mount effects, and the second
    // would paint the comment over the error the test is about.
    mocks.getCommunityComment.mockRejectedValue(
      new ProductApiError({ status: 500, code: 'internal_error', message: 'Internal error.' }))
    render()
    await waitForDom(() => document.body.textContent?.includes("Couldn't load this comment") === true)
    // The concealed note must NOT paint for a non-concealment failure.
    expect(document.body.textContent).not.toContain('Comment unavailable')

    mocks.getCommunityComment.mockResolvedValue(comment('c-1'))
    await act(async () => {
      const retry = [...document.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === 'Try again')
      retry?.click()
    })
    await waitForDom(() => document.querySelector('[data-testid="page-target"]') !== null)
    expect(mocks.getCommunityComment.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('shows a generic failure for a transport error', async () => {
    mocks.getCommunityComment.mockRejectedValue(
      new ProductApiError({ status: 0, code: 'transport_error', message: 'offline' }),
    )
    render()
    await waitForDom(() => document.body.textContent?.includes("Couldn't load this comment") === true)
    expect(document.body.textContent).not.toContain('Comment unavailable')
  })
})
