// @vitest-environment happy-dom
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
import { formatDateTime } from '../lib/formatDate'
import { CommunityComments } from './CommunityComments'
import { cleanup, mountTree, waitForDom } from '../test/render'

const mocks = vi.hoisted(() => ({
  resolveCommunityTarget: vi.fn(),
  getCommunityComments: vi.fn(),
  getCommunityCommentReplies: vi.fn(),
  createCommunityComment: vi.fn(),
  getCommunityCommentSettings: vi.fn(),
  abandonCommunityCommentIntent: vi.fn(),
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

vi.mock('./ReportContentDialog', () => ({
  ReportContentDialog: ({ target, label, onClose }: {
    target: { kind: string; id: string }
    label: string
    onClose: () => void
  }) => (
    <div
      data-testid="report-content-dialog"
      data-target-kind={target.kind}
      data-target-id={target.id}
    >
      Report {label}
      <button type="button" data-testid="report-content-dialog-close" onClick={onClose}>
        Cancel
      </button>
    </div>
  ),
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

describe('CommunityComments', () => {
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
    mocks.createCommunityComment.mockImplementation(async (body: { body: string }) =>
      comment('new-1', { body: body.body }))
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

  it('reads the thread only as it nears the viewport, or at once for a #comment- link (R15-29)', async () => {
    let reveal: (() => void) | undefined
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
        reveal = () => callback([{ isIntersecting: true }])
      }
      observe() {}
      disconnect() {}
    })
    render()
    await act(async () => { await Promise.resolve() })
    expect(mocks.resolveCommunityTarget).not.toHaveBeenCalled()
    expect(document.querySelector('[data-comments-sentinel]')).not.toBeNull()
    await act(async () => { reveal!() })
    await waitForDom(() => mocks.resolveCommunityTarget.mock.calls.length > 0)
    cleanup()

    mocks.resolveCommunityTarget.mockClear()
    mountTree(
      <MemoryRouter initialEntries={['/c/curated#comment-c1']}>
        <CommunityComments query={QUERY} />
      </MemoryRouter>,
    )
    await waitForDom(() => mocks.resolveCommunityTarget.mock.calls.length > 0)
  })

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

  function submitForm(testId: string) {
    const form = el<HTMLFormElement>(testId)
    if (form === null) throw new Error(`form not found: ${testId}`)
    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
  }

  it('appends the next page and keeps the items when More comments is clicked', async () => {
    // The pagination path had no coverage at all: every fixture defaulted
    // `nextCursor` to null, so the Load more button was never rendered.
    /* The first page is the endpoint's steady state, not a one-shot of a call
       sequence: StrictMode double-invokes the panel's mount read (the first
       generation is discarded), so both mount reads must see page one. */
    mocks.getCommunityComments.mockResolvedValue(page([comment('c1'), comment('c2')], 'cursor-1'))
    render()
    await waitForDom(() => el('comment-c1') !== null)
    const more = el('community-comments-more')
    expect(more).not.toBeNull()
    // The continuation genuinely differs: it is the next list read, issued by
    // the Load more click.
    mocks.getCommunityComments.mockResolvedValueOnce(page([comment('c3')], null))
    act(() => { more!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await waitForDom(() => el('comment-c3') !== null)
    // Only the root rows themselves: the per-row action ids share the prefix.
    const rows = [...document.querySelectorAll('[data-testid^="comment-c"]')]
      .map((node) => node.getAttribute('data-testid')!)
      .filter((id) => /^comment-c\d+$/u.test(id))
    expect(rows).toEqual(['comment-c1', 'comment-c2', 'comment-c3'])
    expect(mocks.getCommunityComments).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: 'cursor-1' }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(el('community-comments-more')).toBeNull()
  })

  it('resolves the target then lists root comments createdAt DESC', async () => {
    render()
    await waitForDom(() => el('comment-c1') !== null)
    expect(mocks.resolveCommunityTarget).toHaveBeenCalledWith(
      QUERY, expect.objectContaining({ maxRetries: 0 }),
    )
    expect(mocks.getCommunityComments).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'collection',
        id: COLLECTION,
        generation: 'static-v1',
        limit: 20,
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(el('comment-c1-author')?.textContent).toBe('Reader')
    expect(el('comment-c1')?.textContent).toContain('Body of c1')
    expect(el('comment-c2')?.textContent).toContain('Body of c2')
    expect(el('community-comments-list')?.children.length).toBe(2)
  })

  it('lazily expands a root thread and renders flattened depth 1-2 replies', async () => {
    const root = comment('root-1', { replyCount: 2 })
    const reply1 = comment('r1', {
      rootId: 'root-1', replyToId: 'root-1', depth: 1,
      body: 'First reply', replyCount: 1,
      author: { id: 'ddddddddddddddddddddA', handle: 'replier', displayName: 'Replier', avatarUrl: null },
    })
    const reply2 = comment('r2', {
      rootId: 'root-1', replyToId: 'r1', depth: 2,
      body: 'Nested reply to r1',
      author: { id: 'eeeeeeeeeeeeeeeeeeeeA', handle: 'nested', displayName: 'Nested', avatarUrl: null },
    })
    mocks.getCommunityComments.mockResolvedValue(page([root]))
    mocks.getCommunityCommentReplies.mockResolvedValue(page([reply1, reply2]))
    render()
    await waitForDom(() => el('comment-root-1-thread') !== null)
    expect(el('comment-root-1-thread')?.textContent).toBe('2 replies')

    await act(async () => { el<HTMLButtonElement>('comment-root-1-thread')?.click() })
    await waitForDom(() => el('comment-r2') !== null)
    expect(mocks.getCommunityCommentReplies).toHaveBeenCalledWith(
      'root-1', expect.objectContaining({ limit: 20 }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(el('comment-root-1-replies')?.children.length).toBe(2)
    // Depth and parentage are preserved in the flattened thread markup.
    expect(el('comment-r1')?.className).toContain('community-comment--depth-1')
    expect(el('comment-r1')?.textContent).toContain('First reply')
    expect(el('comment-r2')?.className).toContain('community-comment--depth-2')
    expect(el('comment-r2')?.textContent).toContain('Nested reply to r1')
    // The depth-2 ceiling: depth-1 keeps a Reply action, depth-2 does not.
    expect(el('comment-r1-reply')).not.toBeNull()
    expect(el('comment-r2-reply')).toBeNull()
    // The nested toggle carries the root's contract: aria-expanded tracks
    // its own composer, and a second click collapses it.
    expect(el<HTMLButtonElement>('comment-r1-reply')?.getAttribute('aria-expanded')).toBe('false')
    await act(async () => { el<HTMLButtonElement>('comment-r1-reply')?.click() })
    expect(el<HTMLButtonElement>('comment-r1-reply')?.getAttribute('aria-expanded')).toBe('true')
    expect(el('comment-r1-composer')).not.toBeNull()
    await act(async () => { el<HTMLButtonElement>('comment-r1-reply')?.click() })
    expect(el<HTMLButtonElement>('comment-r1-reply')?.getAttribute('aria-expanded')).toBe('false')
    expect(el('comment-r1-composer')).toBeNull()
    // Expanded state collapses locally without a refetch.
    await act(async () => { el<HTMLButtonElement>('comment-root-1-thread')?.click() })
    expect(el('comment-root-1-replies')).toBeNull()
    expect(el('comment-root-1-thread')?.getAttribute('aria-expanded')).toBe('false')
    await act(async () => { el<HTMLButtonElement>('comment-root-1-thread')?.click() })
    await waitForDom(() => el('comment-r1') !== null)
    expect(mocks.getCommunityCommentReplies).toHaveBeenCalledTimes(1)
  })

  it('posts a root comment through the durable create command and prepends it', async () => {
    mocks.getCommunityComments.mockResolvedValue(page([comment('c1')]))
    mocks.createCommunityComment.mockImplementation(async (body: { body: string }) =>
      comment('new-1', { body: body.body }))
    render()
    await waitForDom(() => el('community-comments-input') !== null)

    type('community-comments-input', '  Hello world  ')
    await waitForDom(() => el<HTMLButtonElement>('community-comments-submit')?.disabled === false)
    submitForm('community-comments-composer')
    await waitForDom(() => el('comment-new-1') !== null)

    /* The generated client turns this call into POST
       /product/v1/community/comments with the session CSRF token and the
       intentId as the Known-Command-Id header; the panel must pass the
       resolved target (with generation), the trimmed body and an explicit
       null replyToId for a root comment. */
    expect(mocks.createCommunityComment).toHaveBeenCalledTimes(1)
    const [payload, options] = mocks.createCommunityComment.mock.calls[0]!
    expect(payload).toEqual({ target: TARGET, body: 'Hello world', replyToId: null })
    expect(options.intentId)
      .toBe(`community-comment:collection:${COLLECTION}:static-v1:root:Hello world`)

    // The returned comment prepends the list; the composer clears.
    expect(el('community-comments-list')?.children[0]?.getAttribute('data-testid'))
      .toBe('comment-new-1')
    expect(el('comment-new-1')?.textContent).toContain('Hello world')
    expect(el<HTMLTextAreaElement>('community-comments-input')?.value).toBe('')
  })

  it('posts a reply with replyToId set to the parent comment', async () => {
    const root = comment('root-1', { replyCount: 1 })
    mocks.getCommunityComments.mockResolvedValue(page([root]))
    mocks.getCommunityCommentReplies.mockResolvedValue(page([
      comment('r1', { rootId: 'root-1', replyToId: 'root-1', depth: 1, body: 'Existing reply' }),
    ]))
    mocks.createCommunityComment.mockImplementation(async (body: { body: string; replyToId: string | null }) =>
      comment('new-reply', {
        rootId: 'root-1', replyToId: body.replyToId, depth: 1, body: body.body,
      }))
    render()
    await waitForDom(() => el('comment-root-1-reply') !== null)

    // Expand the thread first: a locally inserted reply renders inside the
    // open thread; on a never-loaded thread it would stay concealed until
    // the next authoritative fetch.
    await act(async () => { el<HTMLButtonElement>('comment-root-1-thread')?.click() })
    await waitForDom(() => el('comment-r1') !== null)

    await act(async () => { el<HTMLButtonElement>('comment-root-1-reply')?.click() })
    await waitForDom(() => el('comment-root-1-composer') !== null)
    type('comment-root-1-input', 'A reply to root')
    submitForm('comment-root-1-composer')
    await waitForDom(() => el('comment-new-reply') !== null)

    expect(mocks.createCommunityComment).toHaveBeenCalledTimes(1)
    const [payload, options] = mocks.createCommunityComment.mock.calls[0]!
    expect(payload).toEqual({ target: TARGET, body: 'A reply to root', replyToId: 'root-1' })
    expect(options.intentId)
      .toBe(`community-comment:collection:${COLLECTION}:static-v1:root-1:A reply to root`)

    // The reply appends inside the thread and bumps the root replyCount label.
    await waitForDom(() => el('comment-root-1-replies') !== null)
    expect(el('comment-root-1-replies')?.textContent).toContain('A reply to root')
    // The toggle reads 'Hide replies' while expanded; collapse the thread
    // (items stay loaded) to read the bumped count.
    await act(async () => { el<HTMLButtonElement>('comment-root-1-thread')?.click() })
    expect(el('comment-root-1-thread')?.textContent).toBe('2 replies')
    // The reply composer closes after a successful post.
    expect(el('comment-root-1-composer')).toBeNull()
  })

  it('shows a busy loading section while the target resolves', async () => {
    let resolveResolve: ((v: CommunityTargetView) => void) | null = null
    mocks.resolveCommunityTarget.mockImplementation(
      () => new Promise<CommunityTargetView>((resolve) => { resolveResolve = resolve }),
    )
    render()
    await waitForDom(() => el('community-comments') !== null)
    const section = el('community-comments')
    expect(section?.className).toContain('community-comments--loading')
    expect(section?.getAttribute('aria-busy')).toBe('true')
    expect(section?.textContent).toContain('Loading comments…')
    expect(el('community-comments-list')).toBeNull()

    await act(async () => { resolveResolve?.(view()) })
    await waitForDom(() => el('comment-c1') !== null)
    expect(el('community-comments')?.getAttribute('aria-busy')).toBeNull()
  })

  it('surfaces the load error and retries through a fresh resolve', async () => {
    /* The list read failing is the endpoint's state for this scenario, not a
       one-shot: StrictMode double-invokes the panel's mount read and both
       reads must fail, otherwise the surviving mount paints a list and the
       error surface under assertion never appears. */
    mocks.getCommunityComments.mockRejectedValue(
      new ProductApiError({ status: 500, code: 'unknown_error', message: 'Comments backend exploded' }),
    )
    render()
    await waitForDom(() => el('community-comments-retry') !== null)
    // R15-23: a 5xx reads as plain outage copy, never the server's message.
    expect(el('community-comments')?.textContent).toContain('Know-N is having trouble right now. Try again in a minute.')
    expect(el('community-comments')?.textContent).not.toContain('Comments backend exploded')
    expect(el('community-comments-list')).toBeNull()

    const resolvesBeforeRetry = mocks.resolveCommunityTarget.mock.calls.length
    const listReadsBeforeRetry = mocks.getCommunityComments.mock.calls.length
    mocks.getCommunityComments.mockResolvedValue(page([comment('c1')]))
    await act(async () => { el<HTMLButtonElement>('community-comments-retry')?.click() })
    await waitForDom(() => el('comment-c1') !== null)
    // The retry re-runs the failed operation exactly once: one fresh target
    // resolve and one fresh list read, no loop and no duplicate request.
    expect(mocks.resolveCommunityTarget).toHaveBeenCalledTimes(resolvesBeforeRetry + 1)
    expect(mocks.getCommunityComments).toHaveBeenCalledTimes(listReadsBeforeRetry + 1)
    expect(el('community-comments-retry')).toBeNull()
  })

  it('renders the empty state when the target has no comments', async () => {
    mocks.getCommunityComments.mockResolvedValue(page([]))
    render()
    await waitForDom(() => el('community-comments-empty') !== null)
    expect(el('community-comments-empty')?.textContent).toBe('Be the first to comment.')
    expect(el('community-comments-list')?.children.length).toBe(0)
    // The composer is still available on an empty thread.
    expect(el('community-comments-composer')).not.toBeNull()
  })

  it('shows anonymous visitors the full thread plus a sign-in CTA', async () => {
    auth.user = null
    auth.isLoggedIn = false
    mocks.resolveCommunityTarget.mockResolvedValue(view({
      canVote: false, canComment: false,
      votes: { target: TARGET, up: 3, down: 1, myVote: null },
    }))
    render()
    await waitForDom(() => el('comment-c1') !== null)
    // Anonymous readers see the comments; the composer frame stays but the
    // input is a placeholder line and the only action is the sign-in link.
    const composer = el('community-comments-composer')
    expect(composer).not.toBeNull()
    expect(composer?.querySelector('p.community-composer-placeholder')?.textContent)
      .toBe('Sign in to join the discussion')
    // R12-15: a neutral person mark, not an empty avatar image/initials disc.
    expect(composer?.querySelector('[aria-hidden] [data-icon="person"]')).not.toBeNull()
    expect(composer?.querySelector('img')).toBeNull()
    expect(composer?.querySelector('textarea')).toBeNull()
    expect(el('comment-c1-reply')).toBeNull()
    // R15-11: guests can report too; the dialog offers sign-in or email.
    expect(el('comment-c1-report')).not.toBeNull()
    const cta = el<HTMLAnchorElement>('community-comments-signin')
    expect(cta).not.toBeNull()
    expect(cta?.tagName).toBe('A')
    expect(cta?.textContent).toBe('Sign in')
    // window.location.pathname is the returnTo source; under happy-dom it
    // is '/', so only the same-origin /login?returnTo= shape is asserted.
    expect(cta?.getAttribute('href')).toMatch(/^\/login\?returnTo=/)
  })

  it('explains the denial for a logged-in viewer without canComment (no CTA)', async () => {
    mocks.resolveCommunityTarget.mockResolvedValue(view({
      canComment: false, commentDeniedReason: 'locked',
    }))
    render()
    await waitForDom(() => el('comment-c1') !== null)
    // R14-36: the composer slot carries the API denial reason, not a blank.
    expect(el('community-comments-composer')).toBeNull()
    expect(el('community-comments-signin')).toBeNull()
    expect(el('community-comments-denied')?.textContent)
      .toBe('Comments are locked for this discussion.')
    expect(el('comment-c1-reply')).toBeNull()
    // A logged-in viewer without canComment can still report a visible comment.
    expect(el('comment-c1-report')).not.toBeNull()
  })

  it('falls back to a neutral line when the denial reason is absent', async () => {
    mocks.resolveCommunityTarget.mockResolvedValue(view({ canComment: false }))
    render()
    await waitForDom(() => el('comment-c1') !== null)
    expect(el('community-comments-composer')).toBeNull()
    expect(el('community-comments-denied')?.textContent)
      .toBe("Commenting isn't available right now.")
  })

  it('content-governance: opens a comment report dialog from a visible comment', async () => {
    const root = comment('root-1', { replyCount: 1 })
    const hidden = comment('hidden-1', { state: 'hidden', body: null })
    const reply = comment('r1', {
      rootId: 'root-1', replyToId: 'root-1', depth: 1, body: 'A reply',
    })
    mocks.getCommunityComments.mockResolvedValue(page([root, hidden]))
    mocks.getCommunityCommentReplies.mockResolvedValue(page([reply]))
    render()
    await waitForDom(() => el('comment-root-1-report') !== null)
    expect(el('comment-hidden-1-report')).toBeNull()

    await act(async () => { el<HTMLButtonElement>('comment-root-1-thread')?.click() })
    await waitForDom(() => el('comment-r1-report') !== null)

    await act(async () => { el<HTMLButtonElement>('comment-root-1-report')?.click() })
    await waitForDom(() => el('report-content-dialog') !== null)
    expect(el('report-content-dialog')?.getAttribute('data-target-kind')).toBe('comment')
    expect(el('report-content-dialog')?.getAttribute('data-target-id')).toBe('root-1')
    expect(el('report-content-dialog')?.textContent).toContain('this comment')

    await act(async () => { el<HTMLButtonElement>('report-content-dialog-close')?.click() })
    await waitForDom(() => el('report-content-dialog') === null)

    await act(async () => { el<HTMLButtonElement>('comment-r1-report')?.click() })
    await waitForDom(() => el('report-content-dialog') !== null)
    expect(el('report-content-dialog')?.getAttribute('data-target-id')).toBe('r1')
  })

  // R15-11: with in-app reporting off, the control stays; the dialog falls
  // back to email instead of leaving no report path at all.
  it('content-governance: keeps the comment report control when the flag is off', async () => {
    window.__KNOWN_FLAGS__ = { community: true, contentGovernance: false }
    render()
    await waitForDom(() => el('comment-c1') !== null)
    expect(el('comment-c1-report')).not.toBeNull()
    expect(el('report-content-dialog')).toBeNull()
  })

  it('counts Unicode code points and disables submit past the 4000 cap', async () => {
    render()
    await waitForDom(() => el('community-comments-input') !== null)
    const submit = () => el<HTMLButtonElement>('community-comments-submit')
    const counter = () => el('community-comments-count')

    // Blank input: counter at zero, submit disabled, no API call.
    expect(counter()?.textContent).toBe('0/4000')
    expect(submit()?.disabled).toBe(true)
    type('community-comments-input', '   ')
    await waitForDom(() => submit()?.disabled === true)
    submitForm('community-comments-composer')
    expect(mocks.createCommunityComment).not.toHaveBeenCalled()

    // Exactly at the cap: an astral character counts as one code point.
    type('community-comments-input', `${'a'.repeat(3_999)}😀`)
    await waitForDom(() => counter()?.textContent === '4000/4000')
    expect(counter()?.className).not.toContain('community-comments-counter--over')
    expect(submit()?.disabled).toBe(false)

    // One code point over: counter flags the overflow and submit is blocked.
    type('community-comments-input', `${'a'.repeat(4_000)}b`)
    await waitForDom(() => counter()?.textContent === '4001/4000')
    expect(counter()?.className).toContain('community-comments-counter--over')
    expect(submit()?.disabled).toBe(true)
    submitForm('community-comments-composer')
    expect(mocks.createCommunityComment).not.toHaveBeenCalled()
  })

  it('hides Be the first to comment when the area is locked', async () => {
    mocks.resolveCommunityTarget.mockResolvedValue(view({ canCurateComments: true }))
    mocks.getCommunityCommentSettings.mockResolvedValue({
      data: {
        target: TARGET, locked: true, reason: null,
        revision: '1', updatedAt: '2026-01-02T03:04:05.000Z',
      },
      etag: 'settings-etag-1',
    })
    mocks.getCommunityComments.mockResolvedValue(page([]))
    render()
    await waitForDom(() => el('community-comments-locked') !== null)
    expect(el('community-comments-empty')).toBeNull()
  })

  it('gives the relative timestamp an accessible absolute label', async () => {
    render()
    await waitForDom(() => el('comment-c1') !== null)
    const time = el('comment-c1')?.querySelector('time')
    expect(time?.getAttribute('aria-label')).toBe(formatDateTime('2026-01-02T03:04:05.000Z'))
  })

  it('focuses the reply textarea after Reply is opened', async () => {
    render()
    await waitForDom(() => el('comment-c1-reply') !== null)
    act(() => { el<HTMLButtonElement>('comment-c1-reply')!.click() })
    await waitForDom(() => el('comment-c1-input') !== null)
    expect(document.activeElement).toBe(el('comment-c1-input'))
  })
})
