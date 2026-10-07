/**
 * P1-13: Editor load state machine — cursor restart on snapshot_expired,
 * pagination assembly, loading/error fail-closed (no fake success).
 *
 * Production: loadEditorSnapshot / getCollectionEditorPage in productClient.ts
 * Recovery: recoveryStrategyFor / ProductApiError.isSnapshotExpired in errors.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { productClient } from './productClient'
import {
  ProductApiError,
  recoveryStrategyFor,
} from './errors'
import {
  createMemorySessionStorage,
  editorPageBody,
  installFetchMock,
  installSessionStorage,
  productErrorBody,
  jsonResponse,
  resetProductSession,
} from './test-helpers'

const { loadEditorSnapshot } = productClient

describe('loadEditorSnapshot state machine', () => {
  let restoreStorage: () => void
  let restoreFetch: (() => void) | undefined

  beforeEach(() => {
    vi.stubEnv('VITE_MOCK_SESSION', 'false')
    restoreStorage = installSessionStorage(createMemorySessionStorage())
    restoreFetch = undefined
    resetProductSession()
  })

  afterEach(() => {
    restoreFetch?.()
    restoreStorage()
    resetProductSession()
    vi.unstubAllEnvs()
  })

  it('assembles multi-page editor tree using opaque cursor continuation', async () => {
    let page = 0
    const mock = installFetchMock((input) => {
      page += 1
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        'http://localhost',
      )
      if (page === 1) {
        expect(url.searchParams.has('cursor')).toBe(false)
        return jsonResponse(
          editorPageBody({
            nodes: [
              {
                id: 'n-1',
                kind: 'bookmark',
                title: 'A',
                url: 'https://a.example',
                description: null,
                tags: [],
                visibility: 'inherit',
                revision: 1,
                etag: '"n1"',
                parentId: 'root-1',
              },
            ],
            page: {
              snapshotId: 'snap-1',
              contentRevision: 1,
              policyRevision: 1,
              comparatorVersion: 'v1',
              expiresAt: '2026-07-22T12:00:00.000Z',
              returnedCount: 1,
              hasMore: true,
              nextCursor: 'opaque-page-2',
            },
          }),
        )
      }
      expect(url.searchParams.get('cursor')).toBe('opaque-page-2')
      expect(url.searchParams.has('limit')).toBe(false)
      return jsonResponse(
        editorPageBody({
          nodes: [
            {
              id: 'n-2',
              kind: 'bookmark',
              title: 'B',
              url: 'https://b.example',
              description: null,
              tags: [],
              visibility: 'inherit',
              revision: 1,
              etag: '"n2"',
              parentId: 'root-1',
            },
          ],
          page: {
            snapshotId: 'snap-1',
            contentRevision: 1,
            policyRevision: 1,
            comparatorVersion: 'v1',
            expiresAt: '2026-07-22T12:00:00.000Z',
            returnedCount: 1,
            hasMore: false,
            nextCursor: null,
          },
        }),
      )
    })
    restoreFetch = mock.restore

    const snap = await loadEditorSnapshot('col-1', { maxRetries: 0 })
    expect(snap.nodes.map((n) => n.id)).toEqual(['n-1', 'n-2'])
    expect(snap.page.hasMore).toBe(false)
    expect(snap.collection.id).toBe('col-1')
    expect(mock.calls.length).toBe(2)
  })

  it('restarts from first page on snapshot_expired mid-pagination (discards partial)', async () => {
    const onCursorRestart = vi.fn()
    let phase: 'first' | 'stale' | 'restart1' | 'restart2' = 'first'
    const mock = installFetchMock((input) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        'http://localhost',
      )
      const cursor = url.searchParams.get('cursor')

      if (phase === 'first') {
        phase = 'stale'
        return jsonResponse(
          editorPageBody({
            nodes: [{ id: 'partial-only', kind: 'folder', title: 'Partial', parentId: 'root-1' }],
            page: {
              snapshotId: 'snap-old',
              contentRevision: 1,
              policyRevision: 1,
              comparatorVersion: 'v1',
              expiresAt: '2026-07-22T12:00:00.000Z',
              returnedCount: 1,
              hasMore: true,
              nextCursor: 'stale-cursor',
            },
          }),
        )
      }

      if (phase === 'stale' && cursor === 'stale-cursor') {
        phase = 'restart1'
        return jsonResponse(
          productErrorBody({
            code: 'snapshot_expired',
            recovery: 'restart_from_first_page',
          }),
          { status: 409 },
        )
      }

      // Full restart: first page again (no cursor)
      if (phase === 'restart1' && !cursor) {
        phase = 'restart2'
        return jsonResponse(
          editorPageBody({
            nodes: [
              {
                id: 'fresh-1',
                kind: 'bookmark',
                title: 'Fresh',
                url: 'https://fresh.example',
                description: null,
                tags: [],
                visibility: 'inherit',
                revision: 1,
                etag: '"f1"',
                parentId: 'root-1',
              },
            ],
            collection: {
              ...(editorPageBody().collection as object),
              contentRevision: 2,
              contentEtag: '"cc-2"',
            },
            page: {
              snapshotId: 'snap-new',
              contentRevision: 2,
              policyRevision: 1,
              comparatorVersion: 'v1',
              expiresAt: '2026-07-22T13:00:00.000Z',
              returnedCount: 1,
              hasMore: false,
              nextCursor: null,
            },
          }),
        )
      }

      throw new Error(`unexpected request phase=${phase} cursor=${cursor}`)
    })
    restoreFetch = mock.restore

    const snap = await loadEditorSnapshot('col-1', {
      maxRetries: 0,
      maxSnapshotRestarts: 3,
      onCursorRestart,
    })

    // Must not keep partial-only node from the expired snapshot
    expect(snap.nodes.map((n) => n.id)).toEqual(['fresh-1'])
    expect(snap.nodes.some((n) => n.id === 'partial-only')).toBe(false)
    expect(snap.page.snapshotId).toBe('snap-new')
    expect(onCursorRestart).toHaveBeenCalledTimes(1)
    expect(onCursorRestart).toHaveBeenCalledWith({
      reason: 'snapshot_expired',
      attempt: 1,
    })
  })

  it('restarts on invalid_cursor the same way as snapshot_expired', async () => {
    let calls = 0
    const mock = installFetchMock((input) => {
      calls += 1
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        'http://localhost',
      )
      if (calls === 1) {
        return jsonResponse(
          editorPageBody({
            nodes: [{ id: 'n-a', kind: 'folder', title: 'A', parentId: 'root-1' }],
            page: {
              snapshotId: 's1',
              contentRevision: 1,
              policyRevision: 1,
              comparatorVersion: 'v1',
              expiresAt: '2026-07-22T12:00:00.000Z',
              returnedCount: 1,
              hasMore: true,
              nextCursor: 'bad-cursor',
            },
          }),
        )
      }
      if (url.searchParams.get('cursor') === 'bad-cursor') {
        return jsonResponse(
          productErrorBody({
            code: 'invalid_cursor',
            recovery: 'restart_from_first_page',
          }),
          { status: 400 },
        )
      }
      // restart first page
      return jsonResponse(
        editorPageBody({
          nodes: [{ id: 'n-ok', kind: 'folder', title: 'OK', parentId: 'root-1' }],
          page: {
            snapshotId: 's2',
            contentRevision: 1,
            policyRevision: 1,
            comparatorVersion: 'v1',
            expiresAt: '2026-07-22T12:00:00.000Z',
            returnedCount: 1,
            hasMore: false,
            nextCursor: null,
          },
        }),
      )
    })
    restoreFetch = mock.restore

    const snap = await loadEditorSnapshot('col-1', { maxRetries: 0, maxSnapshotRestarts: 2 })
    expect(snap.nodes.map((n) => n.id)).toEqual(['n-ok'])
  })

  it('surfaces precondition_failed without inventing a successful tree', async () => {
    // Not a snapshot restart case — load fails closed
    const mock = installFetchMock(() =>
      jsonResponse(
        productErrorBody({
          code: 'precondition_failed',
          recovery: 'refresh_and_retry',
          precondition: 'resource',
          currentEtag: '"c-9"',
        }),
        { status: 412 },
      ),
    )
    restoreFetch = mock.restore

    await expect(
      loadEditorSnapshot('col-1', { maxRetries: 0, maxSnapshotRestarts: 3 }),
    ).rejects.toMatchObject({
      code: 'precondition_failed',
      isPreconditionFailed: true,
    })
  })

  it('surfaces auth errors as require_login strategy (no fake logged-in editor)', async () => {
    const mock = installFetchMock(() =>
      jsonResponse(
        productErrorBody({
          code: 'authentication_required',
          recovery: 'user_action',
        }),
        { status: 401 },
      ),
    )
    restoreFetch = mock.restore

    try {
      await loadEditorSnapshot('col-1', { maxRetries: 0 })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ProductApiError)
      const e = err as ProductApiError
      expect(e.isAuthRequired).toBe(true)
      expect(recoveryStrategyFor(e)).toBe('require_login')
    }
  })

  it('gives up after maxSnapshotRestarts and does not loop forever', async () => {
    const mock = installFetchMock(() =>
      jsonResponse(
        productErrorBody({
          code: 'snapshot_expired',
          recovery: 'restart_from_first_page',
        }),
        { status: 409 },
      ),
    )
    restoreFetch = mock.restore

    await expect(
      loadEditorSnapshot('col-1', { maxRetries: 0, maxSnapshotRestarts: 2 }),
    ).rejects.toMatchObject({ code: 'snapshot_expired' })

    // initial attempt + 2 restarts = 3
    expect(mock.calls.length).toBe(3)
  })

  it('single-page happy path returns capabilities without inventing nodes', async () => {
    const mock = installFetchMock(() =>
      jsonResponse(
        editorPageBody({
          nodes: [],
          capabilities: {
            updateCollection: true,
            managePublication: true,
            createNode: true,
            updateNode: false,
            moveNode: false,
            deleteNode: false,
          },
        }),
      ),
    )
    restoreFetch = mock.restore

    const snap = await loadEditorSnapshot('col-1', { maxRetries: 0 })
    expect(snap.nodes).toEqual([])
    expect(snap.capabilities.createNode).toBe(true)
    expect(snap.capabilities.deleteNode).toBe(false)
    expect(mock.calls).toHaveLength(1)
  })
})
