import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getMemberDigest, getMemberDigestIssue, getSharedMemberDigests } from './memberDigestClient'
const state = vi.hoisted(() => ({ identity: 'a:1', authenticated: true }))
vi.mock('./sessionStore', () => ({ getSessionSnapshot: () => ({ authenticated: state.authenticated, me: { account: { id: 'acc-opaque-a', email: 'a@example.com' } } }), privateSessionIdentity: () => state.identity }))
const series = { sourceType: 'digest_series', sourceId: 'private-series', title: 'Private title', owner: null, openUrl: '/library/digests/private-series/read', visibility: 'private' }
const edition = { editionId: 'issue-one', title: 'Private issue', publishedAt: '2026-09-20T12:00:00Z' }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'Known-Subscription-Session': 'session-a' } })
function install(fetcher: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => String(input).endsWith('/api/v1/auth/get-session') ? json({ user: { id: 'seed-auser-a', email: 'a@example.com' }, session: { id: 'session-a', userId: 'seed-auser-a' } }) : fetcher(input, init))
}
beforeEach(() => { state.identity = 'a:1'; state.authenticated = true })
afterEach(() => vi.unstubAllGlobals())
describe('member Digest reader API', () => {
  it('reads real member series and edition endpoints with private no-store transport', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ series, editions: [edition], nextCursor: null })).mockResolvedValueOnce(json({ series, edition, nodes: [{ key: 'root', parentKey: null, index: 0, kind: 'folder', role: 'root', title: 'Issue' }, { key: 'b', parentKey: 'root', index: 0, kind: 'bookmark', role: 'content', title: 'Link', url: 'https://example.com/' }] }))
    install(fetch)
    expect((await getMemberDigest('private-series')).editions).toEqual([edition])
    expect((await getMemberDigestIssue('private-series','issue-one')).nodes).toHaveLength(2)
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/v1/me/report-readers/private-series')
    expect(fetch.mock.calls[1]?.[0]).toBe('/api/v1/me/report-readers/private-series/editions/issue-one')
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ credentials: 'include', cache: 'no-store', redirect: 'error' })
  })
  it('reads shared digests as empty while the gated sources listing answers 404', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL) => json({ error: { code: 'resource_not_found' } }, 404)); install(fetch)
    await expect(getSharedMemberDigests()).resolves.toEqual({ items: [], nextCursor: null })
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/v1/me/bookmark-subscription-sources?sourceType=digest_series&relation=shared')
  })
  it('rejects response arrival after account change and never fetches anonymously', async () => {
    const fetch = vi.fn(async () => { state.identity = 'b:2'; return json({ series, editions: [edition], nextCursor: null }) }); install(fetch)
    await expect(getMemberDigest('private-series')).rejects.toMatchObject({ status: 401 })
    state.authenticated = false; await expect(getMemberDigest('private-series')).rejects.toMatchObject({ status: 401 }); expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('does not fall back to public collection URLs on membership or source denial', async () => {
    const fetch = vi.fn(async () => json({},404)); install(fetch)
    await expect(getMemberDigestIssue('private-series','issue-one')).rejects.toMatchObject({ status: 404 }); expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('rejects wrong identities, unsafe links and incomplete trees', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ series: { ...series, sourceId: 'different' }, editions: [], nextCursor: null })).mockResolvedValueOnce(json({ series, edition, nodes: [{ key: 'n', parentKey: null, kind: 'bookmark', title: 'bad', url: 'javascript:alert(1)' }] })).mockResolvedValueOnce(json({ series, edition, nodes: [{ key: 'n', parentKey: 'missing', kind: 'folder', title: 'broken' }] })); install(fetch)
    await expect(getMemberDigest('private-series')).rejects.toMatchObject({ status: 502 }); await expect(getMemberDigestIssue('private-series','issue-one')).rejects.toMatchObject({ status: 502 }); await expect(getMemberDigestIssue('private-series','issue-one')).rejects.toMatchObject({ status: 502 })
  })
})

it('accepts authorized reader metadata and rejects annotations attached to unreadable node identities', async () => {
  const key = JSON.stringify(['digest','private-series','issue-one','source-private','node-1'])
  const payload = { series, edition, nodes: [{ key, parentKey: null, kind: 'bookmark', role: 'content', title: 'Private', url: 'https://example.com/' }], reader: { seriesSummary: null, editionSummary: 'Issue summary', sourceSummary: null, notes: [{ key, description: 'Readable description' }], annotations: [{ id: 'note-1', subjectType: 'node', subjectId: 'node-1', type: 'note', format: 'plain', value: 'Authorized note' }] } }
  const fetcher = vi.fn().mockResolvedValueOnce(json(payload)).mockResolvedValueOnce(json({ ...payload, reader: { ...payload.reader, annotations: [{ ...payload.reader.annotations[0], subjectId: 'hidden-node' }] } })); install(fetcher)
  expect((await getMemberDigestIssue('private-series','issue-one')).reader?.notes).toEqual(payload.reader.notes)
  await expect(getMemberDigestIssue('private-series','issue-one')).rejects.toMatchObject({ status: 502 })
})
