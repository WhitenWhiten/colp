import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { subscriptionSessionFetch } from './subscriptionSessionFetch'
const state = vi.hoisted(() => ({ epoch: 'a:1', account: 'acc-opaque-a', email: 'a@example.com' as string | null, authenticated: true }))
vi.mock('./sessionStore', () => ({ privateSessionIdentity: () => state.epoch, getSessionSnapshot: () => ({ authenticated: state.authenticated, me: state.account ? { account: { id: state.account, email: state.email } } : null }) }))
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
// Better Auth user ids never equal the opaque Product account id.
const auth = () => json({ user: { id: 'ba-user-a', email: 'A@example.com' }, session: { id: 'session-a', userId: 'ba-user-a' } })
beforeEach(() => { state.epoch = 'a:1'; state.account = 'acc-opaque-a'; state.email = 'a@example.com'; state.authenticated = true })
afterEach(() => vi.unstubAllGlobals())
it.each([200,204,304])('binds status %s to the exact current session before exposing its body', async status => {
  const fetcher = vi.fn().mockResolvedValueOnce(auth()).mockResolvedValueOnce(new Response(null, { status, headers: { 'Known-Subscription-Session': 'session-a' } }))
  vi.stubGlobal('fetch', fetcher)
  expect((await subscriptionSessionFetch('/private')).status).toBe(status)
  expect(fetcher.mock.calls[0]).toEqual(['/api/v1/auth/get-session', expect.objectContaining({ credentials: 'include', cache: 'no-store', redirect: 'error' })])
})
it.each([undefined,'session-b'])('rejects missing or replacement response sessions, including empty 304', async session => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(auth()).mockResolvedValueOnce(new Response(null, { status: 304, headers: session ? { 'Known-Subscription-Session': session } : {} })))
  await expect(subscriptionSessionFetch('/private')).rejects.toMatchObject({ status: 401 })
})
it('does not issue private requests when cookies belong to another user despite an unchanged epoch', async () => {
  const fetcher = vi.fn(async () => json({ user: { id: 'ba-user-b', email: 'b@example.com' }, session: { id: 'session-b', userId: 'ba-user-b' } })); vi.stubGlobal('fetch', fetcher)
  await expect(subscriptionSessionFetch('/private')).rejects.toMatchObject({ status: 401 }); expect(fetcher).toHaveBeenCalledTimes(1)
})
it('fences actor and epoch after auth retrieval and before issuing private requests', async () => {
  const fetcher = vi.fn(async () => { state.epoch = 'a:2'; return auth() }); vi.stubGlobal('fetch', fetcher)
  await expect(subscriptionSessionFetch('/private')).rejects.toMatchObject({ status: 401 }); expect(fetcher).toHaveBeenCalledTimes(1)
})
it('fails closed before fetching until the Product actor is hydrated', async () => {
  state.account = ''; const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
  await expect(subscriptionSessionFetch('/private')).rejects.toMatchObject({ status: 401 }); expect(fetcher).not.toHaveBeenCalled()
})
it('pins the Better Auth user per account when the account has no email', async () => {
  state.account = 'acc-no-email'; state.email = null
  const ok = () => new Response(null, { status: 204, headers: { 'Known-Subscription-Session': 'session-n' } })
  const user = (id: string) => json({ user: { id }, session: { id: 'session-n', userId: id } })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(user('ba-user-n')).mockResolvedValueOnce(ok()))
  expect((await subscriptionSessionFetch('/private')).status).toBe(204)
  const fetcher = vi.fn().mockResolvedValueOnce(user('ba-user-other')); vi.stubGlobal('fetch', fetcher)
  await expect(subscriptionSessionFetch('/private')).rejects.toMatchObject({ status: 401 }); expect(fetcher).toHaveBeenCalledTimes(1)
})
