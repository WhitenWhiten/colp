import type { ProductTransportHttp } from './product-transport-http'
import type { MutationCallOptions, SessionCallOptions } from './product-transport-types'
import type { MeView, SessionView, UpdateMeRequest } from './types'
import { badResponse } from './json-request'

/* A static host/SPA fallback can answer a missing API route with the app's
   index.html at status 200. Session and /me are the identity boundary, so an
   HTML body must fail as a bad response instead of being cast to
   `{ authenticated: undefined }` and clearing the in-memory session. */
const sessionJson = () => badResponse('The session response was not valid JSON.')
const meJson = () => badResponse('The account response was not valid JSON.')
/* Text decoding plus strictJson only prove the 2xx carried JSON. An empty
   body or valid JSON of the wrong shape would still be applied as a signed-out
   session / empty profile, so the envelope itself is checked here, before the
   caller can write it to the session store. */
const sessionShape = () => badResponse('The session response did not match the session contract.')
const meShape = () => badResponse('The account response did not match the account contract.')

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSessionView(value: unknown): value is SessionView {
  if (!isRecord(value) || typeof value.authenticated !== 'boolean') return false
  if (!value.authenticated) {
    return value.verificationRequired === undefined || typeof value.verificationRequired === 'boolean'
  }
  return typeof value.csrfToken === 'string'
    && value.csrfToken !== ''
    && (value.idleExpiresAt === undefined || typeof value.idleExpiresAt === 'string')
    && (value.absoluteExpiresAt === undefined || typeof value.absoluteExpiresAt === 'string')
}

function isMeView(value: unknown): value is MeView {
  if (!isRecord(value)) return false
  const account = value.account
  const profile = value.profile
  return isRecord(account)
    && typeof account.id === 'string'
    && account.id !== ''
    && (account.email === null || typeof account.email === 'string')
    && (account.username === undefined || account.username === null || typeof account.username === 'string')
    && isRecord(profile)
    && typeof profile.id === 'string'
    && profile.id !== ''
    && typeof profile.handle === 'string'
    && typeof profile.displayName === 'string'
    && (profile.avatarUrl === null || typeof profile.avatarUrl === 'string')
    && (profile.about === undefined || typeof profile.about === 'string')
}

export function createSessionTransport(http: ProductTransportHttp) {
  const { request, mutationHeaders, origin } = http
  return {
    async getSession(opts?: SessionCallOptions) {
      const view = await request<unknown>({
        method: 'GET',
        path: '/api/v1/session',
        credentials: 'include',
        signal: opts?.signal,
        strictJson: sessionJson,
      })
      if (!isSessionView(view)) throw sessionShape()
      return view
    },

    async getMe(opts?: SessionCallOptions) {
      const view = await request<unknown>({
        method: 'GET',
        path: '/api/v1/me',
        credentials: 'include',
        signal: opts?.signal,
        strictJson: meJson,
      })
      if (!isMeView(view)) throw meShape()
      return view
    },

    async deleteSession(opts: { csrfToken: string; signal?: AbortSignal }) {
      const headers: Record<string, string> = {
        'X-CSRF-Token': opts.csrfToken,
      }
      if (origin) headers.Origin = origin
      await request<void>({
        method: 'DELETE',
        path: '/api/v1/session',
        headers,
        signal: opts.signal,
        emptyOk: true,
      })
    },

    async updateMe(body: UpdateMeRequest, opts: MutationCallOptions) {
      const view = await request<unknown>({
        method: 'PATCH',
        path: '/api/v1/me',
        headers: mutationHeaders(opts),
        body,
        contentType: 'application/json',
        signal: opts.signal,
        strictJson: meJson,
      })
      if (!isMeView(view)) throw meShape()
      return view
    },

    async uploadAvatar(file: File, opts: MutationCallOptions) {
      const view = await request<unknown>({
        method: 'POST',
        path: '/api/v1/me/avatar',
        headers: mutationHeaders(opts, { 'Content-Type': file.type || 'application/octet-stream' }),
        rawBody: file,
        signal: opts.signal,
        strictJson: meJson,
      })
      if (!isMeView(view)) throw meShape()
      return view
    },
  }
}
