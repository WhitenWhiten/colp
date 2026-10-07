import type { ProductTransportHttp } from './product-transport-http'
import type { MutationCallOptions, SessionCallOptions } from './product-transport-types'
import type { MeView, SessionView, UpdateMeRequest } from './types'

export function createSessionTransport(http: ProductTransportHttp) {
  const { request, mutationHeaders, origin } = http

  return {
    async getSession(opts?: SessionCallOptions) {
      return request<SessionView>({
        method: 'GET',
        path: '/api/v1/session',
        credentials: 'include',
        signal: opts?.signal,
      })
    },

    async getMe(opts?: SessionCallOptions) {
      return request<MeView>({
        method: 'GET',
        path: '/api/v1/me',
        credentials: 'include',
        signal: opts?.signal,
      })
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
      return request<MeView>({
        method: 'PATCH',
        path: '/api/v1/me',
        headers: mutationHeaders(opts),
        body,
        contentType: 'application/json',
        signal: opts.signal,
      })
    },

    async uploadAvatar(file: File, opts: MutationCallOptions) {
      return request<MeView>({
        method: 'POST',
        path: '/api/v1/me/avatar',
        headers: mutationHeaders(opts, { 'Content-Type': file.type || 'application/octet-stream' }),
        rawBody: file,
        signal: opts.signal,
      })
    },
  }
}
