import { afterEach, expect, test } from 'vitest'
import { productClient } from './productClient'
import type { EditorSnapshot } from './types'
import { editorPageBody, installFetchMock, jsonResponse, productErrorBody, resetProductSession } from './test-helpers'

let restore: (() => void) | undefined
afterEach(() => { restore?.(); resetProductSession() })
const cached = () => ({ ...editorPageBody(), readRevision: 'read-v1' }) as unknown as EditorSnapshot

test('an unchanged whole-tree revision reuses the complete snapshot with a single HEAD', async () => {
  const snapshot = cached()
  const mock = installFetchMock((_input, init) => {
    expect(init?.method).toBe('HEAD')
    return new Response(null, { status: 200, headers: { 'Known-Editor-Revision': 'read-v1' } })
  })
  restore = mock.restore
  expect(await productClient.loadEditorSnapshot('col-1', { cachedSnapshot: snapshot, maxRetries: 0 })).toBe(snapshot)
  expect(mock.calls).toHaveLength(1)
})

test('a changed revision loads every page and retains the new first-page validator', async () => {
  const mock = installFetchMock((input, init) => {
    if (init?.method === 'HEAD') return new Response(null, { headers: { 'Known-Editor-Revision': 'read-v2' } })
    const url = new URL(String(input), 'http://localhost')
    const last = url.searchParams.has('cursor')
    const body = editorPageBody()
    return jsonResponse({ ...body, nodes: [{ id: last ? 'second' : 'first' }],
      page: { ...body.page, returnedCount: 1, hasMore: !last, nextCursor: last ? null : 'next-page' },
    }, { headers: last ? {} : { 'Known-Editor-Revision': 'read-v2' } })
  })
  restore = mock.restore
  const next = await productClient.loadEditorSnapshot('col-1', { cachedSnapshot: cached(), maxRetries: 0 })
  expect(next.nodes.map(node => node.id)).toEqual(['first', 'second'])
  expect(next.readRevision).toBe('read-v2')
  expect(mock.calls).toHaveLength(3)
})

test('old servers without a version header fall back to a full snapshot', async () => {
  const mock = installFetchMock((_input, init) => init?.method === 'HEAD'
    ? new Response(null) : jsonResponse(editorPageBody()))
  restore = mock.restore
  const next = await productClient.loadEditorSnapshot('col-1', { cachedSnapshot: cached(), maxRetries: 0 })
  expect(next.readRevision).toBeUndefined()
  expect(mock.calls).toHaveLength(2)
})

test('a denied version probe cannot bless the cached private snapshot', async () => {
  const mock = installFetchMock(() => jsonResponse(productErrorBody({ code: 'resource_not_found' }), { status: 404 }))
  restore = mock.restore
  await expect(productClient.loadEditorSnapshot('col-1', { cachedSnapshot: cached(), maxRetries: 0 })).rejects.toMatchObject({ status: 404 })
  expect(mock.calls).toHaveLength(1)
})
