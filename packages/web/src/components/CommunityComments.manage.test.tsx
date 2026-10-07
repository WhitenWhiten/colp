// @vitest-environment happy-dom
/* CS-04 management surface of CommunityComments: author edit/delete,
   curator hide/unhide + comment-area lock. Every manage write goes through
   its own ETag authority — the comment tag for author writes, the curation
   tag for hide/unhide, the settings tag for lock — so each flow first
   performs a fresh read and then sends If-Match. A 412/precondition or
   stale-generation conflict abandons the intent, refreshes the board and
   asks the user to review-and-retry. */
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductApiError } from '../api/errors'
import type {
  CommunityComment,
  CommunityCommentPage,
  CommunityTarget,
  CommunityTargetQuery,
  CommunityTargetView,
} from '../api'
import { CommunityComments } from './CommunityComments'
import { cleanup, mountTree, waitForDom } from '../test/render'

const mocks = vi.hoisted(() => ({
  resolveCommunityTarget: vi.fn(),
  getCommunityComments: vi.fn(),
  getCommunityCommentReplies: vi.fn(),
  createCommunityComment: vi.fn(),
  getCommunityComment: vi.fn(),
  getCommunityCommentWithEtag: vi.fn(),
  editCommunityComment: vi.fn(),
  deleteCommunityComment: vi.fn(),
  getCommentCuration: vi.fn(),
  setCommentCuration: vi.fn(),
  getCommunityCommentSettings: vi.fn(),
  setCommunityCommentSettings: vi.fn(),
  abandonCommunityCommentIntent: vi.fn(),
  abandonCommunityCommentManageIntent: vi.fn(),
}))

const auth = vi.hoisted(() => ({
  user: { profileId: 'aaaaaaaaaaaaaaaaaaaaaA', handle: 'actor' } as
    | { profileId: string; handle: string }
    | null,
  isLoggedIn: true,
  bootstrapping: false,
}))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, productClient: { ...actual.productClient, ...mocks } }
})

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: auth.user,
    isLoggedIn: auth.isLoggedIn,
    bootstrapping: auth.bootstrapping,
  }),
}))

const COLLECTION = 'cccccccccccccccccccccA'
const TARGET: CommunityTarget = {
  kind: 'collection', id: COLLECTION,
  collectionId: null, seriesId: null, generation: 'static-v1',
}
const QUERY = { kind: 'collection' as const, id: COLLECTION }

function view(overrides: Partial<CommunityTargetView> = {}): CommunityTargetView {
  return {
    target: TARGET,
    title: 'Curated list',
    href: '/c/curated',
    canVote: true,
    canComment: true,
    canCurateComments: false,
    votes: { target: TARGET, up: 3, down: 1, myVote: 0 },
    ...overrides,
  }
}

function comment(id: string, overrides: Partial<CommunityComment> = {}): CommunityComment {
  return {
    id,
    target: TARGET,
    rootId: id,
    replyToId: null,
    depth: 0,
    author: {
      id: 'bbbbbbbbbbbbbbbbbbbbA',
      handle: 'reader',
      displayName: 'Reader',
      avatarUrl: null,
    },
    body: `Body of ${id}`,
    state: 'visible',
    revision: '1',
    createdAt: '2026-01-02T03:04:05.000Z',
    updatedAt: '2026-01-02T03:04:05.000Z',
    replyCount: 0,
    canEdit: false,
    canDelete: false,
    canCurate: false,
    ...overrides,
  }
}

function page(
  items: readonly CommunityComment[],
  nextCursor: string | null = null,
): CommunityCommentPage {
  return { items: [...items], nextCursor }
}

function settingsResult(overrides: { locked?: boolean; reason?: string | null; etag?: string | null } = {}) {
  return {
    data: {
      target: TARGET,
      locked: overrides.locked ?? false,
      reason: overrides.reason ?? null,
      revision: '1',
      updatedAt: '2026-01-02T03:04:05.000Z',
    },
    etag: overrides.etag !== undefined ? overrides.etag : 'settings-etag-1',
  }
}

function curationResult(commentId: string, overrides: { hidden?: boolean; reason?: string | null; etag?: string | null } = {}) {
  return {
    data: {
      commentId,
      hidden: overrides.hidden ?? false,
      reason: overrides.reason ?? null,
      revision: '1',
      updatedAt: '2026-01-02T03:04:05.000Z',
    },
    etag: overrides.etag !== undefined ? overrides.etag : 'curation-etag-1',
  }
}

describe('CommunityComments manage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    auth.user = { profileId: 'aaaaaaaaaaaaaaaaaaaaaA', handle: 'actor' }
    auth.isLoggedIn = true
    auth.bootstrapping = false
    delete window.__KNOWN_FLAGS__
    document.body.innerHTML = '<div id="root"></div>'
    // R15-29: without IntersectionObserver the thread mounts at once.
    vi.stubGlobal('IntersectionObserver', undefined)
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    window.__KNOWN_FLAGS__ = { community: true }
    mocks.resolveCommunityTarget.mockResolvedValue(view())
    mocks.getCommunityComments.mockResolvedValue(page([comment('c1'), comment('c2')]))
    mocks.getCommunityCommentReplies.mockResolvedValue(page([]))
    mocks.getCommunityComment.mockImplementation(async (id: string) => comment(id))
    mocks.getCommunityCommentWithEtag.mockImplementation(async (id: string) => ({
      data: comment(id), etag: `comment-etag-${id}-1`,
    }))
    mocks.editCommunityComment.mockImplementation(async (id: string, body: { body: string }) => ({
      data: comment(id, { body: body.body, revision: '2' }), etag: `comment-etag-${id}-2`,
    }))
    mocks.deleteCommunityComment.mockImplementation(async (id: string) => ({
      data: comment(id, { state: 'deleted', body: null, revision: '2' }), etag: `comment-etag-${id}-2`,
    }))
    mocks.getCommentCuration.mockImplementation(async (id: string) => curationResult(id))
    mocks.setCommentCuration.mockImplementation(async (id: string, body: { hidden: boolean; reason: string }) =>
      curationResult(id, { hidden: body.hidden, reason: body.reason, etag: 'curation-etag-2' }))
    mocks.getCommunityCommentSettings.mockResolvedValue(settingsResult())
    mocks.setCommunityCommentSettings.mockImplementation(async (body: { locked: boolean; reason: string }) =>
      settingsResult({ locked: body.locked, reason: body.reason, etag: 'settings-etag-2' }))
  })
  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
    delete window.__KNOWN_FLAGS__
    vi.unstubAllGlobals()
  })

  function render(query: CommunityTargetQuery | null = QUERY) {
    mountTree(
      <MemoryRouter initialEntries={['/c/curated']}>
        <CommunityComments query={query} />
      </MemoryRouter>,
    )
  }

  function el<T extends HTMLElement = HTMLElement>(testId: string): T | null {
    return document.querySelector<T>(`[data-testid="${testId}"]`)
  }

  function type(testId: string, value: string) {
    const field = el<HTMLTextAreaElement>(testId)
    if (field === null) throw new Error(`textarea not found: ${testId}`)
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(field, value)
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  async function confirmDialog(title: string, confirmLabel: string) {
    const dialog = document.querySelector(`[role="dialog"][aria-label="${title}"]`)
    if (!dialog) throw new Error(`confirm dialog missing: ${title}`)
    const button = [...dialog.querySelectorAll<HTMLButtonElement>('button')]
      .find((candidate) => candidate.textContent?.trim() === confirmLabel)
    if (!button) throw new Error(`confirm button missing: ${confirmLabel}`)
    await act(async () => {
      button.click()
      await Promise.resolve()
    })
  }

  function submitForm(testId: string) {
    const form = el<HTMLFormElement>(testId)
    if (form === null) throw new Error(`form not found: ${testId}`)
    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
  }

  it('lets the author edit inline and sends the fresh comment ETag as If-Match', async () => {
    mocks.getCommunityComments.mockResolvedValue(page([
      comment('c1', { canEdit: true, canDelete: true }),
    ]))
    render()
    await waitForDom(() => el('comment-c1-edit') !== null)

    await act(async () => { el<HTMLButtonElement>('comment-c1-edit')?.click() })
    await waitForDom(() => el('comment-c1-edit-form') !== null)
    // The inline composer opens prefilled with the current body.
    expect(el<HTMLTextAreaElement>('comment-c1-edit-input')?.value).toBe('Body of c1')

    type('comment-c1-edit-input', '  Edited body  ')
    submitForm('comment-c1-edit-form')
    await waitForDom(() => el('comment-c1')?.textContent?.includes('Edited body') === true)

    /* The write is conditional on the comment's own strong ETag, obtained
       from a fresh single-comment read — never derived client-side. */
    expect(mocks.getCommunityCommentWithEtag).toHaveBeenCalledWith(
      'c1', expect.objectContaining({ maxRetries: 0 }),
    )
    expect(mocks.editCommunityComment).toHaveBeenCalledTimes(1)
    const [commentId, body, ifMatch, options] = mocks.editCommunityComment.mock.calls[0]!
    expect(commentId).toBe('c1')
    expect(body).toEqual({ body: 'Edited body' })
    expect(ifMatch).toBe('comment-etag-c1-1')
    expect(String(options.intentId)).toMatch(/^community-comment-edit:c1:/)

    // The updated comment replaces the row in place; the composer closed.
    expect(el('comment-c1-edit-form')).toBeNull()
    expect(el('comment-c1')?.textContent).not.toContain('Body of c1')
  })

  it('lets the author delete into a tombstone while the reply stays readable', async () => {
    const root = comment('root-1', { canDelete: true, replyCount: 1 })
    const reply = comment('r1', {
      rootId: 'root-1', replyToId: 'root-1', depth: 1, body: 'Surviving reply',
    })
    mocks.getCommunityComments.mockResolvedValue(page([root]))
    mocks.getCommunityCommentReplies.mockResolvedValue(page([reply]))
    render()
    await waitForDom(() => el('comment-root-1-delete') !== null)

    // Expand the thread so the reply is on screen before the delete lands.
    await act(async () => { el<HTMLButtonElement>('comment-root-1-thread')?.click() })
    await waitForDom(() => el('comment-r1') !== null)

    await act(async () => { el<HTMLButtonElement>('comment-root-1-delete')?.click() })
    await confirmDialog('Delete this comment?', 'Delete')
    await waitForDom(() => el('comment-root-1')?.textContent?.includes('Comment deleted') === true)

    expect(mocks.deleteCommunityComment).toHaveBeenCalledTimes(1)
    const [commentId, ifMatch, options] = mocks.deleteCommunityComment.mock.calls[0]!
    expect(commentId).toBe('root-1')
    expect(ifMatch).toBe('comment-etag-root-1-1')
    expect(String(options.intentId)).toBe('community-comment-delete:root-1')

    // Tombstone: no body, no author actions; the reply is untouched.
    expect(el('comment-root-1')?.textContent).not.toContain('Body of root-1')
    expect(el('comment-root-1-delete')).toBeNull()
    expect(el('comment-root-1-reply')).toBeNull()
    expect(el('comment-r1')?.textContent).toContain('Surviving reply')
  })

  it('lets a curator hide a comment into a hidden tombstone and unhide to restore it', async () => {
    mocks.resolveCommunityTarget.mockResolvedValue(view({ canCurateComments: true }))
    mocks.getCommunityComments.mockResolvedValue(page([
      comment('c1', { canCurate: true }),
    ]))
    render()
    await waitForDom(() => el('comment-c1-hide') !== null)
    // The curator read of the area settings ran alongside the list.
    expect(mocks.getCommunityCommentSettings).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'collection', id: COLLECTION, generation: 'static-v1' }),
      expect.objectContaining({ maxRetries: 0 }),
    )

    // Hide: the shared reason prompt requires a reason before the write goes out.
    await act(async () => { el<HTMLButtonElement>('comment-c1-hide')?.click() })
    await waitForDom(() => document.querySelector('[role="dialog"][aria-label="Hide this comment?"]') !== null)
    expect(el<HTMLButtonElement>('community-reason-submit')?.disabled).toBe(true)
    type('community-reason-input', 'Spam link')
    mocks.getCommunityComment.mockResolvedValueOnce(
      comment('c1', { state: 'hidden', body: null, canCurate: true }),
    )
    await confirmDialog('Hide this comment?', 'Hide')
    await waitForDom(() => el('comment-c1')?.textContent?.includes('Comment hidden') === true)

    /* The curation overlay is its own ETag authority: the tag comes from
       getCommentCuration, not from the comment revision. */
    expect(mocks.getCommentCuration).toHaveBeenCalledWith(
      'c1', expect.objectContaining({ maxRetries: 0 }),
    )
    expect(mocks.setCommentCuration).toHaveBeenCalledTimes(1)
    const [hiddenId, hiddenBody, hiddenTag] = mocks.setCommentCuration.mock.calls[0]!
    expect(hiddenId).toBe('c1')
    expect(hiddenBody).toEqual({ hidden: true, reason: 'Spam link' })
    expect(hiddenTag).toBe('curation-etag-1')

    // The tombstone carries the Restore control; the body is gone.
    expect(el('comment-c1')?.textContent).not.toContain('Body of c1')
    expect(el('comment-c1-hide')).toBeNull()
    await waitForDom(() => el('comment-c1-unhide') !== null)
    expect(el('comment-c1-unhide')?.textContent).toBe('Restore')

    // Restore brings the comment back from a fresh read through the same prompt.
    await act(async () => { el<HTMLButtonElement>('comment-c1-unhide')?.click() })
    await waitForDom(() => document.querySelector('[role="dialog"][aria-label="Restore this comment?"]') !== null)
    type('community-reason-input', 'False positive')
    mocks.getCommunityComment.mockResolvedValueOnce(
      comment('c1', { canCurate: true }),
    )
    await confirmDialog('Restore this comment?', 'Restore')
    await waitForDom(() => el('comment-c1')?.textContent?.includes('Body of c1') === true)

    expect(mocks.setCommentCuration).toHaveBeenCalledTimes(2)
    const [, unhideBody] = mocks.setCommentCuration.mock.calls[1]!
    expect(unhideBody).toEqual({ hidden: false, reason: 'False positive' })
    expect(el('comment-c1-hide')).not.toBeNull()
  })

  it('lets a curator lock the comment area: notice shows and the composer disables', async () => {
    mocks.resolveCommunityTarget.mockResolvedValue(view({ canCurateComments: true }))
    render()
    await waitForDom(() => el('community-comments-settings') !== null)
    expect(el('community-comments-locked')).toBeNull()
    expect(el<HTMLTextAreaElement>('community-comments-input')?.disabled).toBe(false)

    await act(async () => { el<HTMLButtonElement>('community-comments-lock')?.click() })
    await waitForDom(() => document.querySelector('[role="dialog"][aria-label="Lock comments?"]') !== null)
    expect(el<HTMLButtonElement>('community-reason-submit')?.disabled).toBe(true)
    expect(el('community-reason-count')?.textContent).toBe('0/1000')
    type('community-reason-input', 'Heated thread')
    await waitForDom(() => el('community-reason-count')?.textContent === '13/1000')
    await confirmDialog('Lock comments?', 'Lock comments')
    await waitForDom(() => el('community-comments-outcome')?.textContent === 'Comment area locked')
    await waitForDom(() => el('community-comments-locked') !== null)

    /* The settings write is conditional on the independent settings ETag
       held from the curator read — not the comment or curation tags. */
    expect(mocks.setCommunityCommentSettings).toHaveBeenCalledTimes(1)
    const [body, ifMatch, options] = mocks.setCommunityCommentSettings.mock.calls[0]!
    expect(body).toEqual({ target: TARGET, locked: true, reason: 'Heated thread' })
    expect(ifMatch).toBe('settings-etag-1')
    expect(String(options.intentId)).toMatch(/^community-comment-settings:collection:/)

    // Locked notice with the stored reason; the composer is disabled.
    expect(el('community-comments-locked')?.textContent).toContain('Comments are locked')
    expect(el('community-comments-locked')?.textContent).toContain('Heated thread')
    expect(el<HTMLTextAreaElement>('community-comments-input')?.disabled).toBe(true)
    expect(el<HTMLButtonElement>('community-comments-submit')?.disabled).toBe(true)
    await waitForDom(() => document.querySelector('[role="dialog"][aria-label="Lock comments?"]') === null)
    expect(el('community-comments-lock')?.textContent).toBe('Unlock comments')

    // Existing comments stay readable under a locked area.
    expect(el('comment-c1')?.textContent).toContain('Body of c1')
  })

  it('reports a failed curator settings read instead of hiding the management surface', async () => {
    /* CS-04: a 5xx on the settings read is not concealment — the curator
       keeps the comment thread AND sees the explicit settings failure, and
       the lock controls stay absent until a read succeeds. */
    mocks.resolveCommunityTarget.mockResolvedValue(view({ canCurateComments: true }))
    mocks.getCommunityCommentSettings.mockRejectedValue(
      new ProductApiError({ status: 500, code: 'internal_error', message: 'Internal error.' }),
    )
    render()
    await waitForDom(() => el('comment-c1') !== null)
    await waitForDom(() => el('community-comments-settings-error') !== null)
    // R15-23: a server failure reads as plain outage copy, not the server's text.
    expect(el('community-comments-settings-error')?.textContent).toContain('Know-N is having trouble right now. Try again in a minute.')
    expect(el('community-comments-settings')).toBeNull()
    expect(el('community-comments-lock')).toBeNull()
    // The thread itself still renders — the failure is scoped to settings.
    expect(el('comment-c1')?.textContent).toContain('Body of c1')
  })

  it('keeps a concealed settings read silent for curators', async () => {
    /* 404/resource_not_found is concealment (the settings surface does not
       exist for this target), not an error — no failure note paints. */
    mocks.resolveCommunityTarget.mockResolvedValue(view({ canCurateComments: true }))
    mocks.getCommunityCommentSettings.mockRejectedValue(
      new ProductApiError({ status: 404, code: 'resource_not_found', message: 'Not found.' }),
    )
    render()
    await waitForDom(() => el('comment-c1') !== null)
    await act(async () => { await Promise.resolve() })
    expect(el('community-comments-settings-error')).toBeNull()
    expect(el('community-comments-settings')).toBeNull()
  })

  it('renders no manage controls for a viewer who is neither author nor curator', async () => {
    render()
    await waitForDom(() => el('comment-c1') !== null)
    expect(el('comment-c1-edit')).toBeNull()
    expect(el('comment-c1-delete')).toBeNull()
    expect(el('comment-c1-hide')).toBeNull()
    expect(el('comment-c1-unhide')).toBeNull()
    expect(el('community-comments-settings')).toBeNull()
    expect(el('community-comments-lock')).toBeNull()
    // The curator settings read is never attempted for non-curators.
    expect(mocks.getCommunityCommentSettings).not.toHaveBeenCalled()
    // Ordinary reader controls still render.
    expect(el('comment-c1-reply')).not.toBeNull()
  })

  it('surfaces a stale If-Match as a review-and-retry notice and refreshes the board', async () => {
    mocks.getCommunityComments.mockResolvedValue(page([
      comment('c1', { canEdit: true }),
    ]))
    mocks.editCommunityComment.mockRejectedValue(
      new ProductApiError({
        status: 412, code: 'precondition_failed', message: 'ETag mismatch',
      }),
    )
    render()
    await waitForDom(() => el('comment-c1-edit') !== null)

    await act(async () => { el<HTMLButtonElement>('comment-c1-edit')?.click() })
    await waitForDom(() => el('comment-c1-edit-form') !== null)
    type('comment-c1-edit-input', 'Edited body')
    // Baseline after the mount settled: the edit form itself issues no
    // authority read, so the refresh must be exactly one further read.
    const readsBeforeSubmit = mocks.resolveCommunityTarget.mock.calls.length
    submitForm('comment-c1-edit-form')

    await waitForDom(() => el('community-comments')?.textContent?.includes('Review and try again') === true)
    // The stale intent is abandoned so the next explicit submit is a new command.
    expect(mocks.abandonCommunityCommentManageIntent).toHaveBeenCalledWith(
      'community-comment-edit:c1:Edited body',
    )
    // The projection refreshes through a fresh authority read.
    await waitForDom(() => mocks.resolveCommunityTarget.mock.calls.length === readsBeforeSubmit + 1)
    // The draft stays open for the user's review-and-retry decision.
    await waitForDom(() => el('comment-c1-edit-form') !== null)
  })
})
