// @vitest-environment happy-dom
/* Account switch must drop cached private notes before the next paint, and a
   response that started under the previous identity must not land afterwards.
   strict: false keeps one in-flight read so the late response is unambiguous. */
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductApiError } from '../api/errors'
import type { AnnotationView } from '../api'
import { applyMeView, applySessionView, clearSession, privateSessionIdentity } from '../api/sessionStore'
import {
  invalidateBookmarkAnnotations,
  resetBookmarkAnnotationsCacheForTests,
  useBookmarkAnnotations,
} from './useBookmarkAnnotations'
import { cleanup, mountTree } from '../test/render'

const mocks = vi.hoisted(() => ({ loadAnnotations: vi.fn() }))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    productClient: {
      ...actual.productClient,
      loadAnnotations: mocks.loadAnnotations,
    },
  }
})

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function note(text: string, visibility: AnnotationView['visibility'] = 'private'): AnnotationView {
  return {
    id: `annotation-${text}`,
    collectionId: 'shared',
    subject: { type: 'node', id: 'node-1' },
    type: 'note',
    format: 'plain',
    value: text,
    visibility,
    creator: null,
    provenance: { kind: 'human' },
    revision: 'revision-1',
    createdAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-07-25T00:00:00.000Z',
    extensions: {},
  }
}

function signIn(accountId: string) {
  applySessionView({
    authenticated: true,
    csrfToken: 'csrf',
    idleExpiresAt: '2026-07-25T01:00:00Z',
    absoluteExpiresAt: '2026-07-26T00:00:00Z',
  })
  applyMeView({
    account: { id: accountId, email: `${accountId}@test` },
    profile: { id: `profile-${accountId}`, handle: accountId, displayName: accountId, avatarUrl: null },
  })
}

function Harness({
  nodeIds,
  enabled = true,
}: {
  nodeIds: readonly string[]
  enabled?: boolean
}) {
  const marks = useBookmarkAnnotations('shared', nodeIds, enabled)
  return (
    <output data-testid="notes">
      {nodeIds.map((id) => marks.get(id)?.note?.text ?? '').join('\n')}
    </output>
  )
}

function render(nodeIds: readonly string[], enabled = true) {
  mountTree(<Harness nodeIds={nodeIds} enabled={enabled} />, { strict: false })
}

function shown(): string {
  return document.querySelector('[data-testid="notes"]')?.textContent ?? ''
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

const denied = new ProductApiError({ status: 403, code: 'forbidden', message: 'no' })

describe('useBookmarkAnnotations session identity', () => {
  beforeEach(() => {
    mocks.loadAnnotations.mockReset()
    resetBookmarkAnnotationsCacheForTests()
    clearSession()
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    signIn('account-a')
  })

  afterEach(() => {
    cleanup()
    resetBookmarkAnnotationsCacheForTests()
    clearSession()
    document.body.innerHTML = ''
  })

  it('clears a cached private note on identity switch and ignores late writes', async () => {
    const reads = new Map<string, Deferred<AnnotationView[]>[]>()
    mocks.loadAnnotations.mockImplementation(() => {
      const identity = privateSessionIdentity()
      const slot = deferred<AnnotationView[]>()
      const list = reads.get(identity) ?? []
      list.push(slot)
      reads.set(identity, list)
      return slot.promise
    })

    const identityA = privateSessionIdentity()
    render(['show', 'late-ok', 'late-deny', 'late-fail'])
    await flush()
    const aReads = reads.get(identityA) ?? []
    expect(aReads).toHaveLength(4)

    await act(async () => { aReads[0]!.resolve([note('secret')]) })
    expect(shown()).toBe('secret\n\n\n')

    await act(async () => {
      applyMeView({
        account: { id: 'account-b', email: 'account-b@test' },
        profile: { id: 'profile-b', handle: 'b', displayName: 'B', avatarUrl: null },
      })
    })
    const identityB = privateSessionIdentity()
    expect(identityB).not.toBe(identityA)
    // The cached private body is gone before B's read resolves.
    expect(shown().replaceAll('\n', '')).toBe('')
    const bReads = reads.get(identityB) ?? []
    expect(bReads).toHaveLength(4)

    await act(async () => {
      for (const read of bReads) read.resolve([note('from-b')])
    })
    expect(shown()).toBe('from-b\nfrom-b\nfrom-b\nfrom-b')

    await act(async () => {
      aReads[1]!.resolve([note('leaked')])
      aReads[2]!.reject(denied)
      aReads[3]!.reject(new Error('down'))
      await Promise.resolve()
    })
    expect(shown()).toBe('from-b\nfrom-b\nfrom-b\nfrom-b')
    expect(shown()).not.toContain('secret')
    expect(shown()).not.toContain('leaked')

    cleanup()
    const calls = mocks.loadAnnotations.mock.calls.length
    render(['show', 'late-ok', 'late-deny', 'late-fail'])
    expect(shown()).toBe('from-b\nfrom-b\nfrom-b\nfrom-b')
    await flush()
    expect(mocks.loadAnnotations.mock.calls.length).toBe(calls)

    cleanup()
    mocks.loadAnnotations.mockReset()
    mocks.loadAnnotations.mockResolvedValue([note('fresh-b')])
    render(['fresh'])
    await flush()
    expect(mocks.loadAnnotations).toHaveBeenCalledTimes(1)
    expect(shown()).toBe('fresh-b')
  })

  it('stops showing the cached private note when the session is cleared in place', async () => {
    const pending = deferred<AnnotationView[]>()
    mocks.loadAnnotations.mockReturnValueOnce(Promise.resolve([note('secret')]))
    mocks.loadAnnotations.mockReturnValue(pending.promise)
    render(['n1'])
    await flush()
    expect(shown()).toBe('secret')

    await act(async () => { clearSession() })
    expect(shown()).toBe('')
    expect(mocks.loadAnnotations).toHaveBeenCalledTimes(2)
  })

  it('does not let a denial or empty failure from the previous account block the next', async () => {
    mocks.loadAnnotations.mockRejectedValueOnce(denied)
    render(['n1'])
    await flush()
    expect(mocks.loadAnnotations).toHaveBeenCalledTimes(1)
    expect(shown()).toBe('')

    mocks.loadAnnotations.mockResolvedValue([note('from-b')])
    await act(async () => {
      applyMeView({
        account: { id: 'account-b', email: 'account-b@test' },
        profile: { id: 'profile-b', handle: 'b', displayName: 'B', avatarUrl: null },
      })
    })
    await flush()
    expect(mocks.loadAnnotations).toHaveBeenCalledTimes(2)
    expect(shown()).toBe('from-b')

    cleanup()
    resetBookmarkAnnotationsCacheForTests()
    signIn('account-a')
    mocks.loadAnnotations.mockReset()
    mocks.loadAnnotations.mockRejectedValueOnce(new Error('down'))
    render(['n1'])
    await flush()
    expect(mocks.loadAnnotations).toHaveBeenCalledTimes(1)

    mocks.loadAnnotations.mockResolvedValue([note('after-failure')])
    await act(async () => {
      applyMeView({
        account: { id: 'account-c', email: 'account-c@test' },
        profile: { id: 'profile-c', handle: 'c', displayName: 'C', avatarUrl: null },
      })
    })
    await flush()
    expect(mocks.loadAnnotations).toHaveBeenCalledTimes(2)
    expect(shown()).toBe('after-failure')
  })

  it('still shows a public note when the subject has no private note', async () => {
    mocks.loadAnnotations.mockResolvedValue([note('visible to readers', 'public')])
    render(['n1'])
    await flush()
    expect(shown()).toBe('visible to readers')
  })

  it('does not draw a cached snippet when the caller disables marks', async () => {
    mocks.loadAnnotations.mockResolvedValue([note('secret')])
    render(['n1'])
    await flush()
    expect(shown()).toBe('secret')

    cleanup()
    render(['n1'], false)
    expect(shown()).toBe('')
    await flush()
    expect(mocks.loadAnnotations).toHaveBeenCalledTimes(1)
  })

  it('invalidates only the saved subject for the current identity', async () => {
    mocks.loadAnnotations.mockResolvedValue([note('secret')])
    render(['n1', 'n2'])
    await flush()
    expect(shown()).toBe('secret\nsecret')

    invalidateBookmarkAnnotations('shared', 'n1')
    cleanup()
    mocks.loadAnnotations.mockReset()
    mocks.loadAnnotations.mockResolvedValue([note('updated')])
    render(['n1', 'n2'])
    expect(shown()).toBe('\nsecret')
    await flush()
    expect(mocks.loadAnnotations).toHaveBeenCalledTimes(1)
    expect(mocks.loadAnnotations).toHaveBeenCalledWith(
      'shared',
      { resourceType: 'node', resourceId: 'n1' },
      expect.objectContaining({ maxRetries: 0 }),
    )
    expect(shown()).toBe('updated\nsecret')
  })
})
