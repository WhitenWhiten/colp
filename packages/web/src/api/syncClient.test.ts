import { seedAuthenticatedSession, resetProductSession } from './test-helpers'
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProductTransport } from './product-transport'
import { clearCommandId } from './command-intent'
import { loadSyncConflictPages, loadSyncTrashPages } from './productClient'
import type { SyncConflictPage, SyncConflictSummary, SyncTrashListItem, SyncTrashPage } from './types'

const intent = 'sync-conflict:conflict-1:intent-1'

describe('Product Sync transport and command intent', () => {
  afterEach(() => resetProductSession())
  beforeEach(() => {
    seedAuthenticatedSession('csrf-sync-read')
    sessionStorage.clear()
    clearCommandId(intent)
  })

  it('pages with generated query semantics and credentials included', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      items: [], page: { nextCursor: null },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const transport = createProductTransport({ baseUrl: 'https://api.example.test', fetchImpl })

    await transport.listSyncConflicts({ limit: 25, cursor: 'opaque cursor' })

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.example.test/api/v1/sync/conflicts?cursor=opaque+cursor',
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    )
  })

  it('assembles every generated Conflict page and rejects an overlapping item', async () => {
    const item = (id: string): SyncConflictSummary => ({
      id, collectionId: 'collection-1', targetId: `node-${id}`, type: 'concurrent_field_update',
      field: '/title', status: 'open', allowedResolutions: ['server', 'incoming'], revision: `r-${id}`,
      etag: `"r-${id}"`, createdAt: '2026-07-28T00:00:00.000Z', summary: { current: id, incoming: null },
    })
    const pages: SyncConflictPage[] = [
      { items: [item('one')], page: { nextCursor: 'cursor-2' } },
      { items: [item('two')], page: { nextCursor: null } },
    ]
    const readPage = vi.fn().mockResolvedValueOnce(pages[0]).mockResolvedValueOnce(pages[1])

    await expect(loadSyncConflictPages(readPage, 25)).resolves.toEqual([pages[0]!.items[0], pages[1]!.items[0]])
    expect(readPage).toHaveBeenNthCalledWith(1, { limit: 25 })
    expect(readPage).toHaveBeenNthCalledWith(2, { cursor: 'cursor-2' })

    const overlap = vi.fn()
      .mockResolvedValueOnce({ items: [item('same')], page: { nextCursor: 'again' } })
      .mockResolvedValueOnce({ items: [item('same')], page: { nextCursor: null } })
    await expect(loadSyncConflictPages(overlap, 25)).rejects.toMatchObject({ code: 'invalid_cursor' })
  })

  it('sends a strong If-Match and reuses Known-Command-Id for the exact resolution replay', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({
      conflictId: 'conflict-1', status: 'resolved', revision: 'r2', etag: '"r2"',
      resolvedAt: '2026-07-28T00:00:00.000Z',
    }), { status: 200, headers: { 'content-type': 'application/json', etag: '"r2"' } }))
    const transport = createProductTransport({ baseUrl: 'https://api.example.test', fetchImpl })
    const options = { commandIntentId: intent, csrfToken: 'csrf-token', ifMatch: '"r1"' }

    await transport.resolveSyncConflict('conflict-1', { resolution: 'incoming' }, options)
    await transport.resolveSyncConflict('conflict-1', { resolution: 'incoming' }, options)

    const calls = fetchImpl.mock.calls
    const first = calls[0]?.[1]?.headers as Headers
    const replay = calls[1]?.[1]?.headers as Headers
    expect(first.get('If-Match')).toBe('"r1"')
    expect(first.get('Known-Command-Id')).toMatch(/^[0-9a-f-]{36}$/u)
    expect(replay.get('Known-Command-Id')).toBe(first.get('Known-Command-Id'))
    expect(calls[0]?.[1]?.body).toBe(JSON.stringify({ resolution: 'incoming' }))
  })

  it('fails closed on empty and looping Conflict continuations', async () => {
    const empty = vi.fn().mockResolvedValue({ items: [], page: { nextCursor: '' } })
    await expect(loadSyncConflictPages(empty, 25)).rejects.toMatchObject({ code: 'invalid_cursor' })

    const loop = vi.fn()
      .mockResolvedValueOnce({ items: [], page: { nextCursor: 'same-cursor' } })
      .mockResolvedValueOnce({ items: [], page: { nextCursor: 'same-cursor' } })
    await expect(loadSyncConflictPages(loop, 25)).rejects.toMatchObject({ code: 'invalid_cursor' })
  })

  it('keeps malicious summaries out of the resolution request and maps Product errors', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      error: { code: 'precondition_failed', message: 'changed', recovery: 'refresh_and_retry',
        sameRequestRetrySafe: false, precondition: 'resource' },
    }), { status: 412, headers: { 'content-type': 'application/json' } }))
    const transport = createProductTransport({ baseUrl: 'https://api.example.test', fetchImpl })

    await expect(transport.resolveSyncConflict(
      'conflict-1', { resolution: 'custom', value: '<img src=x onerror=alert(1)>' },
      { commandIntentId: intent, csrfToken: 'csrf-token', ifMatch: '"r1"' },
    )).rejects.toMatchObject({ status: 412, code: 'precondition_failed', recovery: 'refresh_and_retry' })
  })

  it('sends a strong If-Match and reuses Known-Command-Id for replica retirement replay', async () => {
    const retireIntent = 'sync-retire:replica-1:intent-1'
    clearCommandId(retireIntent)
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({
      replicaId: 'replica-1', status: 'retired', lifecycleRevision: '5', etag: '"5"',
      retiredAt: '2026-07-28T00:00:00.000Z',
    }), { status: 200, headers: { 'content-type': 'application/json', etag: '"5"' } }))
    const transport = createProductTransport({ baseUrl: 'https://api.example.test', fetchImpl })
    const options = { commandIntentId: retireIntent, csrfToken: 'csrf-token', ifMatch: '"4"' }

    await transport.retireSyncReplica('replica-1', options)
    await transport.retireSyncReplica('replica-1', options)

    const calls = fetchImpl.mock.calls
    const first = calls[0]?.[1]?.headers as Headers
    const replay = calls[1]?.[1]?.headers as Headers
    expect(String(calls[0]?.[0])).toContain('/api/v1/sync/replicas/replica-1')
    expect(calls[0]?.[1]).toEqual(expect.objectContaining({ method: 'DELETE', credentials: 'include' }))
    expect(first.get('If-Match')).toBe('"4"')
    expect(first.get('Known-Command-Id')).toMatch(/^[0-9a-f-]{36}$/u)
    expect(replay.get('Known-Command-Id')).toBe(first.get('Known-Command-Id'))
    expect(replay.get('If-Match')).toBe('"4"')
    expect(calls[0]?.[1]?.body).toBeUndefined()
  })

  it('lists trash with collectionId and omits limit when a cursor is present', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({
      items: [], page: { nextCursor: null },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const transport = createProductTransport({ baseUrl: 'https://api.example.test', fetchImpl })

    await transport.listSyncTrash({ collectionId: 'collection-1', limit: 20 })
    await transport.listSyncTrash({ collectionId: 'collection-1', cursor: 'opaque trash cursor' })

    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe('https://api.example.test/api/v1/sync/trash?collectionId=collection-1&limit=20')
    expect(String(fetchImpl.mock.calls[1]?.[0])).toBe('https://api.example.test/api/v1/sync/trash?collectionId=collection-1&cursor=opaque+trash+cursor')
    expect(String(fetchImpl.mock.calls[1]?.[0])).not.toContain('limit=')
    expect(fetchImpl.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ method: 'GET', credentials: 'include' }))
  })

  it('assembles trash pages and rejects overlapping deletion ids', async () => {
    const item = (deletionId: string): SyncTrashListItem => ({
      deletionId, nodeId: `node-${deletionId}`, kind: 'bookmark', title: 'Fixture reading list',
      originalParentId: 'folder-fixture', originalParentTitle: 'Fixture folder',
      deletedAt: '2026-07-28T00:00:00.000Z', purgeAfter: '2026-08-27T00:00:00.000Z', revision: 'delete-r1',
    })
    const pages: SyncTrashPage[] = [
      { items: [item('one')], page: { nextCursor: 'cursor-2' } },
      { items: [item('two')], page: { nextCursor: null } },
    ]
    const readPage = vi.fn().mockResolvedValueOnce(pages[0]).mockResolvedValueOnce(pages[1])
    await expect(loadSyncTrashPages(readPage, 20)).resolves.toEqual([pages[0]!.items[0], pages[1]!.items[0]])
    expect(readPage).toHaveBeenNthCalledWith(1, { limit: 20 })
    expect(readPage).toHaveBeenNthCalledWith(2, { cursor: 'cursor-2' })

    const overlap = vi.fn()
      .mockResolvedValueOnce({ items: [item('same')], page: { nextCursor: 'again' } })
      .mockResolvedValueOnce({ items: [item('same')], page: { nextCursor: null } })
    await expect(loadSyncTrashPages(overlap, 20)).rejects.toMatchObject({ code: 'invalid_cursor' })
  })

  it('sends a strong If-Match and reuses Known-Command-Id for trash restore replay', async () => {
    const restoreIntent = 'sync-trash-restore:deletion-fixture-1:intent-1'
    clearCommandId(restoreIntent)
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({
      deletionId: 'deletion-fixture-1', nodeId: 'node-fixture', parentId: 'folder-fixture',
      revision: 'restored-r2', etag: '"restored-r2"', restoredAt: '2026-07-28T01:00:00.000Z',
    }), { status: 200, headers: { 'content-type': 'application/json', etag: '"restored-r2"' } }))
    const transport = createProductTransport({ baseUrl: 'https://api.example.test', fetchImpl })
    const options = { commandIntentId: restoreIntent, csrfToken: 'csrf-token', ifMatch: '"delete-r1"' }

    await transport.restoreSyncTrashItem('deletion-fixture-1', options)
    await transport.restoreSyncTrashItem('deletion-fixture-1', options)

    const calls = fetchImpl.mock.calls
    const first = calls[0]?.[1]?.headers as Headers
    const replay = calls[1]?.[1]?.headers as Headers
    expect(String(calls[0]?.[0])).toContain('/api/v1/sync/trash/deletion-fixture-1/restore')
    expect(calls[0]?.[1]).toEqual(expect.objectContaining({ method: 'POST', credentials: 'include' }))
    expect(first.get('If-Match')).toBe('"delete-r1"')
    expect(first.get('Known-Command-Id')).toMatch(/^[0-9a-f-]{36}$/u)
    expect(replay.get('Known-Command-Id')).toBe(first.get('Known-Command-Id'))
    expect(calls[0]?.[1]?.body).toBeUndefined()
  })

  it('sends one batch restore body and reuses Known-Command-Id on replay', async () => {
    const intent = 'sync-trash-restore-batch:collection-1:intent-1'
    clearCommandId(intent)
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({
      collectionId: 'collection-1', results: [],
      summary: { applied: 0, preconditionFailed: 0, purged: 0, notFound: 0 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const transport = createProductTransport({ baseUrl: 'https://api.example.test', fetchImpl })
    const body = { collectionId: 'collection-1', items: [
      { deletionId: 'deletion-fixture-1', expectedRevision: 'delete-r1' },
    ] }
    const options = { commandIntentId: intent, csrfToken: 'csrf-token' }
    await transport.restoreSyncTrashBatch(body, options)
    await transport.restoreSyncTrashBatch(body, options)
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe('https://api.example.test/api/v1/sync/trash/restore-batch')
    expect(fetchImpl.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(body))
    const first = fetchImpl.mock.calls[0]?.[1]?.headers as Headers
    const replay = fetchImpl.mock.calls[1]?.[1]?.headers as Headers
    expect(replay.get('Known-Command-Id')).toBe(first.get('Known-Command-Id'))
  })
})
