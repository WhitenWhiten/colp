// @vitest-environment happy-dom
import { act } from 'react'
import { Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, mountTree, waitForDom } from '../test/render'
import { MemberDigestReader } from './MemberDigestReader'
const mock = vi.hoisted(() => ({ auth: { isLoggedIn: true, bootstrapping: false }, series: vi.fn(), issue: vi.fn(), identity: 'account-a', listeners: new Set<() => void>() }))
vi.mock('../auth/AuthContext', () => ({ useAuth: () => mock.auth }))
vi.mock('../api/sessionStore', () => ({ privateSessionIdentity: () => mock.identity, subscribeSession: (callback: () => void) => { mock.listeners.add(callback); return () => mock.listeners.delete(callback) } }))
vi.mock('../api/memberDigestClient', async original => ({ ...await original<typeof import('../api/memberDigestClient')>(), getMemberDigest: mock.series, getMemberDigestIssue: mock.issue }))
const series = { sourceType: 'digest_series', sourceId: 'private-id', title: 'Members only series', owner: null, visibility: 'private' }
const edition = { editionId: 'issue-1', title: 'Members only issue', publishedAt: '2026-09-20T12:00:00Z' }
const mount = (path: string) => mountTree(<Routes><Route path="/library/digests/:id/read" element={<MemberDigestReader />} /><Route path="/library/digests/:id/issues/:editionId/read" element={<MemberDigestReader />} /></Routes>, { route: path })
beforeEach(() => { mock.auth = { isLoggedIn: true, bootstrapping: false }; mock.identity = 'account-a'; mock.series.mockReset().mockResolvedValue({ series, editions: [edition], nextCursor: null }); mock.issue.mockReset().mockResolvedValue({ series, edition, nodes: [{ key: 'bookmark', kind: 'bookmark', role: 'content', title: 'Readable private link', url: 'https://example.com/private' }] }) })
afterEach(() => cleanup())
it('links private editions to the member route without requiring a public slug', async () => {
  mount('/library/digests/private-id/read'); await waitForDom(() => document.body.textContent?.includes('Members only series') === true)
  expect(document.querySelector('a[href="/library/digests/private-id/issues/issue-1/read"]')).not.toBeNull()
  expect(mock.series).toHaveBeenCalledWith('private-id', expect.objectContaining({ signal: expect.any(AbortSignal) }))
  expect(document.querySelector('meta[name=robots]')?.getAttribute('content')).toBe('noindex')
})
it('requests an actual member edition and renders read-only content', async () => {
  mount('/library/digests/private-id/issues/issue-1/read'); await waitForDom(() => document.body.textContent?.includes('Readable private link') === true)
  expect(mock.issue).toHaveBeenCalledWith('private-id','issue-1',expect.any(AbortSignal)); expect(document.querySelector('a[href="https://example.com/private"]')).not.toBeNull(); expect(document.body.textContent).not.toContain('Edit issue')
})
it('preserves member return path for sign-in and does not read before authentication', async () => {
  mock.auth.isLoggedIn = false; mount('/library/digests/private-id/issues/issue-1/read'); await waitForDom(() => document.body.textContent?.includes('Sign in to read this digest') === true)
  expect(document.querySelector('a[href^="/login?returnTo="]')?.getAttribute('href')).toContain(encodeURIComponent('/library/digests/private-id/issues/issue-1/read')); expect(mock.issue).not.toHaveBeenCalled()
})
it('clears private content immediately when the session identity changes', async () => {
  mount('/library/digests/private-id/read'); await waitForDom(() => document.body.textContent?.includes('Members only series') === true)
  mock.series.mockImplementation(() => new Promise(() => undefined)); act(() => { mock.identity = 'account-b'; mock.listeners.forEach(callback => callback()) })
  expect(document.body.textContent).not.toContain('Members only series')
})

it('renders actor-authorized summaries and node annotations without public-reader side effects', async () => {
  const key = JSON.stringify(['digest','private-id','issue-1','source-private','node-1'])
  mock.issue.mockResolvedValue({ series, edition, nodes: [{ key, kind: 'bookmark', role: 'content', title: 'Private reading', url: 'https://example.com/private' }], reader: { seriesSummary: 'Series members context', editionSummary: 'This issue summary', sourceSummary: 'Source introduction', notes: [{ key, description: 'Curated description' }], annotations: [{ id: 'note', subjectType: 'node', subjectId: 'node-1', type: 'note', format: 'markdown', value: '**Personal annotation** <img src=x onerror=alert(1)>' }] } })
  mount('/library/digests/private-id/issues/issue-1/read'); await waitForDom(() => document.body.textContent?.includes('Personal annotation') === true)
  for (const text of ['Series members context','This issue summary','Source introduction','Curated description']) expect(document.body.textContent).toContain(text)
  const annotation = document.querySelector('[data-format="markdown"][data-variant="document"]')
  expect(annotation?.classList.contains('annotation-document')).toBe(true)
  expect(annotation?.querySelector('strong')?.textContent).toBe('Personal annotation'); expect(document.querySelector('[aria-label="Issue entries"] img')).toBeNull()
  expect(document.querySelector('[data-collection-resource-link]')).toBeNull()
})
