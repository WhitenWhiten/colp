/**
 * Editor recovery mapping and loadEditorSnapshot termination budget.
 *
 * Production: loadEditorSnapshot in productClient.ts
 * Recovery: recoveryStrategyFor / ProductApiError.isSnapshotExpired in errors.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EDITOR_SNAPSHOT_MAX_BYTES,
  EDITOR_SNAPSHOT_MAX_NODES,
  EDITOR_SNAPSHOT_MAX_PAGES,
} from './product-client-collections'
import { productClient } from './productClient'
import {
  parseProductErrorEnvelope,
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

describe('editor recovery mapping (cursor restart policy)', () => {
  function err(status: number, code: string, recovery: string) {
    const parsed = parseProductErrorEnvelope(productErrorBody({ code, recovery }))
    return new ProductApiError(status, parsed)
  }

  it('snapshot_expired / invalid_cursor → restart_editor_from_first_page', () => {
    expect(recoveryStrategyFor(err(409, 'snapshot_expired', 'restart_from_first_page'))).toBe(
      'restart_editor_from_first_page',
    )
    expect(recoveryStrategyFor(err(400, 'invalid_cursor', 'restart_from_first_page'))).toBe(
      'restart_editor_from_first_page',
    )
    expect(err(409, 'snapshot_expired', 'restart_from_first_page').isSnapshotExpired).toBe(true)
  })

  it('precondition_failed is refresh, not cursor restart', () => {
    const e = err(412, 'precondition_failed', 'refresh_and_retry')
    expect(e.isSnapshotExpired).toBe(false)
    expect(recoveryStrategyFor(e)).toBe('refresh_and_retry')
  })

  it('command_in_progress / command_id_reused / auth are not cursor restarts', () => {
    expect(err(409, 'command_in_progress', 'same_request').isSnapshotExpired).toBe(false)
    expect(err(409, 'command_id_reused', 'user_action').isSnapshotExpired).toBe(false)
    expect(err(401, 'authentication_required', 'user_action').isSnapshotExpired).toBe(false)
  })
})

function requestCursor(input: RequestInfo | URL): string | null {
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    'http://localhost',
  )
  return url.searchParams.get('cursor')
}

function editorNode(id: string) {
  return {
    id,
    kind: 'bookmark' as const,
    title: id,
    url: `https://${id}.example`,
    description: null,
    tags: [] as string[],
    visibility: 'inherit' as const,
    revision: 1,
    etag: '"n"',
    parentId: 'root-1',
  }
}

function editorState(overrides: {
  nodes?: ReturnType<typeof editorNode>[]
  hasMore?: boolean
  nextCursor?: string | null
  snapshotId?: string
  returnedCount?: number
}) {
  const nodes = overrides.nodes ?? [editorNode('n-1')]
  const hasMore = overrides.hasMore ?? false
  return editorPageBody({
    nodes,
    page: {
      snapshotId: overrides.snapshotId ?? 'snap-1',
      contentRevision: 1,
      policyRevision: 1,
      comparatorVersion: 'v1',
      expiresAt: '2026-07-22T12:00:00.000Z',
      returnedCount: overrides.returnedCount ?? nodes.length,
      hasMore,
      nextCursor: overrides.nextCursor === undefined ? (hasMore ? 'next' : null) : overrides.nextCursor,
    },
  })
}

describe('loadEditorSnapshot termination budget', () => {
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

  it('pins the client budget to the server tree capacity', () => {
    // SNAPSHOT_TREE_CAPACITY.maxNodes and a 512 MiB editor ceiling above the
    // 2 MiB snapshot document. A smaller constant would reject a legal tree.
    expect(EDITOR_SNAPSHOT_MAX_NODES).toBe(10_000)
    expect(EDITOR_SNAPSHOT_MAX_PAGES).toBe(10_000)
    expect(EDITOR_SNAPSHOT_MAX_BYTES).toBe(512 * 1024 * 1024)
  })

  it('assembles a 10_000-node tree and does not request a page past it', async () => {
    const pageSize = 200
    let calls = 0
    const mock = installFetchMock((input) => {
      calls += 1
      const cursor = requestCursor(input)
      const pageIndex = cursor === null ? 0 : Number(cursor)
      const start = pageIndex * pageSize
      const count = Math.min(pageSize, EDITOR_SNAPSHOT_MAX_NODES - start)
      const nodes = Array.from({ length: count }, (_, offset) => editorNode(`n-${start + offset}`))
      const hasMore = start + count < EDITOR_SNAPSHOT_MAX_NODES
      return jsonResponse(editorState({
        nodes,
        hasMore,
        nextCursor: hasMore ? String(pageIndex + 1) : null,
      }))
    })
    restoreFetch = mock.restore

    const snap = await loadEditorSnapshot('col-1', { maxRetries: 0, maxSnapshotRestarts: 0 })

    expect(snap.nodes).toHaveLength(EDITOR_SNAPSHOT_MAX_NODES)
    expect(snap.page.hasMore).toBe(false)
    expect(snap.nodes[0]?.id).toBe('n-0')
    expect(snap.nodes.at(-1)?.id).toBe(`n-${EDITOR_SNAPSHOT_MAX_NODES - 1}`)
    expect(calls).toBe(EDITOR_SNAPSHOT_MAX_NODES / pageSize)
  })

  it('stops at the node budget instead of publishing a partial tree', async () => {
    let calls = 0
    const mock = installFetchMock((input) => {
      calls += 1
      const pageIndex = Number(requestCursor(input) ?? '0')
      const start = pageIndex * 200
      return jsonResponse(editorState({
        nodes: Array.from({ length: 200 }, (_, offset) => editorNode(`n-${start + offset}`)),
        hasMore: true,
        nextCursor: String(pageIndex + 1),
      }))
    })
    restoreFetch = mock.restore

    await expect(loadEditorSnapshot('col-1', { maxRetries: 0, maxSnapshotRestarts: 0 }))
      .rejects.toMatchObject({ code: 'payload_too_large' })
    expect(calls).toBe(EDITOR_SNAPSHOT_MAX_NODES / 200)
  })

  it('stops a repeated cursor without a further request', async () => {
    let calls = 0
    const mock = installFetchMock(() => {
      calls += 1
      return jsonResponse(editorState({
        nodes: [editorNode(`n-${calls}`)],
        hasMore: true,
        nextCursor: 'again',
      }))
    })
    restoreFetch = mock.restore

    await expect(loadEditorSnapshot('col-1', { maxRetries: 0, maxSnapshotRestarts: 0 }))
      .rejects.toMatchObject({
        code: 'invalid_cursor',
        message: 'Editor pagination returned a repeated cursor.',
      })
    expect(calls).toBe(2)
  })

  it('stops an empty page that still says hasMore', async () => {
    let calls = 0
    const mock = installFetchMock(() => {
      calls += 1
      if (calls === 1) {
        return jsonResponse(editorState({
          nodes: [editorNode('n-1')],
          hasMore: true,
          nextCursor: 'page-2',
        }))
      }
      return jsonResponse(editorState({ nodes: [], hasMore: true, nextCursor: 'page-3' }))
    })
    restoreFetch = mock.restore

    await expect(loadEditorSnapshot('col-1', { maxRetries: 0, maxSnapshotRestarts: 0 }))
      .rejects.toMatchObject({
        code: 'invalid_cursor',
        message: 'Editor pagination returned an empty page with hasMore set.',
      })
    expect(calls).toBe(2)
  })

  it('stops when a continuation repeats a node id', async () => {
    let calls = 0
    const mock = installFetchMock(() => {
      calls += 1
      return jsonResponse(editorState({
        nodes: [editorNode('same')],
        hasMore: calls === 1,
        nextCursor: calls === 1 ? 'page-2' : null,
      }))
    })
    restoreFetch = mock.restore

    await expect(loadEditorSnapshot('col-1', { maxRetries: 0, maxSnapshotRestarts: 0 }))
      .rejects.toMatchObject({
        code: 'invalid_cursor',
        message: 'Editor pagination returned an overlapping node.',
      })
    expect(calls).toBe(2)
  })

  it('stops when a continuation changes the snapshot', async () => {
    let calls = 0
    const mock = installFetchMock(() => {
      calls += 1
      return jsonResponse(editorState({
        nodes: [editorNode(calls === 1 ? 'n-1' : 'n-2')],
        hasMore: calls === 1,
        nextCursor: calls === 1 ? 'page-2' : null,
        snapshotId: calls === 1 ? 'snap-1' : 'snap-2',
      }))
    })
    restoreFetch = mock.restore

    await expect(loadEditorSnapshot('col-1', { maxRetries: 0, maxSnapshotRestarts: 0 }))
      .rejects.toMatchObject({
        code: 'invalid_cursor',
        message: 'Editor pagination changed snapshot.',
      })
    expect(calls).toBe(2)
  })

  it('rejects an abnormal continuation instead of returning the nodes already read', async () => {
    let calls = 0
    const mock = installFetchMock(() => {
      calls += 1
      return jsonResponse(editorState({
        nodes: [editorNode('partial')],
        hasMore: true,
        nextCursor: null,
      }))
    })
    restoreFetch = mock.restore

    await expect(loadEditorSnapshot('col-1', { maxRetries: 0, maxSnapshotRestarts: 0 }))
      .rejects.toMatchObject({ code: 'invalid_cursor' })
    expect(calls).toBe(1)
  })

  it('stops when the caller aborts and does not keep paging', async () => {
    const controller = new AbortController()
    let calls = 0
    const mock = installFetchMock(() => {
      calls += 1
      controller.abort()
      return jsonResponse(editorState({
        nodes: [editorNode('n-1')],
        hasMore: true,
        nextCursor: 'page-2',
      }))
    })
    restoreFetch = mock.restore

    await expect(loadEditorSnapshot('col-1', {
      signal: controller.signal,
      maxRetries: 0,
      maxSnapshotRestarts: 0,
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(calls).toBe(1)
  })

  it('stops snapshot_expired restarts after the finite restart budget', async () => {
    let calls = 0
    const mock = installFetchMock((input) => {
      calls += 1
      if (requestCursor(input) === null) {
        return jsonResponse(editorState({
          nodes: [editorNode('partial')],
          hasMore: true,
          nextCursor: 'stale',
        }))
      }
      return jsonResponse(productErrorBody({
        code: 'snapshot_expired',
        recovery: 'restart_from_first_page',
      }), { status: 409 })
    })
    restoreFetch = mock.restore

    await expect(loadEditorSnapshot('col-1', { maxRetries: 0, maxSnapshotRestarts: 2 }))
      .rejects.toMatchObject({ code: 'snapshot_expired' })
    // Three walks, each a first page plus the expired continuation.
    expect(calls).toBe(6)
  })

  it('stops when the next page would pass the byte budget', async () => {
    const first = editorState({
      nodes: [editorNode('n-1')],
      hasMore: true,
      nextCursor: 'page-2',
    })
    const firstBytes = new TextEncoder().encode(JSON.stringify(first)).length
    let calls = 0
    const mock = installFetchMock(() => {
      calls += 1
      if (calls === 1) return jsonResponse(first)
      return jsonResponse(editorState({
        nodes: [editorNode('n-2')],
        hasMore: false,
        nextCursor: null,
      }))
    })
    restoreFetch = mock.restore

    await expect(loadEditorSnapshot('col-1', {
      maxRetries: 0,
      maxSnapshotRestarts: 0,
      maxBytes: firstBytes,
    })).rejects.toMatchObject({ code: 'payload_too_large' })
    expect(calls).toBe(2)
  })

  it('stops at an injected page ceiling without a further request', async () => {
    let calls = 0
    const mock = installFetchMock((input) => {
      calls += 1
      const pageIndex = Number(requestCursor(input) ?? '0')
      return jsonResponse(editorState({
        nodes: [editorNode(`n-${pageIndex}`)],
        hasMore: true,
        nextCursor: String(pageIndex + 1),
      }))
    })
    restoreFetch = mock.restore

    await expect(loadEditorSnapshot('col-1', {
      maxRetries: 0,
      maxSnapshotRestarts: 0,
      maxPages: 3,
    })).rejects.toMatchObject({ code: 'payload_too_large' })
    expect(calls).toBe(3)
  })
})
